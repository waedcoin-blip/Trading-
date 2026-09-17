import { jupiterService, JupiterV3PriceItem } from './jupiterService.js';

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

export class LivePriceService {
  private cache: Map<string, LivePrice> = new Map();
  private listeners: Map<string, Set<PriceUpdateListener>> = new Map();
  private globalListeners: Set<PriceUpdateListener> = new Set();
  
  private monitorInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private solUsdPrice: number = 0;
  private lastSolPriceUpdate: number = 0;
  
  // Stale threshold: 15 seconds
  private readonly STALE_THRESHOLD_MS = 15000;

  constructor() {
    this.refreshSolPrice();
  }

  /**
   * Retrieves the active Jupiter API key strictly from environment.
   */
  public getJupiterApiKey(): string {
    return jupiterService.getApiKey();
  }

  public getJupiterStatus(): 'CONNECTED' | 'INVALID_API_KEY' | 'RATE_LIMITED' | 'CONNECTION_ERROR' | 'NOT_CONFIGURED' {
    return jupiterService.getStatus();
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
    if (this.solUsdPrice <= 0 && Date.now() - this.lastSolPriceUpdate > 5000) {
      this.refreshSolPrice().catch(() => {});
    }
    return this.solUsdPrice;
  }

  /**
   * Subscribe to price updates for a specific token mint
   */
  public subscribe(mint: string, listener: PriceUpdateListener): () => void {
    if (!this.listeners.has(mint)) {
      this.listeners.set(mint, new Set());
    }
    this.listeners.get(mint)!.add(listener);

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
    const solMint = 'So11111111111111111111111111111111111111112';
    try {
      // 1. Try Jupiter V3 API first
      const jupPrices = await jupiterService.getPrices([solMint]);
      const solData = jupPrices.get(solMint);
      if (solData && solData.usdPrice && solData.usdPrice > 0) {
        this.solUsdPrice = solData.usdPrice;
        this.lastSolPriceUpdate = Date.now();
        return this.solUsdPrice;
      }

      // 2. Fallback to DexScreener for SOL
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${solMint}`, {
        signal: AbortSignal.timeout(3500)
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
   * Fetch live prices for multiple mints simultaneously via Jupiter V3 Batch Pricing API
   * with automatic DexScreener fallback for any missing or failed tokens.
   */
  public async fetchPrices(mints: string[]): Promise<Map<string, LivePrice>> {
    const results = new Map<string, LivePrice>();
    if (!mints || mints.length === 0) return results;

    const solMint = 'So11111111111111111111111111111111111111112';
    const uniqueMints = Array.from(new Set(mints.filter(m => Boolean(m) && typeof m === 'string')));
    if (uniqueMints.length === 0) return results;

    // Combine SOL mint with requested mints for single efficient Jupiter V3 batch query
    const allQueryMints = Array.from(new Set([solMint, ...uniqueMints]));

    // 1. PRIMARY: Query Jupiter Price API V3 for all mints in a single batch call
    let jupPrices = new Map<string, JupiterV3PriceItem>();
    try {
      jupPrices = await jupiterService.getPrices(allQueryMints);
    } catch (err) {
      console.warn('[LivePriceService] Jupiter V3 batch fetch error:', err);
    }

    // Check if SOL price returned from Jupiter
    const solData = jupPrices.get(solMint);
    if (solData && solData.usdPrice && solData.usdPrice > 0) {
      this.solUsdPrice = solData.usdPrice;
      this.lastSolPriceUpdate = Date.now();
    } else if (Date.now() - this.lastSolPriceUpdate > 30000) {
      await this.refreshSolPrice();
    }

    const currentSolUsd = this.getSolUsdPrice();
    const missingMints: string[] = [];

    // Process Jupiter results for requested mints
    for (const mint of uniqueMints) {
      const item = jupPrices.get(mint);
      if (item && item.usdPrice && item.usdPrice > 0) {
        const priceUsd = item.usdPrice;
        const priceSol = Number((priceUsd / currentSolUsd).toFixed(12));
        const livePrice: LivePrice = {
          mint,
          priceSol,
          priceUsd,
          source: 'jupiter',
          updatedAt: Date.now(),
          isStale: false,
          extra: {
            depth: item.liquidity,
            confidenceLevel: item.blockId ? `Block #${item.blockId}` : undefined
          }
        };
        results.set(mint, livePrice);
        this.updateCacheAndNotify(livePrice);
      } else {
        missingMints.push(mint);
      }
    }

    // 2. FALLBACK: Fetch missing mints via DexScreener concurrently
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
                return;
              }
            }
          } catch (err: any) {
            // DexScreener error
          }

          // Check if we have stale cached price
          const cached = this.cache.get(mint);
          if (cached) {
            const stalePrice: LivePrice = {
              ...cached,
              isStale: true,
              extra: { lastError: 'Price refresh fallback failed' }
            };
            results.set(mint, stalePrice);
            this.updateCacheAndNotify(stalePrice);
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

    console.log('[LivePriceService] Live price engine started (Jupiter V3 Primary / DexScreener Fallback).');

    if (onPriceUpdate) {
      this.subscribeAll(onPriceUpdate);
    }

    let isFetching = false;
    this.monitorInterval = setInterval(async () => {
      if (isFetching) return;
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
