import { Database } from '../db.js';
import { TokenObservation, DiscoveryFeedState, Settings } from '../types.js';
import { isValidSolanaMint } from '../utils/solana.js';
import { getRugCheckReport, validateRugCheck } from './rugcheck.js';
import { BuyAuthorizationService } from './buyAuthorization.js';
import { scoreToken } from './ai.js';

export interface RawTokenCandidate {
  mint: string;
  source: string;
}

export type RefreshStatusListener = (state: DiscoveryFeedState) => void;

export class TokenDiscoveryService {
  private static instance: TokenDiscoveryService;
  private db: Database;
  
  public readonly DISCOVERY_REFRESH_INTERVAL = 120000; // 120 seconds
  
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  private lastRefreshAt = 0;
  private nextRefreshAt = 0;
  private lastError: string | null = null;
  private status: 'IDLE' | 'REFRESHING' | 'SUCCESS' | 'FAILED' = 'IDLE';
  
  // Generation counter to prevent stale asynchronous race conditions
  private discoveryGeneration = 0;

  private listeners: Set<RefreshStatusListener> = new Set();

  private constructor(db: Database) {
    this.db = db;
  }

  public static getInstance(db?: Database): TokenDiscoveryService {
    if (!TokenDiscoveryService.instance) {
      if (!db) {
        throw new Error('TokenDiscoveryService requires Database instance on initial call');
      }
      TokenDiscoveryService.instance = new TokenDiscoveryService(db);
    }
    return TokenDiscoveryService.instance;
  }

  public subscribe(listener: RefreshStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    const currentState = this.getFeedState();
    for (const listener of this.listeners) {
      try {
        listener(currentState);
      } catch (err) {
        console.error('[TOKEN_DISCOVERY] Listener error:', err);
      }
    }
  }

  public getFeedState(): DiscoveryFeedState {
    return {
      timestamp: this.lastRefreshAt,
      nextRefreshAt: this.nextRefreshAt,
      status: this.status,
      error: this.lastError,
      tokens: this.db.getTokenObservations()
    };
  }

  /**
   * Starts the authoritative backend 2-minute discovery scheduler.
   * Guarantees strictly ONE active timer loop.
   */
  public start(onRefreshBroadcast?: RefreshStatusListener) {
    if (onRefreshBroadcast) {
      this.subscribe(onRefreshBroadcast);
    }

    if (this.intervalTimer) {
      console.log('[TOKEN_DISCOVERY] Discovery scheduler is already active. Skipping duplicate timer creation.');
      return;
    }

    console.log('[TOKEN_DISCOVERY] Starting 120s authoritative discovery scheduler...');
    
    // Initial scan on startup
    this.runRefreshCycle();

    // Schedule 120-second recurring refresh loop
    this.intervalTimer = setInterval(() => {
      this.runRefreshCycle();
    }, this.DISCOVERY_REFRESH_INTERVAL);
  }

  public stop() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      console.log('[TOKEN_DISCOVERY] Discovery scheduler stopped.');
    }
  }

  /**
   * Executes a fresh 2-minute token discovery scan and replacement pipeline.
   */
  public async runRefreshCycle() {
    if (this.isRefreshing) {
      console.warn('[TOKEN_DISCOVERY] Discovery refresh already in progress. Skipping competing trigger.');
      return;
    }

    this.isRefreshing = true;
    const generation = ++this.discoveryGeneration;
    const startTime = Date.now();

    this.status = 'REFRESHING';
    this.lastError = null;
    this.nextRefreshAt = startTime + this.DISCOVERY_REFRESH_INTERVAL;
    
    console.log(`[TOKEN_DISCOVERY] Refresh started (Generation #${generation})`);
    this.notifyListeners();

    try {
      // Step 1: Clear old discovery feed (Requirement 2 & 3)
      // Note: Only token_observations are cleared. Positions, trades, rebuy, and AI learning are NEVER deleted.
      const previousCount = this.db.getTokenObservations().length;
      this.db.clearTokenObservations();
      console.log(`[TOKEN_DISCOVERY] Previous feed cleared: ${previousCount}`);

      // Step 2: Request fresh token candidates
      const rawCandidates = await this.fetchFreshCandidates();
      console.log(`[TOKEN_DISCOVERY] Candidates received: ${rawCandidates.length}`);

      if (generation !== this.discoveryGeneration) {
        console.warn(`[TOKEN_DISCOVERY] Stale generation #${generation} aborted after candidate fetch.`);
        this.isRefreshing = false;
        return;
      }

      // Step 3: Deduplicate mints within this refresh cycle (Requirement 5)
      const uniqueMintsMap = new Map<string, RawTokenCandidate>();
      for (const cand of rawCandidates) {
        const normalizedMint = cand.mint ? cand.mint.trim() : '';
        if (!isValidSolanaMint(normalizedMint)) continue;

        if (!uniqueMintsMap.has(normalizedMint)) {
          uniqueMintsMap.set(normalizedMint, {
            mint: normalizedMint,
            source: cand.source
          });
        }
      }
      console.log(`[TOKEN_DISCOVERY] After deduplication: ${uniqueMintsMap.size}`);

      // Step 4: Validate, filter, and score tokens
      const acceptedObservations: TokenObservation[] = [];
      const settings = this.db.getSettings();
      const previousTrades = this.db.getTrades();

      for (const [mint, cand] of uniqueMintsMap.entries()) {
        // Race condition check before processing each candidate
        if (generation !== this.discoveryGeneration) {
          console.warn(`[TOKEN_DISCOVERY] Stale generation #${generation} aborted during candidate validation.`);
          this.isRefreshing = false;
          return;
        }

        const obs = await this.evaluateCandidate(mint, cand.source, settings, previousTrades);
        if (obs) {
          acceptedObservations.push(obs);
        }
      }

      // Step 5: Final generation check before replacing feed in database (Requirement 13)
      if (generation !== this.discoveryGeneration) {
        console.warn(`[TOKEN_DISCOVERY] Stale generation #${generation} discarded before feed update.`);
        this.isRefreshing = false;
        return;
      }

      // Step 6: Replace database discovery feed with newly discovered tokens
      this.db.setTokenObservations(acceptedObservations);
      this.lastRefreshAt = Date.now();
      this.nextRefreshAt = this.lastRefreshAt + this.DISCOVERY_REFRESH_INTERVAL;
      this.status = 'SUCCESS';
      this.lastError = null;

      console.log(`[TOKEN_DISCOVERY] Passed filters: ${acceptedObservations.length}`);
      console.log(`[TOKEN_DISCOVERY] Feed replaced: ${acceptedObservations.length}`);
      console.log(`[TOKEN_DISCOVERY] Next refresh in: 120s`);

    } catch (err: any) {
      const errorMsg = err?.message || 'Unknown discovery error';
      console.error(`[TOKEN_DISCOVERY] Refresh failed: ${errorMsg}`);
      
      this.status = 'FAILED';
      this.lastError = errorMsg;
      this.lastRefreshAt = Date.now();
      this.nextRefreshAt = this.lastRefreshAt + this.DISCOVERY_REFRESH_INTERVAL;
    } finally {
      this.isRefreshing = false;
      this.notifyListeners();
    }
  }

  /**
   * Fetches fresh candidate token mints from external DEX streams & monitored trader logs.
   */
  private async fetchFreshCandidates(): Promise<RawTokenCandidate[]> {
    const candidates: RawTokenCandidate[] = [];

    // Source 1: Monitored Trader Wallets Transactions
    try {
      const monitoredTxs = this.db.getMonitoredTransactions();
      for (const tx of monitoredTxs) {
        if (tx.token_mint && isValidSolanaMint(tx.token_mint)) {
          candidates.push({ mint: tx.token_mint, source: 'Monitored Trader Buy' });
        }
      }
    } catch (err) {
      console.warn('[TOKEN_DISCOVERY] Error fetching monitored trader candidates:', err);
    }

    // Source 2: DexScreener Latest Token Boosts (Solana)
    try {
      const boostRes = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (boostRes.ok) {
        const boostData = await boostRes.json();
        if (Array.isArray(boostData)) {
          for (const item of boostData) {
            if (item.chainId === 'solana' && item.tokenAddress && isValidSolanaMint(item.tokenAddress)) {
              candidates.push({ mint: item.tokenAddress, source: 'DexScreener Boosted' });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[TOKEN_DISCOVERY] Could not fetch DexScreener boosts:', err);
    }

    // Source 3: DexScreener Latest Token Profiles (Solana)
    try {
      const profileRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        if (Array.isArray(profileData)) {
          for (const item of profileData) {
            if (item.chainId === 'solana' && item.tokenAddress && isValidSolanaMint(item.tokenAddress)) {
              candidates.push({ mint: item.tokenAddress, source: 'DexScreener Profile' });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[TOKEN_DISCOVERY] Could not fetch DexScreener profiles:', err);
    }

    // Source 4: DexScreener Solana Search Query
    try {
      const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const pairs = searchData.pairs || [];
        for (const pair of pairs) {
          if (pair.chainId === 'solana' && pair.baseToken?.address && isValidSolanaMint(pair.baseToken.address)) {
            candidates.push({ mint: pair.baseToken.address, source: 'DexScreener Trending' });
          }
        }
      }
    } catch (err) {
      console.warn('[TOKEN_DISCOVERY] Could not fetch DexScreener search candidates:', err);
    }

    return candidates;
  }

  /**
   * Evaluates a candidate token through current market metrics, RugCheck security rules,
   * BuyAuthorizationService criteria, and AI scoring.
   */
  private async evaluateCandidate(
    mint: string,
    source: string,
    settings: Settings,
    previousTrades: any[]
  ): Promise<TokenObservation | null> {
    try {
      // 1. Fetch current market metrics from DexScreener
      let tokenName = '';
      let tokenSymbol = '';
      let marketCap: number | 'UNKNOWN' = 'UNKNOWN';
      let liquidity: number | 'UNKNOWN' = 'UNKNOWN';
      let volume24h: number | 'UNKNOWN' = 'UNKNOWN';
      let price: number | 'UNKNOWN' = 'UNKNOWN';

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
        }
      }

      // If key market metrics are completely missing, reject token
      if (!tokenName || !tokenSymbol || marketCap === 'UNKNOWN' || liquidity === 'UNKNOWN' || price === 'UNKNOWN') {
        return null;
      }

      // 2. RugCheck Security Evaluation
      let rugCheck = await getRugCheckReport(mint);
      let rugCheckPassed = false;
      if (settings.enableRugCheck) {
        const rugValidation = validateRugCheck(rugCheck, settings);
        rugCheckPassed = rugValidation.passed;
      } else {
        rugCheckPassed = true;
      }

      // 3. BuyAuthorizationService deterministic criteria evaluation
      const candidateObj = {
        tokenMint: mint,
        tokenName,
        tokenSymbol,
        traderWallet: 'DiscoveryPipeline',
        sourceSignature: 'discovery_' + Date.now(),
        detectedAt: new Date().toISOString(),
        market: {
          tokenMint: mint,
          priceUSD: typeof price === 'number' ? price : 0,
          priceSOL: 0,
          marketCapUSD: typeof marketCap === 'number' ? marketCap : 0,
          liquidityUSD: typeof liquidity === 'number' ? liquidity : 0,
          volumeUSD24h: typeof volume24h === 'number' ? volume24h : 0,
          timestamp: new Date().toISOString(),
          source: 'DexScreener'
        },
        security: {
          developerHoldingPct: 0,
          mintAuthority: rugCheck?.mintAuthority || null,
          freezeAuthority: rugCheck?.freezeAuthority || null,
          lpLocked: rugCheck?.lpLocked || false,
          rugcheckPassed: rugCheckPassed,
          status: rugCheck?.riskLevel || 'Unknown'
        },
        trader: {
          walletAddress: 'DiscoveryPipeline',
          name: source,
          signals: 0,
          paperTrades: 0,
          winRate: 0,
          pnlSol: 0
        }
      };

      const decision = await BuyAuthorizationService.getInstance(this.db).evaluate(candidateObj);

      // 4. AI Cognitive Score Evaluation
      let aiResult: { score: number; confidence?: number; signals: { positive: string[]; risks: string[] } } | null = null;
      try {
        aiResult = await scoreToken({
          token_mint: mint,
          token_name: tokenName,
          token_symbol: tokenSymbol,
          market_cap: marketCap,
          liquidity,
          volume_24h: volume24h,
          developer_holding_percent: 'UNKNOWN',
          buyers_10s: decision.criteria.buyTxCount10s,
          price,
          status: 'WAIT'
        }, previousTrades);
      } catch (err) {
        // AI scoring error fallback
      }

      const isEligible = decision.decision === 'AUTHORIZED' && rugCheckPassed;
      const status = isEligible ? 'ELIGIBLE' : 'REJECT';
      const rejectionReason = decision.rejectReasons.join(', ') || (rugCheckPassed ? undefined : 'RugCheck security check failed');

      const nowMs = Date.now();
      const discoveredAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + this.DISCOVERY_REFRESH_INTERVAL).toISOString();

      return {
        id: 'obs_' + Math.random().toString(36).substring(2, 11),
        token_mint: mint,
        token_name: tokenName,
        token_symbol: tokenSymbol,
        market_cap: marketCap,
        liquidity,
        volume_24h: volume24h,
        developer_holding_percent: 'UNKNOWN',
        buyers_10s: decision.criteria.buyTxCount10s,
        price,
        timestamp: discoveredAt,
        discoveredAt,
        expiresAt,
        status,
        rejection_reason: rejectionReason,
        source_trader_name: source,
        ai_score: aiResult ? aiResult.score : undefined,
        ai_signals: aiResult ? aiResult.signals : undefined,
        rugcheck: rugCheck,
        rugcheck_passed: rugCheckPassed
      };

    } catch (err) {
      console.warn(`[TOKEN_DISCOVERY] Failed evaluation for candidate ${mint}:`, err);
      return null;
    }
  }
}
