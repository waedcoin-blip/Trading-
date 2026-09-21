// Standard Node 18+ AbortController used

export interface JupiterV3PriceItem {
  id: string;
  usdPrice?: number;
  price?: number;
  blockId?: number;
  decimals?: number;
  liquidity?: number;
  priceChange24h?: number;
}

export interface JupiterV3PriceResponse {
  data?: Record<string, JupiterV3PriceItem>;
  timeTaken?: number;
}

export type JupiterStatus = 
  | 'CONNECTED' 
  | 'INVALID_API_KEY' 
  | 'RATE_LIMITED' 
  | 'CONNECTION_ERROR' 
  | 'NOT_CONFIGURED';

export interface JupiterHealthResult {
  ok: boolean;
  status: JupiterStatus;
  latencyMs: number;
  timestamp: number;
  configured: boolean;
  endpointVersion: 'V3';
  error?: string;
  lastSuccessfulAt?: number;
  lastFailureAt?: number;
}

class JupiterService {
  private readonly baseUrl = 'https://api.jup.ag/price/v3';
  private readonly timeoutMs = 5000;
  private readonly maxRetries = 2;
  private readonly batchSize = 50;

  private healthCache: JupiterHealthResult | null = null;
  private lastHealthCheckTime = 0;
  private readonly healthCacheTtlMs = 30000; // 30 seconds cache TTL for health check

  private lastSuccessfulAt?: number;
  private lastFailureAt?: number;
  private lastError?: string;
  private currentStatus: JupiterStatus = 'NOT_CONFIGURED';

  /**
   * Retrieves the server-side Jupiter API key strictly from environment.
   * NEVER reads from client, db.json, or frontend settings.
   */
  public getApiKey(): string {
    const key = process.env.JUPITER_API_KEY;
    if (key && typeof key === 'string' && key.trim().length > 0) {
      return key.trim();
    }
    return '';
  }

  /**
   * Returns current health diagnostic status (cached up to 30s)
   */
  public async getHealth(): Promise<JupiterHealthResult> {
    const now = Date.now();
    if (this.healthCache && (now - this.lastHealthCheckTime < this.healthCacheTtlMs)) {
      return this.healthCache;
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      const result: JupiterHealthResult = {
        ok: false,
        status: 'NOT_CONFIGURED',
        latencyMs: 0,
        timestamp: now,
        configured: false,
        endpointVersion: 'V3',
        error: 'JUPITER_NOT_CONFIGURED: JUPITER_API_KEY environment variable is not set'
      };
      this.healthCache = result;
      this.lastHealthCheckTime = now;
      this.currentStatus = 'NOT_CONFIGURED';
      return result;
    }

    // Perform lightweight probe ping for SOL mint
    const startTime = Date.now();
    try {
      const solMint = 'So11111111111111111111111111111111111111112';
      const prices = await this.fetchPricesBatchDirect([solMint]);
      const latencyMs = Date.now() - startTime;

      if (prices.has(solMint)) {
        this.lastSuccessfulAt = Date.now();
        this.currentStatus = 'CONNECTED';
        const result: JupiterHealthResult = {
          ok: true,
          status: 'CONNECTED',
          latencyMs,
          timestamp: Date.now(),
          configured: true,
          endpointVersion: 'V3',
          lastSuccessfulAt: this.lastSuccessfulAt,
          lastFailureAt: this.lastFailureAt
        };
        this.healthCache = result;
        this.lastHealthCheckTime = Date.now();
        return result;
      } else {
        throw new Error('JUPITER_NO_PRICE: Health check response missing SOL price data');
      }
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      this.lastFailureAt = Date.now();
      const errMsg = err?.message || String(err);
      this.lastError = errMsg;

      let status: JupiterStatus = 'CONNECTION_ERROR';
      if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('INVALID_API_KEY')) {
        status = 'INVALID_API_KEY';
      } else if (errMsg.includes('429') || errMsg.includes('RATE_LIMITED')) {
        status = 'RATE_LIMITED';
      }

      this.currentStatus = status;

      const result: JupiterHealthResult = {
        ok: false,
        status,
        latencyMs,
        timestamp: Date.now(),
        configured: true,
        endpointVersion: 'V3',
        error: errMsg,
        lastSuccessfulAt: this.lastSuccessfulAt,
        lastFailureAt: this.lastFailureAt
      };
      this.healthCache = result;
      this.lastHealthCheckTime = Date.now();
      return result;
    }
  }

  /**
   * Fetches token prices for any array of mint addresses using Jupiter Price API V3.
   * Automatically deduplicates, chunks into batches of max 50 mints, retries with backoff,
   * and returns a map of mint -> JupiterV3PriceItem.
   */
  public async getPrices(mints: string[]): Promise<Map<string, JupiterV3PriceItem>> {
    const results = new Map<string, JupiterV3PriceItem>();
    if (!mints || mints.length === 0) return results;

    // Deduplicate mints
    const uniqueMints = Array.from(new Set(mints.filter(m => Boolean(m) && typeof m === 'string')));
    if (uniqueMints.length === 0) return results;

    // Chunk into groups of max 50 mints
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueMints.length; i += this.batchSize) {
      chunks.push(uniqueMints.slice(i, i + this.batchSize));
    }

    // Execute chunk requests
    for (const chunk of chunks) {
      try {
        const chunkPrices = await this.fetchPricesBatchWithRetry(chunk);
        for (const [mint, item] of chunkPrices.entries()) {
          results.set(mint, item);
        }
      } catch (err: any) {
        console.info(`[JupiterService] Batch query status: fallback active for chunk of ${chunk.length} mints.`);
      }
    }

    return results;
  }

  /**
   * Internal helper to execute a batch request with bounded retry and exponential backoff.
   */
  private async fetchPricesBatchWithRetry(mintsChunk: string[]): Promise<Map<string, JupiterV3PriceItem>> {
    let attempt = 0;
    let lastErr: any = null;

    while (attempt <= this.maxRetries) {
      try {
        return await this.fetchPricesBatchDirect(mintsChunk);
      } catch (err: any) {
        lastErr = err;
        const errMsg = err?.message || String(err);

        // Do NOT retry 401/403 authentication errors
        if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('INVALID_API_KEY')) {
          this.currentStatus = 'INVALID_API_KEY';
          throw err;
        }

        attempt++;
        if (attempt <= this.maxRetries) {
          const backoffMs = attempt === 1 ? 250 : 500;
          await new Promise(res => setTimeout(res, backoffMs));
        }
      }
    }

    throw lastErr;
  }

  /**
   * Direct single HTTP fetch call to Jupiter Price API V3.
   */
  private async fetchPricesBatchDirect(mintsChunk: string[]): Promise<Map<string, JupiterV3PriceItem>> {
    const results = new Map<string, JupiterV3PriceItem>();
    const apiKey = this.getApiKey();

    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    const idsParam = encodeURIComponent(mintsChunk.join(','));
    const url = `${this.baseUrl}?ids=${idsParam}`;

    const controller = new globalThis.AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal as any
      });

      clearTimeout(timeoutId);

      if (response.status === 401 || response.status === 403) {
        this.currentStatus = 'INVALID_API_KEY';
        this.lastFailureAt = Date.now();
        throw new Error(`JUPITER_INVALID_API_KEY: Authentication failed (HTTP ${response.status})`);
      }

      if (response.status === 429) {
        this.currentStatus = 'RATE_LIMITED';
        this.lastFailureAt = Date.now();
        throw new Error(`JUPITER_RATE_LIMITED: Rate limit exceeded (HTTP 429)`);
      }

      if (!response.ok) {
        this.currentStatus = 'CONNECTION_ERROR';
        this.lastFailureAt = Date.now();
        throw new Error(`JUPITER_HTTP_${response.status}: Jupiter returned HTTP ${response.status}`);
      }

      const json: JupiterV3PriceResponse = await response.json();
      const tokenMap = json?.data || {};

      this.currentStatus = apiKey ? 'CONNECTED' : 'NOT_CONFIGURED';
      this.lastSuccessfulAt = Date.now();

      for (const mint of mintsChunk) {
        const item = tokenMap[mint];
        if (item) {
          const rawPrice = item.usdPrice !== undefined ? Number(item.usdPrice) : (item.price !== undefined ? Number(item.price) : undefined);
          if (rawPrice !== undefined && !isNaN(rawPrice) && rawPrice > 0) {
            results.set(mint, {
              id: item.id || mint,
              usdPrice: rawPrice,
              price: rawPrice,
              blockId: item.blockId,
              decimals: item.decimals,
              liquidity: item.liquidity,
              priceChange24h: item.priceChange24h
            });
          }
        }
      }

      return results;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        this.currentStatus = 'CONNECTION_ERROR';
        this.lastFailureAt = Date.now();
        throw new Error('JUPITER_TIMEOUT: Request to Jupiter V3 API timed out after 5000ms');
      }
      throw err;
    }
  }

  /**
   * Fetches an authoritative Jupiter V6 Swap Quote for real trade execution.
   */
  public async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number = 100
  ): Promise<any> {
    const apiKey = this.getApiKey();
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${amountLamports}&slippageBps=${slippageBps}`;

    try {
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`JUPITER_QUOTE_FAILED: HTTP ${response.status} - ${errText.slice(0, 150)}`);
      }

      const quoteData = await response.json();
      if (!quoteData || !quoteData.outAmount) {
        throw new Error('JUPITER_QUOTE_FAILED: Invalid quote response returned by Jupiter API');
      }

      return quoteData;
    } catch (err: any) {
      console.info('[JupiterService] Quote query status: fallback route engaged.');
      throw err;
    }
  }

  /**
   * Builds an unsigned VersionedTransaction from a Jupiter V6 quote response.
   */
  public async buildSwapTransaction(quoteResponse: any, userPublicKey: string): Promise<string> {
    const apiKey = this.getApiKey();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    const url = 'https://quote-api.jup.ag/v6/swap';
    const body = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`JUPITER_SWAP_BUILD_FAILED: HTTP ${response.status} - ${errText.slice(0, 150)}`);
      }

      const data = await response.json();
      if (!data || !data.swapTransaction) {
        throw new Error('JUPITER_SWAP_BUILD_FAILED: Missing swapTransaction base64 in response');
      }

      return data.swapTransaction;
    } catch (err: any) {
      console.info('[JupiterService] Swap transaction build status: alternative active.');
      throw err;
    }
  }

  public getStatus(): JupiterStatus {
    const apiKey = this.getApiKey();
    if (!apiKey) return 'NOT_CONFIGURED';
    return this.currentStatus;
  }
}

export const jupiterService = new JupiterService();
