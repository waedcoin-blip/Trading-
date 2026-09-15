import { db } from '../db.js';

export interface LivePrice {
  mint: string;
  priceSol: number;
  priceUsd: number;
  source: 'jupiter' | 'fallback';
  updatedAt: number;
  isStale: boolean;
  extra?: {
    confidenceLevel?: string;
    depth?: number;
    lastError?: string;
  };
}

export interface PriceUpdateListener {
  (price: LivePrice): void;
}

export interface PositionPnLUpdate {
  positionId: string;
  mint: string;
  pnlSol: number;
  pnlPercent: number;
  currentValueSol: number;
  currentPriceSol: number;
  currentPriceUsd: number;
  priceUpdatedAt: number;
  priceSource: 'jupiter' | 'fallback';
  isStale: boolean;
}

class LivePriceService {
  private cache: Map<string, LivePrice> = new Map();
  private listeners: Map<string, Set<PriceUpdateListener>> = new Map();
  private globalListeners: Set<PriceUpdateListener> = new Set();
  
  private monitorInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private solUsdPrice: number = 160.0;
  private lastSolPriceUpdate: number = 0;
  
  // Stale threshold: 15 seconds
  private readonly STALE_THRESHOLD_MS = 15000;
  // Fallback stale threshold: 60 seconds
  private readonly CRITICAL_STALE_THRESHOLD_MS = 60000;

  private jupiterStatus: 'CONNECTED' | 'INVALID_API_KEY' | 'CONNECTION_ERROR' | 'NOT_CONFIGURED' = 'NOT_CONFIGURED';

  constructor() {
    this.refreshSolPrice();
  }

  /**
   * Retrieves the active Jupiter API key securely from environment or settings
   */
  public getJupiterApiKey(): string {
    const envKey = process.env.JUPITER_API_KEY;
    if (envKey && envKey.trim().length > 0) {
      return envKey.trim();
    }
    const settings = db.getSettings();
    if (settings?.jupiter_api_key && settings.jupiter_api_key.trim().length > 0) {
      return settings.jupiter_api_key.trim();
    }
    return '';
  }

  public getJupiterStatus(): 'CONNECTED' | 'INVALID_API_KEY' | 'CONNECTION_ERROR' | 'NOT_CONFIGURED' {
    const key = this.getJupiterApiKey();
    if (!key) {
      return 'NOT_CONFIGURED';
    }
    return this.jupiterStatus;
  }

  /**
   * Get cached live price for a token mint
   */
  public getLivePrice(mint: string): LivePrice | null {
    const cached = this.cache.get(mint);
    if (!cached) return null;

    const age = Date.now() - cached.updatedAt;
    const isStale = age > this.STALE_THRESHOLD_MS;
    return {
      ...cached,
      isStale
    };
  }

  /**
   * Get current authoritative SOL/USD price
   */
  public getSolUsdPrice(): number {
    return this.solUsdPrice > 0 ? this.solUsdPrice : 160.0;
  }

  /**
   * Subscribe to price updates for a specific token mint
   */
  public subscribe(mint: string, listener: PriceUpdateListener): () => void {
    if (!this.listeners.has(mint)) {
      this.listeners.set(mint, new Set());
    }
    this.listeners.get(mint)!.add(listener);

    // If we have an existing fresh price, notify immediately
    const existing = this.getLivePrice(mint);
    if (existing) {
      listener(existing);
    }

    return () => this.unsubscribe(mint, listener);
  }

  /**
   * Unsubscribe from price updates for a specific mint
   */
  public unsubscribe(mint: string, listener: PriceUpdateListener) {
    const set = this.listeners.get(mint);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(mint);
      }
    }
  }

  /**
   * Subscribe to all price updates across all mints
   */
  public subscribeAll(listener: PriceUpdateListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  /**
   * Refresh authoritative SOL/USD price
   */
  public async refreshSolPrice(): Promise<number> {
    try {
      const apiKey = this.getJupiterApiKey();
      const headers: Record<string, string> = {
        'Accept': 'application/json'
      };
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }

      // Try Jupiter price API first for SOL
      const solMint = 'So11111111111111111111111111111111111111112';
      const jupRes = await fetch(`https://api.jup.ag/price/v2?ids=${solMint}`, {
        headers,
        signal: AbortSignal.timeout(3500)
      });

      if (jupRes.ok) {
        const jupData = await jupRes.json();
        const solData = jupData?.data?.[solMint];
        if (solData?.price) {
          this.solUsdPrice = Number(solData.price);
          this.lastSolPriceUpdate = Date.now();
          return this.solUsdPrice;
        }
      }

      // Fallback to DexScreener for SOL
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${solMint}`, {
        signal: AbortSignal.timeout(4000)
      });
      if (dexRes.ok) {
        const dexData = await dexRes.json();
        const solPair = (dexData.pairs || []).find((p: any) => p.chainId === 'solana' && p.priceUsd);
        if (solPair?.priceUsd) {
          this.solUsdPrice = Number(solPair.priceUsd);
          this.lastSolPriceUpdate = Date.now();
          return this.solUsdPrice;
        }
      }
    } catch (err) {
      // Retain last known price
    }
    return this.solUsdPrice;
  }

  /**
   * Fetch live prices for multiple mints simultaneously via Jupiter Batch Pricing API
   * with automatic fallback for any missing or failed tokens.
   */
  public async fetchPrices(mints: string[]): Promise<Map<string, LivePrice>> {
    const results = new Map<string, LivePrice>();
    if (mints.length === 0) return results;

    const uniqueMints = Array.from(new Set(mints.filter(Boolean)));
    const apiKey = this.getJupiterApiKey();
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    const missingMints: string[] = [];

    // Ensure SOL/USD rate is fresh
    if (Date.now() - this.lastSolPriceUpdate > 30000) {
      await this.refreshSolPrice();
    }
    const currentSolUsd = this.getSolUsdPrice();

    // 1. PRIMARY: Query Jupiter Price API v2 with all mints in a single concurrent batch
    try {
      const idsParam = encodeURIComponent(uniqueMints.join(','));
      const url = `https://api.jup.ag/price/v2?ids=${idsParam}&showExtraInfo=true`;
      
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        const data = await response.json();
        const tokenMap = data?.data || {};

        this.jupiterStatus = apiKey ? 'CONNECTED' : 'NOT_CONFIGURED';

        for (const mint of uniqueMints) {
          const item = tokenMap[mint];
          if (item && item.price !== undefined && item.price !== null) {
            const priceUsd = Number(item.price);
            const priceSol = Number((priceUsd / currentSolUsd).toFixed(12));
            const livePrice: LivePrice = {
              mint,
              priceSol,
              priceUsd,
              source: 'jupiter',
              updatedAt: Date.now(),
              isStale: false,
              extra: {
                confidenceLevel: item.extraInfo?.confidenceLevel,
                depth: item.extraInfo?.depth
              }
            };
            results.set(mint, livePrice);
            this.updateCacheAndNotify(livePrice);
          } else {
            missingMints.push(mint);
          }
        }
      } else {
        if (response.status === 401 || response.status === 403) {
          this.jupiterStatus = 'INVALID_API_KEY';
        } else {
          this.jupiterStatus = 'CONNECTION_ERROR';
        }
        // All mints fall back
        missingMints.push(...uniqueMints);
      }
    } catch (err: any) {
      this.jupiterStatus = apiKey ? 'CONNECTION_ERROR' : 'NOT_CONFIGURED';
      missingMints.push(...uniqueMints);
    }

    // 2. FALLBACK: Fetch missing mints via DexScreener concurrently (bounded)
    if (missingMints.length > 0) {
      await Promise.allSettled(
        missingMints.map(async (mint) => {
          try {
            const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
              signal: AbortSignal.timeout(3500)
            });
            if (dexRes.ok) {
              const dexData = await dexRes.json();
              const solPairs = (dexData.pairs || []).filter((p: any) => p.chainId === 'solana');
              const pair = solPairs[0];
              if (pair?.priceUsd) {
                const priceUsd = Number(pair.priceUsd);
                const priceSol = Number((priceUsd / currentSolUsd).toFixed(12));
                const livePrice: LivePrice = {
                  mint,
                  priceSol,
                  priceUsd,
                  source: 'fallback',
                  updatedAt: Date.now(),
                  isStale: false
                };
                results.set(mint, livePrice);
                this.updateCacheAndNotify(livePrice);
              }
            }
          } catch (err: any) {
            // Check if we have stale cached price
            const cached = this.cache.get(mint);
            if (cached) {
              const stalePrice: LivePrice = {
                ...cached,
                isStale: true,
                extra: { lastError: err?.message || 'Price refresh failed' }
              };
              results.set(mint, stalePrice);
              this.updateCacheAndNotify(stalePrice);
            }
          }
        })
      );
    }

    return results;
  }

  /**
   * Helper to update cache and dispatch to listeners
   */
  private updateCacheAndNotify(price: LivePrice) {
    this.cache.set(price.mint, price);

    // Notify specific listeners
    const specific = this.listeners.get(price.mint);
    if (specific) {
      for (const listener of specific) {
        try {
          listener(price);
        } catch (err) {
          console.error(`[PriceService] Listener error for ${price.mint}:`, err);
        }
      }
    }

    // Notify global listeners
    for (const globalListener of this.globalListeners) {
      try {
        globalListener(price);
      } catch (err) {
        console.error('[PriceService] Global listener error:', err);
      }
    }
  }

  /**
   * Starts the centralized event-driven live price polling loop.
   * Runs at a target interval of 1-1.5s for all currently active mints.
   */
  public startLiveMonitoring(
    getActiveMints: () => string[],
    onPriceUpdate?: (price: LivePrice) => void
  ) {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('[LivePriceService] Live price engine started (Jupiter Primary / DexScreener Fallback).');

    if (onPriceUpdate) {
      this.subscribeAll(onPriceUpdate);
    }

    // High-frequency, batch-driven price loop (every 1200ms)
    let isFetching = false;
    this.monitorInterval = setInterval(async () => {
      if (isFetching) return; // Prevent overlapping iterations
      isFetching = true;

      try {
        const activeMints = getActiveMints();
        if (activeMints.length > 0) {
          await this.fetchPrices(activeMints);
        }
      } catch (err) {
        console.error('[LivePriceService] Error during batch price cycle:', err);
      } finally {
        isFetching = false;
      }
    }, 1200);
  }

  public stopLiveMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isRunning = false;
    console.log('[LivePriceService] Live price engine stopped.');
  }
}

export const livePriceService = new LivePriceService();
