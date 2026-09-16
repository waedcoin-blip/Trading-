import { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { TraderWallet, TradeCandidate } from '../types';
import { Database } from '../db';
import { isValidSolanaMint, isValidSolanaSignature, isBaseAsset } from '../utils/solana';
import { TraderWalletRepository } from './traderWalletRepository';
import { MomentumService } from './momentumService';
import { BuyAuthorizationService } from './buyAuthorization';
import { getRugCheckReport, validateRugCheck } from './rugcheck';
import { scoreToken } from './ai';
import { PaperExecutionService } from './paperExecutionService';
import { RealExecutionService } from './realExecutionService';
import { jupiterService } from './jupiterService';
import { SolanaRpcQueue } from './rpcQueue';

export type SignatureLifecycleStatus =
  | 'QUEUED'
  | 'FETCHING'
  | 'RETRY_WAIT'
  | 'FETCHED'
  | 'PARSED'
  | 'BUY_DETECTED'
  | 'NON_BUY_TRANSACTION'
  | 'FAILED_TRANSACTION'
  | 'EVALUATING'
  | 'AUTHORIZED'
  | 'REJECTED'
  | 'EXECUTING'
  | 'CONFIRMED'
  | 'FAILED_PERMANENTLY';

export interface QueueItem {
  signature: string;
  trader: TraderWallet;
  enqueuedAt: number;
  status: SignatureLifecycleStatus;
  retries: number;
  nullRetries?: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface QueueMetrics {
  queuedCount: number;
  activeWorkers: number;
  completedCount: number;
  retriesCount: number;
  rateLimit429Count: number;
  failedPermanentlyCount: number;
  avgFetchLatencyMs: number;
  oldestQueuedAgeMs: number;
  circuitBreakerActive: boolean;
}

export class SolanaTransactionQueue {
  private static instance: SolanaTransactionQueue | null = null;
  private db: Database;
  private connectionSupplier: () => Connection | null;

  // Configuration from Environment Variables with Robust Defaults
  private concurrency: number;
  private maxRequestsPerSecond: number;
  private maxRetries: number;

  // Queue & Lifecycle Collections
  private queuedItems: Map<string, QueueItem> = new Map();
  private processingSignatures: Set<string> = new Set();
  private completedSignatures: Map<string, number> = new Map(); // signature -> completionTimestamp
  private failedPermanently: Map<string, string> = new Map(); // signature -> reason
  private signatureStatuses: Map<string, SignatureLifecycleStatus> = new Map();
  private signatureTraders: Map<string, string> = new Map();

  // Rate Limiting & Circuit Breaker Controls
  private requestTimestamps: number[] = [];
  private activeWorkers = 0;
  private consecutive429Count = 0;
  private circuitBreakerUntil = 0;
  private circuitBreakerTimer: NodeJS.Timeout | null = null;

  // Diagnostic Metrics
  private totalCompleted = 0;
  private totalRetries = 0;
  private total429Count = 0;
  private latencies: number[] = [];

  private constructor(db: Database, connectionSupplier: () => Connection | null) {
    this.db = db;
    this.connectionSupplier = connectionSupplier;

    // Read environment settings or fallback to safe defaults
    this.concurrency = parseInt(process.env.RPC_MAX_CONCURRENCY || '3', 10);
    this.maxRequestsPerSecond = parseInt(process.env.RPC_MAX_REQUESTS_PER_SECOND || '5', 10);
    this.maxRetries = parseInt(process.env.RPC_MAX_RETRIES || '5', 10);

    // Periodic cleanup loop every 10 minutes to prevent unbounded memory growth
    setInterval(() => this.cleanupOldSignatures(), 10 * 60 * 1000);
  }

  public static getInstance(db: Database, connectionSupplier: () => Connection | null): SolanaTransactionQueue {
    if (!SolanaTransactionQueue.instance) {
      SolanaTransactionQueue.instance = new SolanaTransactionQueue(db, connectionSupplier);
    }
    return SolanaTransactionQueue.instance;
  }

  /**
   * Enqueues a transaction signature for processing.
   * Performs deduplication across QUEUED, PROCESSING, COMPLETED, and FAILED_PERMANENTLY states.
   */
  public enqueue(signature: string, trader: TraderWallet): boolean {
    if (!isValidSolanaSignature(signature)) {
      return false;
    }

    const sig = signature.trim();

    // Deduplication check
    if (
      this.queuedItems.has(sig) ||
      this.processingSignatures.has(sig) ||
      this.completedSignatures.has(sig) ||
      this.failedPermanently.has(sig)
    ) {
      return false;
    }

    const now = Date.now();
    const item: QueueItem = {
      signature: sig,
      trader,
      enqueuedAt: now,
      status: 'QUEUED',
      retries: 0,
      nextAttemptAt: now
    };

    this.queuedItems.set(sig, item);
    this.signatureStatuses.set(sig, 'QUEUED');
    this.signatureTraders.set(sig, trader.name);

    console.log(`[TX_QUEUE] trader=${trader.name} signature=${sig} status=QUEUED queueDepth=${this.queuedItems.size}`);

    this.triggerWorkerPool();
    return true;
  }

  /**
   * Trigger the worker pool to process queued items while complying with concurrency and rate limits.
   */
  public triggerWorkerPool(): void {
    const now = Date.now();

    // Check both local and global RPC circuit breaker
    const rpcQueue = SolanaRpcQueue.getInstance(this.connectionSupplier);
    const rpcBreakerActive = rpcQueue.isCircuitBreakerActive();
    const localBreakerActive = now < this.circuitBreakerUntil;

    if (localBreakerActive || rpcBreakerActive) {
      const waitMs = Math.max(
        this.circuitBreakerUntil - now,
        rpcQueue.getCircuitBreakerRemainingMs()
      );
      if (!this.circuitBreakerTimer && waitMs > 0) {
        this.circuitBreakerTimer = setTimeout(() => {
          this.circuitBreakerTimer = null;
          this.triggerWorkerPool();
        }, waitMs + 25);
      }
      return;
    }

    while (this.activeWorkers < this.concurrency && this.queuedItems.size > 0) {
      if (!this.canMakeRpcRequest()) {
        break;
      }

      // Find next ready item where nextAttemptAt <= now
      let nextSig: string | null = null;
      let oldestItem: QueueItem | null = null;

      for (const [sig, item] of this.queuedItems.entries()) {
        if (item.nextAttemptAt <= now) {
          if (!oldestItem || item.enqueuedAt < oldestItem.enqueuedAt) {
            oldestItem = item;
            nextSig = sig;
          }
        }
      }

      if (!nextSig || !oldestItem) {
        break;
      }

      // Transition item to FETCHING
      this.queuedItems.delete(nextSig);
      this.processingSignatures.add(nextSig);
      oldestItem.status = 'FETCHING';
      this.signatureStatuses.set(nextSig, 'FETCHING');

      this.activeWorkers++;
      this.recordRpcRequest();

      // Process item asynchronously
      this.processQueueItem(oldestItem).finally(() => {
        this.activeWorkers--;
        this.triggerWorkerPool();
      });
    }
  }

  /**
   * Evaluates if an RPC request can be made based on sliding window rate limits.
   */
  private canMakeRpcRequest(): boolean {
    const now = Date.now();
    // Prune requests older than 1 second
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 1000);
    return this.requestTimestamps.length < this.maxRequestsPerSecond;
  }

  private recordRpcRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Core worker execution: fetches transaction with backoff/retries on 429, classifies, and executes copy trading if BUY.
   */
  private async processQueueItem(item: QueueItem): Promise<void> {
    const fetchStart = Date.now();

    try {
      // Route transaction lookup through central SolanaRpcQueue with fair wallet scheduling
      const rpcQueue = SolanaRpcQueue.getInstance(this.connectionSupplier);
      const tx = await rpcQueue.getParsedTransaction(
        item.signature,
        { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
        'HIGH',
        item.trader.wallet_address,
        item.trader.name
      );

      const latencyMs = Date.now() - fetchStart;
      this.latencies.push(latencyMs);
      if (this.latencies.length > 50) this.latencies.shift();

      this.consecutive429Count = 0;
      this.signatureStatuses.set(item.signature, 'FETCHED');

      if (!tx) {
        // Handle Solana RPC indexer lag: parsed transaction may take 300-1500ms to be indexed
        item.nullRetries = (item.nullRetries || 0) + 1;
        if (item.nullRetries <= 3) {
          const delayMs = 750 * item.nullRetries;
          item.status = 'RETRY_WAIT';
          item.nextAttemptAt = Date.now() + delayMs;
          this.signatureStatuses.set(item.signature, 'RETRY_WAIT');
          this.queuedItems.set(item.signature, item);
          this.processingSignatures.delete(item.signature);
          console.log(`[TX_FETCHER] TRANSACTION_PENDING_INDEXING signature=${item.signature} attempt=${item.nullRetries}/3 retryInMs=${delayMs} trader=${item.trader.name}`);
          return;
        } else {
          console.log(`[TX_CLASSIFIER] NON_BUY_TRANSACTION signature=${item.signature} reason=INDEX_TIMEOUT_NULL trader=${item.trader.name}`);
          this.completeItem(item.signature, 'NON_BUY_TRANSACTION');
          return;
        }
      }

      // Classify and process the transaction
      await this.classifyAndProcessTransaction(tx, item.trader, item.signature);
      this.completeItem(item.signature, 'CONFIRMED');

    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const is429 = errMsg.includes('429') || errMsg.toLowerCase().includes('too many requests') || err?.status === 429;

      if (is429) {
        this.total429Count++;
        this.consecutive429Count++;
        item.retries++;
        this.totalRetries++;

        const rpcQueue = SolanaRpcQueue.getInstance(this.connectionSupplier);
        const backpressureWait = Math.max(3000, rpcQueue.getCircuitBreakerRemainingMs());
        this.circuitBreakerUntil = Math.max(this.circuitBreakerUntil, Date.now() + backpressureWait);

        if (item.retries <= this.maxRetries) {
          const delayMs = backpressureWait + Math.floor(Math.random() * 400);
          item.status = 'RETRY_WAIT';
          item.nextAttemptAt = Date.now() + delayMs;
          item.lastError = errMsg;

          this.signatureStatuses.set(item.signature, 'RETRY_WAIT');
          this.queuedItems.set(item.signature, item);
          this.processingSignatures.delete(item.signature);

          console.warn(`[TX_RPC] signature=${item.signature} status=RPC_429_DEFERRED attempt=${item.retries}/${this.maxRetries} retryInMs=${delayMs}`);
          return;
        } else {
          console.error(`[TX_RPC] signature=${item.signature} FAILED_PERMANENTLY after ${item.retries} retries due to 429 rate limit.`);
          this.failedPermanently.set(item.signature, `EXCEEDED_MAX_RETRIES_429: ${errMsg}`);
          this.signatureStatuses.set(item.signature, 'FAILED_PERMANENTLY');
          this.processingSignatures.delete(item.signature);
          return;
        }
      }

      // Non-429 Error: Check if retryable or permanent
      item.retries++;
      if (item.retries <= this.maxRetries) {
        item.status = 'RETRY_WAIT';
        item.nextAttemptAt = Date.now() + 1000 * item.retries;
        item.lastError = errMsg;
        this.queuedItems.set(item.signature, item);
        this.processingSignatures.delete(item.signature);
        console.warn(`[TX_RPC] signature=${item.signature} error="${errMsg}". Re-queueing attempt ${item.retries}.`);
      } else {
        console.error(`[TX_RPC] signature=${item.signature} FAILED_PERMANENTLY after ${item.retries} retries. Error: ${errMsg}`);
        this.failedPermanently.set(item.signature, errMsg);
        this.signatureStatuses.set(item.signature, 'FAILED_PERMANENTLY');
        this.processingSignatures.delete(item.signature);
      }
    }
  }

  private completeItem(signature: string, finalStatus: SignatureLifecycleStatus): void {
    this.processingSignatures.delete(signature);
    this.completedSignatures.set(signature, Date.now());
    this.signatureStatuses.set(signature, finalStatus);
    this.totalCompleted++;
  }

  /**
   * Classifies transaction metadata and extracts target token BUY signal if present.
   */
  private async classifyAndProcessTransaction(
    tx: ParsedTransactionWithMeta,
    trader: TraderWallet,
    signature: string
  ): Promise<void> {
    if (!tx || !tx.meta) {
      console.log(`[TX_CLASSIFIER] NON_BUY_TRANSACTION signature=${signature} reason=MISSING_METADATA trader=${trader.name}`);
      return;
    }

    // Explicitly handle failed on-chain transactions without treating them as token discovery errors
    if (tx.meta.err !== null) {
      console.log(`[Monitor] ONCHAIN_TX_SKIPPED signature=${signature} reason=ONCHAIN_ERR trader=${trader.name}`);
      return;
    }

    const accountKeys = tx.transaction.message.accountKeys.map(a => a.pubkey.toString());
    const traderIndex = accountKeys.indexOf(trader.wallet_address);

    if (traderIndex === -1) {
      console.log(`[TX_CLASSIFIER] NON_BUY_TRANSACTION signature=${signature} reason=TRADER_NOT_IN_ACCOUNTS trader=${trader.name}`);
      return;
    }

    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];

    let targetMint = '';
    let targetDecimals = 0;
    let tokenAcquiredAmount = 0;

    const WSOL_MINT = 'So11111111111111111111111111111111111111112';

    // Inspect post token balances for trader acquisitions
    for (const post of postTokenBalances) {
      if (post.owner === trader.wallet_address) {
        const candidateMint = post.mint;
        if (isValidSolanaMint(candidateMint) && !isBaseAsset(candidateMint)) {
          const pre = preTokenBalances.find(p => p.accountIndex === post.accountIndex);
          const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
          const postAmount = Number(post.uiTokenAmount.amount);

          if (postAmount > preAmount) {
            targetMint = candidateMint;
            targetDecimals = post.uiTokenAmount.decimals;
            tokenAcquiredAmount = (postAmount - preAmount) / Math.pow(10, targetDecimals);
            break;
          }
        }
      }
    }

    // Strict validation: If no non-base SPL token acquired, classify accurately (SELL, TRANSFER, BASE_ASSET)
    if (!targetMint || !isValidSolanaMint(targetMint) || isBaseAsset(targetMint)) {
      const isSell = postTokenBalances.some(post => {
        if (post.owner === trader.wallet_address && !isBaseAsset(post.mint)) {
          const pre = preTokenBalances.find(p => p.accountIndex === post.accountIndex);
          const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
          const postAmount = Number(post.uiTokenAmount.amount);
          return postAmount < preAmount;
        }
        return false;
      });

      const isBaseTrade = postTokenBalances.some(post => post.owner === trader.wallet_address && isBaseAsset(post.mint));
      const reason = isSell ? 'SELL_TRANSACTION' : (isBaseTrade ? 'BASE_ASSET_TRANSACTION' : 'TRANSFER_OR_OTHER');

      console.log(`[TX_CLASSIFIER] NON_BUY_TRANSACTION signature=${signature} reason=${reason} trader=${trader.name}`);
      return;
    }

    // Compute SOL / WSOL spent
    const preSol = tx.meta.preBalances[traderIndex] || 0;
    const postSol = tx.meta.postBalances[traderIndex] || 0;
    let solSpentLamports = preSol - postSol;

    const preWsol = preTokenBalances.find(p => p.owner === trader.wallet_address && p.mint === WSOL_MINT);
    const postWsol = postTokenBalances.find(p => p.owner === trader.wallet_address && p.mint === WSOL_MINT);
    if (preWsol && postWsol) {
      const wsolDiff = Number(preWsol.uiTokenAmount.amount) - Number(postWsol.uiTokenAmount.amount);
      if (wsolDiff > 0) {
        solSpentLamports += wsolDiff;
      }
    }

    const solSpent = Math.max(0.0001, solSpentLamports / 1e9);

    console.log(`[BUY_DETECTED] trader=${trader.name} mint=${targetMint} signature=${signature} solSpent=${solSpent.toFixed(4)} tokenQty=${tokenAcquiredAmount}`);

    // Update trader monitoring status
    const repo = TraderWalletRepository.getInstance(this.db);
    repo.updateTraderMonitoringStatus(trader.id, {
      lastDetectedSignature: signature,
      lastProcessedTimestamp: new Date().toISOString(),
      subscriptionStatus: 'MONITORING',
      lastError: null
    });

    // Record in database
    this.db.addMonitoredTransaction({
      signature,
      trader_wallet_id: trader.id,
      token_mint: targetMint,
      transaction_type: 'BUY',
      sol_amount: solSpent,
      token_amount: tokenAcquiredAmount,
      timestamp: new Date((tx.blockTime || Math.floor(Date.now() / 1000)) * 1000).toISOString()
    });

    // RECORD REAL-TIME MOMENTUM
    MomentumService.getInstance().recordTransaction(targetMint, 'BUY', signature, solSpent);

    // Run evaluation pipeline
    await this.evaluateAndCopyToken(targetMint, targetDecimals, trader, {
      signature,
      solSpent,
      tokenAcquiredAmount
    });
  }

  /**
   * Evaluates candidate token via DexScreener, RugCheck, AI, and BuyAuthorizationService.
   */
  private async evaluateAndCopyToken(
    mint: string,
    decimals: number,
    trader: TraderWallet,
    buyDetails: { signature: string; solSpent: number; tokenAcquiredAmount: number }
  ): Promise<void> {
    if (!isValidSolanaMint(mint)) {
      console.log(`[TradeEngine] Skipped evaluation for ${mint}: invalid mint`);
      return;
    }

    console.log(`[EVALUATING] mint=${mint} trader=${trader.name}`);

    // DexScreener market metadata lookup
    let tokenName = '';
    let tokenSymbol = '';
    let marketCap: number | 'UNKNOWN' = 'UNKNOWN';
    let liquidity: number | 'UNKNOWN' = 'UNKNOWN';
    let volume24h: number | 'UNKNOWN' = 'UNKNOWN';
    let developerHoldingPercent: number | 'UNKNOWN' = 'UNKNOWN';
    let price: number | 'UNKNOWN' = 'UNKNOWN';

    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
      if (res.ok) {
        const data = await res.json();
        const solPairs = (data.pairs || []).filter((p: any) => p.chainId === 'solana');
        const pair = solPairs[0];

        if (pair) {
          tokenName = pair.baseToken?.name || '';
          tokenSymbol = pair.baseToken?.symbol || '';
          price = pair.priceUsd ? Number(pair.priceUsd) : 'UNKNOWN';
          marketCap = pair.fdv ? Number(pair.fdv) : (pair.marketCap ? Number(pair.marketCap) : 'UNKNOWN');
          liquidity = pair.liquidity?.usd ? Number(pair.liquidity.usd) : 'UNKNOWN';
          volume24h = pair.volume?.h24 ? Number(pair.volume.h24) : 'UNKNOWN';
          developerHoldingPercent = 0.0;
        }
      }
    } catch (err) {
      console.error(`[EVALUATING] DexScreener lookup failed for ${mint}:`, err);
    }

    if (
      !tokenName ||
      !tokenSymbol ||
      marketCap === 'UNKNOWN' ||
      liquidity === 'UNKNOWN' ||
      volume24h === 'UNKNOWN' ||
      price === 'UNKNOWN'
    ) {
      console.log(`[TradeEngine] Market metrics pending indexing for mint=${mint} (deferred)`);
      this.db.addTokenObservation({
        token_mint: mint,
        token_name: tokenName || 'MARKET DATA PENDING',
        token_symbol: tokenSymbol || 'UNAVAILABLE',
        market_cap: marketCap,
        liquidity: liquidity,
        volume_24h: volume24h,
        developer_holding_percent: developerHoldingPercent,
        buyers_10s: 0,
        price: price,
        status: 'WAIT',
        rejection_reason: 'Market metrics temporarily unavailable on DexScreener (pending DEX indexing)',
        source_trader_name: trader.name
      });
      return;
    }

    // RugCheck Security Check
    let rugCheck = await getRugCheckReport(mint);
    let rugCheckPassed = false;
    const settings = this.db.getSettings();
    if (settings.enableRugCheck) {
      const rugValidation = validateRugCheck(rugCheck, settings);
      rugCheckPassed = rugValidation.passed;
    } else {
      rugCheckPassed = true;
    }

    // Construct TradeCandidate
    const candidate = {
      tokenMint: mint,
      tokenName,
      tokenSymbol,
      traderWallet: trader.wallet_address,
      sourceSignature: buyDetails.signature,
      detectedAt: new Date().toISOString(),
      market: {
        tokenMint: mint,
        priceUSD: price,
        priceSOL: price / 160.0,
        marketCapUSD: marketCap,
        liquidityUSD: liquidity,
        volumeUSD24h: volume24h,
        timestamp: new Date().toISOString(),
        source: 'DexScreener'
      },
      security: {
        developerHoldingPct: typeof developerHoldingPercent === 'number' ? developerHoldingPercent : 0,
        mintAuthority: rugCheck?.mintAuthority || null,
        freezeAuthority: rugCheck?.freezeAuthority || null,
        lpLocked: rugCheck?.lpLocked || false,
        rugcheckPassed: rugCheckPassed,
        status: rugCheck?.riskLevel || 'Unknown'
      },
      trader: {
        walletAddress: trader.wallet_address,
        name: trader.name,
        signals: 0,
        paperTrades: 0,
        winRate: 0,
        pnlSol: 0
      }
    };

    // Evaluate using BuyAuthorizationService
    const decision = await BuyAuthorizationService.getInstance(this.db).evaluate(candidate);

    // AI Scoring
    let aiResult: any = null;
    try {
      aiResult = await scoreToken({
        token_mint: mint,
        token_name: tokenName,
        token_symbol: tokenSymbol,
        market_cap: marketCap,
        liquidity: liquidity,
        volume_24h: volume24h,
        developer_holding_percent: developerHoldingPercent,
        buyers_10s: decision.criteria.buyTxCount10s,
        price: price,
        status: 'WAIT'
      }, this.db.getTrades());
    } catch (err) {
      console.error(`[EVALUATING] AI scoring failed for ${mint}:`, err);
    }

    const isAuthorized = decision.decision === 'AUTHORIZED';

    if (!isAuthorized) {
      console.log(`[TradeEngine] Evaluation complete for mint=${mint}: criteria not met`);
      this.db.addTokenObservation({
        token_mint: mint,
        token_name: tokenName,
        token_symbol: tokenSymbol,
        market_cap: marketCap,
        liquidity: liquidity,
        volume_24h: volume24h,
        developer_holding_percent: developerHoldingPercent,
        buyers_10s: decision.criteria.buyTxCount10s,
        price: price,
        status: 'REJECT',
        rejection_reason: decision.rejectReasons.join(', '),
        source_trader_name: trader.name,
        ai_score: aiResult?.score,
        ai_signals: aiResult?.signals,
        rugcheck: rugCheck,
        rugcheck_passed: rugCheckPassed
      });
      return;
    }

    console.log(`[BUY_AUTHORIZED] mint=${mint} symbol=${tokenSymbol} trader=${trader.name}`);

    // Execute Trade Entry (PAPER vs REAL)
    const priceSol = typeof price === 'number' ? price / 160.0 : 0.000001;
    const isRealMode = settings.trading_mode === 'MAINNET' || settings.mainnet_enabled === true;

    if (!isRealMode) {
      console.log(`[EXECUTION] mint=${mint} mode=PAPER status=SUBMITTED`);
      const paperPos = PaperExecutionService.getInstance(this.db).executeBuy(
        mint,
        tokenName,
        tokenSymbol,
        decimals,
        priceSol,
        trader.id,
        trader.name,
        buyDetails.signature
      );
      console.log(`[EXECUTION] mint=${mint} mode=PAPER status=CONFIRMED posId=${paperPos.mint}`);
    } else {
      console.log(`[EXECUTION] mint=${mint} mode=REAL status=SUBMITTED`);
      const realResult = await RealExecutionService.getInstance(this.db).executeBuy(
        mint,
        tokenName,
        tokenSymbol,
        decimals,
        priceSol,
        trader.id,
        trader.name,
        buyDetails.signature,
        this.connectionSupplier()
      );

      if (realResult.success) {
        console.log(`[EXECUTION] mint=${mint} mode=REAL status=CONFIRMED sig=${realResult.signature}`);
      } else {
        console.error(`[EXECUTION] mint=${mint} mode=REAL status=FAILED error=${realResult.error}`);
      }
    }
  }

  private cleanupOldSignatures(): void {
    const now = Date.now();
    const fourHoursMs = 4 * 60 * 60 * 1000;

    for (const [sig, time] of this.completedSignatures.entries()) {
      if (now - time > fourHoursMs) {
        this.completedSignatures.delete(sig);
        this.signatureStatuses.delete(sig);
        this.signatureTraders.delete(sig);
      }
    }

    for (const sig of this.failedPermanently.keys()) {
      this.completedSignatures.delete(sig);
    }
  }

  public getMetrics(): QueueMetrics {
    const now = Date.now();
    let oldestAge = 0;

    for (const item of this.queuedItems.values()) {
      const age = now - item.enqueuedAt;
      if (age > oldestAge) oldestAge = age;
    }

    const avgLatency = this.latencies.length > 0
      ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
      : 0;

    return {
      queuedCount: this.queuedItems.size,
      activeWorkers: this.activeWorkers,
      completedCount: this.totalCompleted,
      retriesCount: this.totalRetries,
      rateLimit429Count: this.total429Count,
      failedPermanentlyCount: this.failedPermanently.size,
      avgFetchLatencyMs: Math.round(avgLatency),
      oldestQueuedAgeMs: oldestAge,
      circuitBreakerActive: now < this.circuitBreakerUntil
    };
  }

  public getSignatureStatus(signature: string): SignatureLifecycleStatus | undefined {
    return this.signatureStatuses.get(signature);
  }

  public getSignatureStatusesMap(): Record<string, { status: SignatureLifecycleStatus; trader?: string }> {
    const result: Record<string, { status: SignatureLifecycleStatus; trader?: string }> = {};
    for (const [sig, status] of this.signatureStatuses.entries()) {
      result[sig] = {
        status,
        trader: this.signatureTraders.get(sig)
      };
    }
    return result;
  }
}
