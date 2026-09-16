import { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';

export type RpcTaskPriority = 'HIGH' | 'NORMAL' | 'LOW';

export interface RpcTaskOptions {
  actionName: string;
  priority?: RpcTaskPriority;
  traderWalletAddress?: string;
  traderName?: string;
  signature?: string;
}

export interface InternalRpcTask<T = any> {
  id: string;
  actionName: string;
  execute: (conn: Connection) => Promise<T>;
  priority: RpcTaskPriority;
  traderWalletAddress: string;
  traderName?: string;
  signature?: string;
  enqueuedAt: number;
  retries: number;
  nextAttemptAt: number;
  lastError?: string;
  resolve: (val: T) => void;
  reject: (err: any) => void;
}

export interface RpcQueueMetrics {
  rpcRequests: number;
  rpcSuccess: number;
  rpc429: number;
  rpcErrors: number;
  rpcRetries: number;
  rpcQueueDepth: number;
  rpcActiveRequests: number;
  rpcCircuitOpen: boolean;
  transactionQueueDepth?: number;
  queuedCount: number;
  activeWorkers: number;
  completedCount: number;
  retriesCount: number;
  rateLimit429Count: number;
  failedPermanentlyCount: number;
  avgFetchLatencyMs: number;
  oldestQueuedAgeMs: number;
  circuitBreakerActive: boolean;
  requestsLastSecond: number;
  completedLastMinute: number;
  failedLastMinute: number;
}

export class SolanaRpcQueue {
  private static instance: SolanaRpcQueue | null = null;
  private connectionSupplier: () => Connection | null;

  // Environment-configurable settings
  private concurrency: number;
  private maxRequestsPerSecond: number;
  private maxRetries: number;
  private backoffBaseMs: number;
  private backoffMaxMs: number;

  // Task queue & state
  private queuedTasks: InternalRpcTask[] = [];
  private activeWorkers = 0;
  private activeRequestsPerTrader: Map<string, number> = new Map();

  // Circuit breaker & rate limiting
  private requestTimestamps: number[] = [];
  private consecutive429Count = 0;
  private circuitBreakerUntil = 0;
  private circuitBreakerTimer: NodeJS.Timeout | null = null;

  // Rolling metrics counters
  private totalRequests = 0;
  private totalCompleted = 0;
  private totalRetries = 0;
  private total429Count = 0;
  private totalFailedPermanently = 0;
  private latencies: number[] = [];
  private completedTimestamps: number[] = [];
  private failedTimestamps: number[] = [];

  private constructor(connectionSupplier: () => Connection | null) {
    this.connectionSupplier = connectionSupplier;

    this.concurrency = parseInt(process.env.RPC_MAX_CONCURRENCY || '3', 10);
    this.maxRequestsPerSecond = parseInt(process.env.RPC_MAX_REQUESTS_PER_SECOND || '5', 10);
    this.maxRetries = parseInt(process.env.RPC_MAX_RETRIES || '5', 10);
    this.backoffBaseMs = parseInt(process.env.RPC_BACKOFF_BASE_MS || '500', 10);
    this.backoffMaxMs = parseInt(process.env.RPC_BACKOFF_MAX_MS || '10000', 10);

    // Periodic cleanup loop for old timestamp counters
    setInterval(() => this.pruneTimestamps(), 10000);
  }

  public static getInstance(connectionSupplier?: () => Connection | null): SolanaRpcQueue {
    if (!SolanaRpcQueue.instance) {
      if (!connectionSupplier) {
        throw new Error('[SolanaRpcQueue] Initial call to getInstance must provide connectionSupplier');
      }
      SolanaRpcQueue.instance = new SolanaRpcQueue(connectionSupplier);
    }
    return SolanaRpcQueue.instance;
  }

  /**
   * Enqueues an arbitrary RPC operation with rate limiting, concurrency limits, 429 retry backoff, and fair wallet scheduling.
   */
  public enqueue<T>(
    execute: (conn: Connection) => Promise<T>,
    options: RpcTaskOptions
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Bounded backpressure: prevent unbounded memory consumption
      if (this.queuedTasks.length >= 500) {
        reject(new Error('RPC_QUEUE_OVERFLOW: Queue depth exceeded limit of 500.'));
        return;
      }

      const id = 'rpc_' + Math.random().toString(36).substring(2, 11);
      const now = Date.now();
      const traderWalletAddress = options.traderWalletAddress ? options.traderWalletAddress.trim() : 'GLOBAL';

      const task: InternalRpcTask<T> = {
        id,
        actionName: options.actionName,
        execute,
        priority: options.priority || 'NORMAL',
        traderWalletAddress,
        traderName: options.traderName,
        signature: options.signature,
        enqueuedAt: now,
        retries: 0,
        nextAttemptAt: now,
        resolve,
        reject
      };

      this.queuedTasks.push(task);
      this.triggerWorkerPool();
    });
  }

  /**
   * Helper method to fetch parsed transaction with failover and queueing.
   */
  public async getParsedTransaction(
    signature: string,
    options: any = { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    priority: RpcTaskPriority = 'HIGH',
    traderWalletAddress?: string,
    traderName?: string
  ): Promise<ParsedTransactionWithMeta | null> {
    return this.enqueue(
      async (conn) => {
        try {
          return await conn.getParsedTransaction(signature, options);
        } catch (verErr: any) {
          // Fallback to version 1 if maxSupportedTransactionVersion 0 fails
          if (options.maxSupportedTransactionVersion === 0) {
            return await conn.getParsedTransaction(signature, {
              ...options,
              maxSupportedTransactionVersion: 1
            });
          }
          throw verErr;
        }
      },
      {
        actionName: 'getParsedTransaction',
        priority,
        traderWalletAddress,
        traderName,
        signature
      }
    );
  }

  /**
   * Helper method to fetch account info with rate limiting.
   */
  public async getParsedAccountInfo(
    pubkey: PublicKey,
    priority: RpcTaskPriority = 'NORMAL'
  ): Promise<any> {
    return this.enqueue(
      async (conn) => await conn.getParsedAccountInfo(pubkey),
      {
        actionName: 'getParsedAccountInfo',
        priority
      }
    );
  }

  /**
   * Helper method to fetch token accounts by owner with rate limiting.
   */
  public async getParsedTokenAccountsByOwner(
    owner: PublicKey,
    filter: any,
    priority: RpcTaskPriority = 'NORMAL'
  ): Promise<any> {
    return this.enqueue(
      async (conn) => await conn.getParsedTokenAccountsByOwner(owner, filter),
      {
        actionName: 'getParsedTokenAccountsByOwner',
        priority
      }
    );
  }

  public async sendRawTransaction(
    rawTransaction: Buffer | Uint8Array,
    options?: any,
    priority: RpcTaskPriority = 'HIGH'
  ): Promise<string> {
    return this.enqueue(
      async (conn) => await conn.sendRawTransaction(rawTransaction, options),
      {
        actionName: 'sendRawTransaction',
        priority
      }
    );
  }

  public async confirmTransaction(
    strategy: any,
    commitment?: any,
    priority: RpcTaskPriority = 'HIGH'
  ): Promise<any> {
    return this.enqueue(
      async (conn) => await conn.confirmTransaction(strategy, commitment),
      {
        actionName: 'confirmTransaction',
        priority
      }
    );
  }

  public async getBalance(
    publicKey: PublicKey,
    commitment?: any,
    priority: RpcTaskPriority = 'NORMAL'
  ): Promise<number> {
    return this.enqueue(
      async (conn) => await conn.getBalance(publicKey, commitment),
      {
        actionName: 'getBalance',
        priority
      }
    );
  }

  public async getLatestBlockhash(
    commitment?: any,
    priority: RpcTaskPriority = 'HIGH'
  ): Promise<any> {
    return this.enqueue(
      async (conn) => await conn.getLatestBlockhash(commitment),
      {
        actionName: 'getLatestBlockhash',
        priority
      }
    );
  }

  /**
   * Main scheduling worker loop.
   */
  private triggerWorkerPool(): void {
    const now = Date.now();

    // Respect circuit breaker with automatic scheduled wakeup
    if (now < this.circuitBreakerUntil) {
      const waitMs = this.circuitBreakerUntil - now;
      if (!this.circuitBreakerTimer) {
        this.circuitBreakerTimer = setTimeout(() => {
          this.circuitBreakerTimer = null;
          this.triggerWorkerPool();
        }, waitMs + 25);
      }
      return;
    }

    // Half-open probe state: If recovering from 429s, allow only 1 concurrent probe request
    const effectiveConcurrency = this.consecutive429Count > 0 ? 1 : this.concurrency;

    while (this.activeWorkers < effectiveConcurrency && this.queuedTasks.length > 0) {
      if (!this.canMakeRpcRequest()) {
        break;
      }

      // Find all ready tasks where nextAttemptAt <= now
      const readyIndices: number[] = [];
      for (let i = 0; i < this.queuedTasks.length; i++) {
        if (this.queuedTasks[i].nextAttemptAt <= now) {
          readyIndices.push(i);
        }
      }

      if (readyIndices.length === 0) {
        break;
      }

      // Fair wallet scheduling: Select candidate task from trader wallet with fewest active requests
      let selectedIndex = readyIndices[0];
      let lowestTraderActiveCount = Infinity;
      let highestPriorityValue = -1;

      const priorityMap: Record<RpcTaskPriority, number> = {
        HIGH: 3,
        NORMAL: 2,
        LOW: 1
      };

      for (const idx of readyIndices) {
        const candidate = this.queuedTasks[idx];
        const traderActiveCount = this.activeRequestsPerTrader.get(candidate.traderWalletAddress) || 0;
        const priorityVal = priorityMap[candidate.priority] || 2;

        if (
          traderActiveCount < lowestTraderActiveCount ||
          (traderActiveCount === lowestTraderActiveCount && priorityVal > highestPriorityValue)
        ) {
          lowestTraderActiveCount = traderActiveCount;
          highestPriorityValue = priorityVal;
          selectedIndex = idx;
        }
      }

      const task = this.queuedTasks.splice(selectedIndex, 1)[0];
      if (!task) break;

      this.activeWorkers++;
      const currentCount = this.activeRequestsPerTrader.get(task.traderWalletAddress) || 0;
      this.activeRequestsPerTrader.set(task.traderWalletAddress, currentCount + 1);

      this.recordRpcRequest();

      this.processTask(task).finally(() => {
        this.activeWorkers--;
        const c = this.activeRequestsPerTrader.get(task.traderWalletAddress) || 1;
        if (c <= 1) {
          this.activeRequestsPerTrader.delete(task.traderWalletAddress);
        } else {
          this.activeRequestsPerTrader.set(task.traderWalletAddress, c - 1);
        }
        this.triggerWorkerPool();
      });
    }
  }

  public isCircuitBreakerActive(): boolean {
    return Date.now() < this.circuitBreakerUntil;
  }

  public getCircuitBreakerRemainingMs(): number {
    return Math.max(0, this.circuitBreakerUntil - Date.now());
  }

  private canMakeRpcRequest(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 1000);
    return this.requestTimestamps.length < this.maxRequestsPerSecond;
  }

  private recordRpcRequest(): void {
    this.totalRequests++;
    this.requestTimestamps.push(Date.now());
  }

  private async processTask(task: InternalRpcTask): Promise<void> {
    const conn = this.connectionSupplier();
    if (!conn) {
      console.warn(`[RPC_QUEUE] No active Solana RPC connection for task ${task.actionName}. Re-queueing.`);
      task.nextAttemptAt = Date.now() + 2000;
      this.queuedTasks.push(task);
      return;
    }

    const start = Date.now();

    try {
      const result = await task.execute(conn);
      const latencyMs = Date.now() - start;

      this.latencies.push(latencyMs);
      if (this.latencies.length > 50) this.latencies.shift();

      this.totalCompleted++;
      this.completedTimestamps.push(Date.now());
      this.consecutive429Count = 0;

      if (task.signature) {
        console.log(`[RPC_QUEUE] signature=${task.signature} trader=${task.traderName || 'N/A'} action=${task.actionName} status=FETCHED latencyMs=${latencyMs}ms`);
      }

      task.resolve(result);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const is429 = errMsg.includes('429') || errMsg.toLowerCase().includes('too many requests') || err?.status === 429;

      if (is429) {
        this.total429Count++;
        this.consecutive429Count++;
        task.retries++;
        this.totalRetries++;

        // Exponential backoff calculation using configured base and max
        const baseDelay = this.backoffBaseMs * Math.pow(2, Math.min(this.consecutive429Count - 1, 5));
        const exponentialFactor = Math.min(this.backoffMaxMs, Math.max(this.backoffBaseMs, baseDelay));
        const jitter = Math.floor(Math.random() * 500);

        let retryAfterMs = 0;
        const headers = err?.headers || err?.response?.headers;
        if (headers) {
          const headerVal = typeof headers.get === 'function' ? headers.get('retry-after') : (headers['retry-after'] || headers['Retry-After']);
          if (headerVal) {
            const seconds = parseInt(headerVal, 10);
            if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
          }
        }

        const circuitDuration = Math.max(exponentialFactor + jitter, retryAfterMs);
        this.circuitBreakerUntil = Math.max(this.circuitBreakerUntil, Date.now() + circuitDuration);

        // Standardized 429 logging format
        console.warn(`[RPC] status=429 queueDepth=${this.queuedTasks.length} retry=${task.retries} delayMs=${Math.round(circuitDuration)}`);

        if (this.circuitBreakerTimer) {
          clearTimeout(this.circuitBreakerTimer);
        }
        this.circuitBreakerTimer = setTimeout(() => {
          this.circuitBreakerTimer = null;
          this.triggerWorkerPool();
        }, circuitDuration + 25);

        if (task.retries <= this.maxRetries) {
          task.nextAttemptAt = this.circuitBreakerUntil + Math.floor(Math.random() * 500);
          task.lastError = errMsg;

          this.queuedTasks.push(task);
          return;
        } else {
          console.error(`[RPC_QUEUE] signature=${task.signature || 'N/A'} action=${task.actionName} FAILED_PERMANENTLY after ${task.retries} retries due to 429 rate limit.`);
          this.totalFailedPermanently++;
          this.failedTimestamps.push(Date.now());
          task.reject(new Error(`EXCEEDED_MAX_RETRIES_429: ${errMsg}`));
          return;
        }
      }

      // Non-429 Error handling
      task.retries++;
      if (task.retries <= this.maxRetries) {
        task.nextAttemptAt = Date.now() + 1000 * task.retries;
        task.lastError = errMsg;
        this.queuedTasks.push(task);
        console.warn(`[RPC_QUEUE] signature=${task.signature || 'N/A'} action=${task.actionName} error="${errMsg}". Re-queueing attempt ${task.retries}.`);
      } else {
        console.error(`[RPC_QUEUE] signature=${task.signature || 'N/A'} action=${task.actionName} FAILED_PERMANENTLY after ${task.retries} retries. Error: ${errMsg}`);
        this.totalFailedPermanently++;
        this.failedTimestamps.push(Date.now());
        task.reject(err);
      }
    }
  }

  private pruneTimestamps(): void {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 1000);
    this.completedTimestamps = this.completedTimestamps.filter(t => now - t < 60000);
    this.failedTimestamps = this.failedTimestamps.filter(t => now - t < 60000);
  }

  public getMetrics(): RpcQueueMetrics {
    const now = Date.now();
    this.pruneTimestamps();

    const avgLatency = this.latencies.length > 0
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
      : 0;

    let oldestAge = 0;
    if (this.queuedTasks.length > 0) {
      oldestAge = now - Math.min(...this.queuedTasks.map(t => t.enqueuedAt));
    }

    const circuitOpen = now < this.circuitBreakerUntil;

    return {
      rpcRequests: this.totalRequests,
      rpcSuccess: this.totalCompleted,
      rpc429: this.total429Count,
      rpcErrors: this.totalFailedPermanently,
      rpcRetries: this.totalRetries,
      rpcQueueDepth: this.queuedTasks.length,
      rpcActiveRequests: this.activeWorkers,
      rpcCircuitOpen: circuitOpen,
      queuedCount: this.queuedTasks.length,
      activeWorkers: this.activeWorkers,
      completedCount: this.totalCompleted,
      retriesCount: this.totalRetries,
      rateLimit429Count: this.total429Count,
      failedPermanentlyCount: this.totalFailedPermanently,
      avgFetchLatencyMs: avgLatency,
      oldestQueuedAgeMs: oldestAge,
      circuitBreakerActive: circuitOpen,
      requestsLastSecond: this.requestTimestamps.length,
      completedLastMinute: this.completedTimestamps.length,
      failedLastMinute: this.failedTimestamps.length
    };
  }
}
