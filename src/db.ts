import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { 
  Settings, 
  TraderWallet, 
  MonitoredTransaction, 
  TokenObservation, 
  Position, 
  Trade, 
  AIStats,
  RebuyState
} from './types';
import { isValidSolanaMint, formatTokenQuantity } from './utils';

const DB_PATH = path.join(process.cwd(), 'db.json');

interface DatabaseSchema {
  settings: Settings;
  trader_wallets: TraderWallet[];
  monitored_transactions: MonitoredTransaction[];
  token_observations: TokenObservation[];
  positions: Position[];
  trades: Trade[];
  rebuy_states: Record<string, RebuyState>;
}

const DEFAULT_SETTINGS: Settings = {
  id: 'default-settings',
  user_id: 'default-user',
  rpc_url: 'https://api.mainnet-beta.solana.com',
  backup_rpc_url: '',
  wss_url: 'wss://api.mainnet-beta.solana.com',
  backup_wss_url: '',
  laserstream_key: '',
  jupiter_api_key: '',
  trading_amount_sol: 0.25,
  take_profit_percent: 30,
  stop_loss_percent: 10,
  paper_balance_sol: 10.0,
  trading_mode: 'PAPER',
  mainnet_enabled: false,

  // RugCheck defaults
  enableRugCheck: true,
  requiredRugStatus: ['Good'],
  maxHolderConcentration: 20,
  requireLpLocked: true,
  requireMintAuthorityRemoved: true,
  requireFreezeAuthorityRemoved: true,
  maxRiskScore: 300,

  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

const INITIAL_DB: DatabaseSchema = {
  settings: DEFAULT_SETTINGS,
  trader_wallets: [],
  monitored_transactions: [],
  token_observations: [],
  positions: [],
  trades: [],
  rebuy_states: {}
};

export class Database {
  private cache: DatabaseSchema | null = null;
  private dbPath: string;

  constructor(customPath: string = DB_PATH) {
    this.dbPath = customPath;
    this.init();
  }

  private init() {
    try {
      if (!fs.existsSync(this.dbPath)) {
        this.write(INITIAL_DB);
        this.cache = INITIAL_DB;
      } else {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.cache = this.sanitizeDatabase(parsed);
        this.save();
      }
    } catch (err) {
      console.error('Failed to initialize database, resetting to clean state', err);
      this.write(INITIAL_DB);
      this.cache = INITIAL_DB;
    }
  }

  /**
   * Sanitizes database records: purges any legacy fake mints, simulated signatures, or corrupted placeholders
   */
  private sanitizeDatabase(data: any): DatabaseSchema {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...(data?.settings || {})
    };

    const trader_wallets = Array.isArray(data?.trader_wallets)
      ? data.trader_wallets.filter((w: any) => isValidSolanaMint(w.wallet_address))
      : [];

    const monitored_transactions = Array.isArray(data?.monitored_transactions)
      ? data.monitored_transactions.filter((tx: any) => 
          tx && 
          !tx.signature?.startsWith('sim_sig_') &&
          isValidSolanaMint(tx.token_mint)
        )
      : [];

    const token_observations = Array.isArray(data?.token_observations)
      ? data.token_observations.filter((obs: any) => 
          obs && 
          isValidSolanaMint(obs.token_mint) &&
          obs.token_name !== 'Unknown Token' &&
          obs.token_symbol !== 'UNKWN'
        )
      : [];

    const positions = Array.isArray(data?.positions)
      ? data.positions
          .filter((pos: any) => 
            pos && 
            isValidSolanaMint(pos.token_mint || pos.mint) &&
            !pos.buy_signature?.startsWith('sim_sig_')
          )
          .map((pos: any) => {
            const tokenMint = pos.token_mint || pos.mint;
            const tokenAmount = typeof pos.token_amount === 'number' ? pos.token_amount : 0;
            const decimals = typeof pos.token_decimals === 'number' 
              ? pos.token_decimals 
              : (typeof pos.tokenDecimals === 'number' ? pos.tokenDecimals : 6);
            const tokenQuantity = pos.tokenQuantity || formatTokenQuantity(tokenAmount, decimals);
            const remainingTokenQuantity = pos.remainingTokenQuantity || pos.remainingQuantity || tokenQuantity;
            const solIn = typeof pos.sol_in === 'number' ? pos.sol_in : 0;
            const entryPrice = typeof pos.entry_price === 'number' ? pos.entry_price : 0;
            const currentPrice = typeof pos.current_price === 'number' ? pos.current_price : entryPrice;
            const currentValueSol = typeof pos.current_value_sol === 'number' ? pos.current_value_sol : solIn;
            const pnlSol = typeof pos.unrealized_pnl_sol === 'number' ? pos.unrealized_pnl_sol : 0;
            const pnlPercent = typeof pos.unrealized_pnl_percent === 'number' ? pos.unrealized_pnl_percent : 0;

            return {
              ...pos,
              token_mint: tokenMint,
              mint: tokenMint,
              symbol: pos.symbol || pos.token_symbol,
              token_symbol: pos.token_symbol || pos.symbol || '',
              token_name: pos.token_name || 'Token',
              tokenQuantity,
              remainingTokenQuantity,
              remainingQuantity: remainingTokenQuantity,
              tokenDecimals: decimals,
              token_decimals: decimals,
              entryPrice: pos.entryPrice || `${entryPrice.toFixed(10)} SOL`,
              entry_price: entryPrice,
              investedAmount: pos.investedAmount || `${solIn.toFixed(4)} SOL`,
              sol_in: solIn,
              current_price: currentPrice,
              currentPrice: pos.currentPrice || `${currentPrice.toFixed(10)} SOL`,
              current_value_sol: currentValueSol,
              currentValue: pos.currentValue || `${currentValueSol.toFixed(4)} SOL`,
              unrealized_pnl_sol: pnlSol,
              unrealizedPnl: pos.unrealizedPnl || `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`,
              unrealized_pnl_percent: pnlPercent,
              unrealizedPnlPercent: pos.unrealizedPnlPercent || `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
              network: pos.network || 'mainnet-beta',
              buySignature: pos.buySignature || pos.buy_signature || '',
              buy_signature: pos.buy_signature || pos.buySignature || '',
              status: pos.status || 'ACTIVE'
            };
          })
      : [];

    const trades = Array.isArray(data?.trades)
      ? data.trades.filter((trade: any) => 
          trade && 
          isValidSolanaMint(trade.token_mint) &&
          !trade.buy_signature?.startsWith('sim_sig_') &&
          !trade.sell_signature?.startsWith('sim_sig_')
        )
      : [];

    const rebuy_states: Record<string, RebuyState> = {};
    if (data?.rebuy_states && typeof data.rebuy_states === 'object') {
      for (const [mint, state] of Object.entries(data.rebuy_states)) {
        if (isValidSolanaMint(mint) && state && typeof state === 'object') {
          const s = state as any;
          rebuy_states[mint] = {
            mint,
            initialBuyCount: typeof s.initialBuyCount === 'number' ? s.initialBuyCount : 0,
            rebuyCount: typeof s.rebuyCount === 'number' ? s.rebuyCount : 0,
            profitableExits: typeof s.profitableExits === 'number' ? s.profitableExits : 0,
            losingExits: typeof s.losingExits === 'number' ? s.losingExits : 0,
            rebuyBlocked: Boolean(s.rebuyBlocked),
            lastRealizedPnl: typeof s.lastRealizedPnl === 'number' ? s.lastRealizedPnl : 0,
            lastRealizedPnlPercent: typeof s.lastRealizedPnlPercent === 'number' ? s.lastRealizedPnlPercent : 0,
            lastExitTimestamp: s.lastExitTimestamp,
            activePosition: Boolean(s.activePosition),
            history: Array.isArray(s.history) ? s.history : []
          };
        }
      }
    }

    return {
      settings,
      trader_wallets,
      monitored_transactions,
      token_observations,
      positions,
      trades,
      rebuy_states
    };
  }

  private write(data: DatabaseSchema) {
    const tmpPath = `${this.dbPath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.dbPath);
    } catch (err) {
      console.error('Atomic write failed, writing directly', err);
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), 'utf8');
    }
  }

  private save() {
    if (this.cache) {
      this.write(this.cache);
    }
  }

  public getSettings(): Settings {
    if (!this.cache) this.init();
    return this.cache!.settings;
  }

  public updateSettings(updates: Partial<Settings>): Settings {
    if (!this.cache) this.init();
    this.cache!.settings = {
      ...this.cache!.settings,
      ...updates,
      updated_at: new Date().toISOString()
    };
    this.save();
    return this.cache!.settings;
  }

  public getTraderWallets(): TraderWallet[] {
    if (!this.cache) this.init();
    return this.cache!.trader_wallets;
  }

  public addTraderWallet(wallet: Omit<TraderWallet, 'id' | 'user_id' | 'created_at' | 'updated_at'>): TraderWallet {
    if (!this.cache) this.init();
    if (!isValidSolanaMint(wallet.wallet_address)) {
      throw new Error(`Invalid Solana wallet address: ${wallet.wallet_address}`);
    }

    const newWallet: TraderWallet = {
      id: crypto.randomUUID(),
      user_id: 'default-user',
      ...wallet,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.cache!.trader_wallets.push(newWallet);
    this.save();
    return newWallet;
  }

  public updateTraderWallet(id: string, updates: Partial<Omit<TraderWallet, 'id' | 'user_id' | 'created_at'>>): TraderWallet | null {
    if (!this.cache) this.init();
    const idx = this.cache!.trader_wallets.findIndex(w => w.id === id);
    if (idx === -1) return null;
    this.cache!.trader_wallets[idx] = {
      ...this.cache!.trader_wallets[idx],
      ...updates,
      updated_at: new Date().toISOString()
    };
    this.save();
    return this.cache!.trader_wallets[idx];
  }

  public deleteTraderWallet(id: string): boolean {
    if (!this.cache) this.init();
    const originalLen = this.cache!.trader_wallets.length;
    this.cache!.trader_wallets = this.cache!.trader_wallets.filter(w => w.id !== id);
    const deleted = this.cache!.trader_wallets.length < originalLen;
    if (deleted) this.save();
    return deleted;
  }

  public getMonitoredTransactions(): MonitoredTransaction[] {
    if (!this.cache) this.init();
    return this.cache!.monitored_transactions;
  }

  public addMonitoredTransaction(tx: Omit<MonitoredTransaction, 'id' | 'processed_at'>): MonitoredTransaction | null {
    if (!this.cache) this.init();
    if (!isValidSolanaMint(tx.token_mint)) {
      console.warn(`[DB] Refused to record transaction with invalid/fake mint: ${tx.token_mint}`);
      return null;
    }

    const newTx: MonitoredTransaction = {
      id: crypto.randomUUID(),
      ...tx,
      processed_at: new Date().toISOString()
    };
    this.cache!.monitored_transactions.push(newTx);
    // Keep last 1000 for storage limits
    if (this.cache!.monitored_transactions.length > 1000) {
      this.cache!.monitored_transactions.shift();
    }
    this.save();
    return newTx;
  }

  public getTokenObservations(): TokenObservation[] {
    if (!this.cache) this.init();
    return this.cache!.token_observations;
  }

  public addTokenObservation(obs: Omit<TokenObservation, 'id' | 'timestamp'>): TokenObservation | null {
    if (!this.cache) this.init();
    if (!isValidSolanaMint(obs.token_mint)) {
      console.warn(`[DB] Refused to add observation with invalid/fake mint: ${obs.token_mint}`);
      return null;
    }

    const newObs: TokenObservation = {
      id: crypto.randomUUID(),
      ...obs,
      timestamp: new Date().toISOString()
    };
    this.cache!.token_observations.push(newObs);
    // Limit cache length to 100
    if (this.cache!.token_observations.length > 100) {
      this.cache!.token_observations.shift();
    }
    this.save();
    return newObs;
  }

  public getPositions(): Position[] {
    if (!this.cache) this.init();
    return this.cache!.positions;
  }

  public addPosition(pos: Omit<Position, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Position | null {
    if (!this.cache) this.init();
    const tokenMint = pos.token_mint || pos.mint;
    if (!isValidSolanaMint(tokenMint)) {
      console.warn(`[DB] Refused to create position with invalid/fake mint: ${tokenMint}`);
      return null;
    }

    const decimals = typeof pos.tokenDecimals === 'number' 
      ? pos.tokenDecimals 
      : (typeof pos.token_decimals === 'number' ? pos.token_decimals : 6);
    const tokenQuantity = pos.tokenQuantity || formatTokenQuantity(pos.token_amount, decimals);
    const remainingTokenQuantity = pos.remainingTokenQuantity || pos.remainingQuantity || tokenQuantity;

    const newPos: Position = {
      id: crypto.randomUUID(),
      user_id: 'default-user',
      ...pos,
      token_mint: tokenMint,
      mint: tokenMint,
      token_symbol: pos.token_symbol || pos.symbol || '',
      symbol: pos.symbol || pos.token_symbol || '',
      tokenQuantity,
      remainingTokenQuantity,
      remainingQuantity: remainingTokenQuantity,
      tokenDecimals: decimals,
      token_decimals: decimals,
      entryPrice: pos.entryPrice || `${pos.entry_price.toFixed(10)} SOL`,
      investedAmount: pos.investedAmount || `${pos.sol_in.toFixed(4)} SOL`,
      network: pos.network || 'mainnet-beta',
      buySignature: pos.buySignature || pos.buy_signature || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.cache!.positions.push(newPos);
    this.save();
    return newPos;
  }

  public updatePosition(id: string, updates: Partial<Omit<Position, 'id' | 'user_id' | 'created_at'>>): Position | null {
    if (!this.cache) this.init();
    const idx = this.cache!.positions.findIndex(p => p.id === id);
    if (idx === -1) return null;
    this.cache!.positions[idx] = {
      ...this.cache!.positions[idx],
      ...updates,
      updated_at: new Date().toISOString()
    };
    this.save();
    return this.cache!.positions[idx];
  }

  public deletePosition(id: string): boolean {
    if (!this.cache) this.init();
    const originalLen = this.cache!.positions.length;
    this.cache!.positions = this.cache!.positions.filter(p => p.id !== id);
    const deleted = this.cache!.positions.length < originalLen;
    if (deleted) this.save();
    return deleted;
  }

  public getTrades(): Trade[] {
    if (!this.cache) this.init();
    return this.cache!.trades;
  }

  public addTrade(trade: Omit<Trade, 'id' | 'user_id' | 'created_at'>): Trade | null {
    if (!this.cache) this.init();
    if (!isValidSolanaMint(trade.token_mint)) {
      console.warn(`[DB] Refused to record trade with invalid/fake mint: ${trade.token_mint}`);
      return null;
    }

    const newTrade: Trade = {
      id: crypto.randomUUID(),
      user_id: 'default-user',
      ...trade,
      created_at: new Date().toISOString()
    };
    this.cache!.trades.push(newTrade);
    this.save();
    return newTrade;
  }

  public getAIStats(): AIStats {
    const trades = this.getTrades().filter(t => t.mode === 'PAPER');
    const total = trades.length;
    if (total === 0) {
      return {
        tradesAnalyzed: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        averageWinnerSol: 0,
        averageLoserSol: 0,
        bestConditions: ['No paper trades recorded yet'],
        riskConditions: ['No paper trades recorded yet']
      };
    }

    const wins = trades.filter(t => t.pnl_sol > 0);
    const losses = trades.filter(t => t.pnl_sol <= 0);
    
    const winRate = Math.round((wins.length / total) * 100);
    
    const totalWinsSol = wins.reduce((acc, t) => acc + t.pnl_sol, 0);
    const totalLossesSol = losses.reduce((acc, t) => acc + t.pnl_sol, 0);
    
    const averageWinnerSol = wins.length > 0 ? Number((totalWinsSol / wins.length).toFixed(4)) : 0;
    const averageLoserSol = losses.length > 0 ? Number((totalLossesSol / losses.length).toFixed(4)) : 0;

    const bestConditions: string[] = [];
    const riskConditions: string[] = [];

    if (winRate > 50) {
      bestConditions.push('High short-term momentum (Buyers > 15/10s)');
      bestConditions.push('Developer holding < 2.5%');
    } else {
      bestConditions.push('Steady support and high liquidity (> $10k)');
    }

    if (losses.length > wins.length) {
      riskConditions.push('Low liquidity tokens near floor ($4,000 - $6,000)');
      riskConditions.push('Tokens with high developer holdings (> 4%)');
    } else {
      riskConditions.push('Sudden buyer spikes (possible pump and dump)');
    }

    return {
      tradesAnalyzed: total,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate,
      averageWinnerSol,
      averageLoserSol,
      bestConditions,
      riskConditions
    };
  }

  public getRebuyStates(): Record<string, RebuyState> {
    if (!this.cache) this.init();
    if (!this.cache!.rebuy_states) {
      this.cache!.rebuy_states = {};
    }
    return this.cache!.rebuy_states;
  }

  public getRebuyState(mint: string): RebuyState | null {
    if (!this.cache) this.init();
    if (!this.cache!.rebuy_states) {
      this.cache!.rebuy_states = {};
    }
    return this.cache!.rebuy_states[mint] || null;
  }

  public setRebuyState(mint: string, state: RebuyState): void {
    if (!this.cache) this.init();
    if (!isValidSolanaMint(mint)) {
      console.warn(`[DB] Refused to save rebuy state for invalid mint: ${mint}`);
      return;
    }
    if (!this.cache!.rebuy_states) {
      this.cache!.rebuy_states = {};
    }
    this.cache!.rebuy_states[mint] = {
      ...state,
      mint
    };
    this.save();
  }

  /**
   * Atomically resets Profitable-Only Rebuy Guard Matrix and Completed Trade History.
   * Leaves active positions, balances, settings, and wallets untouched.
   */
  public resetGuardAndHistory(): { completedTrades: number; rebuyGuardEntries: number; resetAt: string } {
    if (!this.cache) this.init();

    const completedTradesCount = (this.cache!.trades || []).length;
    const rebuyEntriesCount = Object.keys(this.cache!.rebuy_states || {}).length;

    this.cache!.trades = [];
    this.cache!.rebuy_states = {};
    this.save();

    console.log(`[DB] ATOMIC RESET: Cleared ${completedTradesCount} completed trades and ${rebuyEntriesCount} rebuy guard matrix records.`);

    return {
      completedTrades: 0,
      rebuyGuardEntries: 0,
      resetAt: new Date().toISOString()
    };
  }
}

export const db = new Database();

