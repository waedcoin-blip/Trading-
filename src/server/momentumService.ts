interface TxEvent {
  timestamp: number; // millisecond timestamp
  type: 'BUY' | 'SELL' | 'TRANSFER' | 'SWAP' | 'UNKNOWN';
  signature: string;
  solAmount?: number;
}

export class MomentumService {
  private static instance: MomentumService;
  // Map token mint -> array of TxEvents
  private events: Map<string, TxEvent[]> = new Map();

  private constructor() {
    // Run an automatic cleanup loop every 10 seconds to keep memory usage low
    setInterval(() => this.cleanup(), 10000);
  }

  public static getInstance(): MomentumService {
    if (!MomentumService.instance) {
      MomentumService.instance = new MomentumService();
    }
    return MomentumService.instance;
  }

  /**
   * Adds a transaction event to the token's event log.
   */
  public recordTransaction(
    mint: string, 
    type: 'BUY' | 'SELL' | 'TRANSFER' | 'SWAP' | 'UNKNOWN', 
    signature: string, 
    solAmount?: number
  ): void {
    const key = mint.trim();
    if (!this.events.has(key)) {
      this.events.set(key, []);
    }
    const list = this.events.get(key)!;
    
    // De-duplicate within the event array by signature
    if (list.some(e => e.signature === signature)) {
      return;
    }

    list.push({
      timestamp: Date.now(),
      type,
      signature,
      solAmount
    });
  }

  /**
   * Returns counts and metrics for a given token.
   */
  public getMomentum(mint: string) {
    const key = mint.trim();
    const list = this.events.get(key) || [];
    const now = Date.now();

    // Filter list for valid windows
    const within = (ms: number) => list.filter(e => now - e.timestamp <= ms);

    const events5s = within(5000);
    const events10s = within(10000);
    const events30s = within(30000);
    const events60s = within(60000);

    const buyCount5s = events5s.filter(e => e.type === 'BUY').length;
    const buyCount10s = events10s.filter(e => e.type === 'BUY').length;
    const buyCount30s = events30s.filter(e => e.type === 'BUY').length;
    const buyCount60s = events60s.filter(e => e.type === 'BUY').length;

    const sellCount10s = events10s.filter(e => e.type === 'SELL').length;
    const sellCount30s = events30s.filter(e => e.type === 'SELL').length;

    // Calculate sum of buy and sell volume inside the last 10s
    const buyVolume10s = events10s.filter(e => e.type === 'BUY').reduce((sum, e) => sum + (e.solAmount || 0), 0);
    const sellVolume10s = events10s.filter(e => e.type === 'SELL').reduce((sum, e) => sum + (e.solAmount || 0), 0);

    // Dynamic price momentum indicator (e.g. ratio of buys vs sells)
    const totalCount10s = buyCount10s + sellCount10s;
    const buyAcceleration = buyCount5s / (buyCount10s || 1); // Buys in 5s relative to 10s

    const priceChange10s = totalCount10s > 0 ? (buyCount10s - sellCount10s) / totalCount10s : 0;
    const priceChange30s = (buyCount30s - sellCount30s) / ((buyCount30s + sellCount30s) || 1);

    // Beginning-momentum window indicators
    const buyTxIncreasing = buyCount5s > 0 || buyCount10s > 0;
    const buyVelocityIncreasing = buyAcceleration >= 0.5 || buyCount10s >= 1;
    const volumeIncreasing = buyVolume10s >= sellVolume10s;
    const priceMovingPositively = priceChange10s >= 0;

    // Early momentum flag
    const earlyMomentumDetected = buyTxIncreasing && buyVelocityIncreasing && volumeIncreasing && priceMovingPositively;

    return {
      buyTxCount5s: buyCount5s,
      buyTxCount10s: buyCount10s,
      buyTxCount30s: buyCount30s,
      buyTxCount60s: buyCount60s,
      sellTxCount10s: sellCount10s,
      sellTxCount30s: sellCount30s,
      buyVolume10s,
      sellVolume10s,
      priceChange10s,
      priceChange30s,
      priceChange5m: 0,
      buyAcceleration,
      buyTxIncreasing,
      buyVelocityIncreasing,
      volumeIncreasing,
      priceMovingPositively,
      earlyMomentumDetected
    };
  }

  /**
   * Clean up old transactions (older than 5 minutes) to protect memory
   */
  private cleanup(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // Keep up to 5 minutes of momentum history

    for (const [mint, list] of this.events.entries()) {
      const active = list.filter(e => now - e.timestamp <= maxAge);
      if (active.length === 0) {
        this.events.delete(mint);
      } else {
        this.events.set(mint, active);
      }
    }
  }
}
