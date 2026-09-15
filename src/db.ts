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
  RebuyState,
  LearningRecord
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
  learning_records: Record<string, LearningRecord>;
}

const DEFAULT_SETTINGS: Settings = {
  id: 'default-settings',
  user_id: 'default-user',
  rpc_url: 'https://api.mainnet-beta.solana.com',
  backup_rpc_url: '',
  wss_url: 'wss://api.mainnet-beta.solana.com',
  backup_wss_url: '',
  laserstream_key: '',
  trading_amount_sol: 0.25,
  take_profit_percent: 30,
  stop_loss_percent: 10,
  paper_balance_sol: 10.0,
  trading_mode: 'PAPER',
  mainnet_enabled: false,

  // AI score threshold
  min_ai_score_to_buy: 55,

  // Trailing stop & Time/stagnation exit defaults
  enable_trailing_stop: true,
  trailing_stop_activation_percent: 15,
  trailing_stop_percent: 10,
  enable_time_exit: true,
  max_hold_minutes: 30,
  stagnant_pnl_threshold_percent: 5,

  // RugCheck defaults
  enableRugCheck: true,
  requiredRugStatus: ['Good', 'Warn'],
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
  rebuy_states: {},
  learning_records: {}
};

export class Database {
  private cache: DatabaseSchema | null = null;
  private dbPath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingWrite = false;
  private static readonly DEBOUNCE_MS = 1500;

  constructor(customPath: string = DB_PATH) {
    this.dbPath = customPath;
    this.init();

    const flushOnExit = () => {
      if (this.pendingWrite && this.cache) {
        this.save(true);
      }
    };
    process.on('beforeExit', flushOnExit);
    process.on('SIGINT', flushOnExit);
    process.on('SIGTERM', flushOnExit);
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
   * and removes any stored API keys.
   */
  private sanitizeDatabase(data: any): DatabaseSchema {
    const rawSettings = data?.settings || {};
    // Strip jupiter_api_key from settings
    delete rawSettings.jupiter_api_key;

    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...rawSettings
    };
    delete settings.jupiter_api_key;

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
              network: 'mainnet-beta',
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

    const learning_records: Record<string, LearningRecord> = {};
    if (data?.learning_records && typeof data.learning_records === 'object') {
      for (const [id, rec] of Object.entries(data.learning_records)) {
        if (rec && typeof rec === 'object' && (rec as any).tradeId && isValidSolanaMint((rec as any).mint)) {
          learning_records[id] = rec as LearningRecord;
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
      rebuy_states,
      learning_records
    };
  }

  private read(): DatabaseSchema {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = this.sanitizeDatabase(parsed);
      return this.cache;
    } catch {
      this.cache = INITIAL_DB;
      return INITIAL_DB;
    }
  }

  private write(data: DatabaseSchema) {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), 'utf8');
      this.cache = data;
    } catch (err) {
      console.error(`Failed to write database file at ${this.dbPath}`, err);
    }
  }

  private save(immediate: boolean = true) {
    if (immediate) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.pendingWrite = false;
      if (this.cache) {
        this.write(this.cache);
      }
    } else {
      this.pendingWrite = true;
      if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          if (this.pendingWrite && this.cache) {
            this.pendingWrite = false;
            this.write(this.cache);
          }
        }, Database.DEBOUNCE_MS);
      }
    }
  }

  // --- Settings ---
  public getSettings(): Settings {
    return { ...this.read().settings };
  }

  public updateSettings(partial: Partial<Settings>): Settings {
    const current = this.read();
    const cleanPartial = { ...partial };
    delete cleanPartial.jupiter_api_key;

    current.settings = {
      ...current.settings,
      ...cleanPartial,
      updated_at: new Date().toISOString()
    };
    delete current.settings.jupiter_api_key;
    this.save();
    return { ...current.settings };
  }

  // --- Trader Wallets ---
  public getTraderWallets(): TraderWallet[] {
    return [...this.read().trader_wallets];
  }

  public addTraderWallet(wallet: Omit<TraderWallet, 'id' | 'user_id' | 'created_at' | 'updated_at'>): TraderWallet {
    if (!isValidSolanaMint(wallet.wallet_address)) {
      throw new Error('Invalid Solana Public Key wallet address.');
    }

    const current = this.read();
    const now = new Date().toISOString();
    const newWallet: TraderWallet = {
      ...wallet,
      id: 'wallet_' + Math.random().toString(36).substring(2, 11),
      user_id: 'default-user',
      created_at: now,
      updated_at: now
    };

    current.trader_wallets.push(newWallet);
    this.save();
    return newWallet;
  }

  public updateTraderWallet(id: string, partial: Partial<TraderWallet>): TraderWallet | null {
    const current = this.read();
    const idx = current.trader_wallets.findIndex(w => w.id === id);
    if (idx === -1) return null;

    if (partial.wallet_address && !isValidSolanaMint(partial.wallet_address)) {
      throw new Error('Invalid Solana Public Key wallet address.');
    }

    current.trader_wallets[idx] = {
      ...current.trader_wallets[idx],
      ...partial,
      updated_at: new Date().toISOString()
    };
    this.save();
    return { ...current.trader_wallets[idx] };
  }

  public deleteTraderWallet(id: string): boolean {
    const current = this.read();
    const initialLength = current.trader_wallets.length;
    current.trader_wallets = current.trader_wallets.filter(w => w.id !== id);
    if (current.trader_wallets.length !== initialLength) {
      this.save();
      return true;
    }
    return false;
  }

  // --- Monitored Transactions ---
  public getMonitoredTransactions(): MonitoredTransaction[] {
    return [...this.read().monitored_transactions];
  }

  public addMonitoredTransaction(tx: Omit<MonitoredTransaction, 'id' | 'processed_at'>): MonitoredTransaction {
    if (!isValidSolanaMint(tx.token_mint)) {
      throw new Error('Invalid token mint for monitored transaction.');
    }

    const current = this.read();
    const newTx: MonitoredTransaction = {
      ...tx,
      id: 'tx_' + Math.random().toString(36).substring(2, 11),
      processed_at: new Date().toISOString()
    };

    current.monitored_transactions.unshift(newTx);
    // Keep last 100
    if (current.monitored_transactions.length > 100) {
      current.monitored_transactions = current.monitored_transactions.slice(0, 100);
    }
    this.save();
    return newTx;
  }

  // --- Token Observations ---
  public getTokenObservations(): TokenObservation[] {
    return [...this.read().token_observations];
  }

  public addTokenObservation(obs: Omit<TokenObservation, 'id' | 'timestamp'>): TokenObservation {
    if (!isValidSolanaMint(obs.token_mint)) {
      throw new Error('Invalid token mint for observation.');
    }

    const current = this.read();
    const newObs: TokenObservation = {
      ...obs,
      id: 'obs_' + Math.random().toString(36).substring(2, 11),
      timestamp: new Date().toISOString()
    };

    current.token_observations.unshift(newObs);
    // Keep last 100
    if (current.token_observations.length > 100) {
      current.token_observations = current.token_observations.slice(0, 100);
    }
    this.save();
    return newObs;
  }

  // --- Positions ---
  public getPositions(): Position[] {
    return [...this.read().positions];
  }

  public addPosition(pos: Omit<Position, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Position {
    const mint = pos.token_mint || pos.mint;
    if (!isValidSolanaMint(mint)) {
      throw new Error('Invalid token mint for position.');
    }

    const current = this.read();
    const now = new Date().toISOString();
    const newPos: Position = {
      ...pos,
      id: 'pos_' + Math.random().toString(36).substring(2, 11),
      user_id: 'default-user',
      token_mint: mint,
      mint: mint,
      network: 'mainnet-beta',
      created_at: now,
      updated_at: now
    };

    current.positions.unshift(newPos);
    this.save();
    return newPos;
  }

  public updatePosition(id: string, partial: Partial<Position>): Position | null {
    const current = this.read();
    const idx = current.positions.findIndex(p => p.id === id);
    if (idx === -1) return null;

    current.positions[idx] = {
      ...current.positions[idx],
      ...partial,
      updated_at: new Date().toISOString()
    };
    this.save(false);
    return { ...current.positions[idx] };
  }

  public deletePosition(id: string): boolean {
    const current = this.read();
    const initialLen = current.positions.length;
    current.positions = current.positions.filter(p => p.id !== id);
    if (current.positions.length !== initialLen) {
      this.save();
      return true;
    }
    return false;
  }

  // --- Trades ---
  public getTrades(): Trade[] {
    return [...this.read().trades];
  }

  public addTrade(trade: Omit<Trade, 'id' | 'user_id' | 'created_at'>): Trade {
    if (!isValidSolanaMint(trade.token_mint)) {
      throw new Error('Invalid token mint for completed trade.');
    }

    const current = this.read();
    const newTrade: Trade = {
      ...trade,
      id: 'trd_' + Math.random().toString(36).substring(2, 11),
      user_id: 'default-user',
      created_at: new Date().toISOString()
    };

    current.trades.unshift(newTrade);
    this.save();
    return newTrade;
  }

  // --- Rebuy States ---
  public getRebuyStates(): Record<string, RebuyState> {
    return { ...this.read().rebuy_states };
  }

  public getRebuyState(mint: string): RebuyState | undefined {
    return this.read().rebuy_states[mint];
  }

  public setRebuyState(mint: string, state: RebuyState): RebuyState {
    return this.updateRebuyState(mint, state);
  }

  public updateRebuyState(mint: string, state: RebuyState): RebuyState {
    if (!isValidSolanaMint(mint)) {
      throw new Error('Invalid token mint for RebuyState.');
    }

    const current = this.read();
    current.rebuy_states[mint] = { ...state, mint };
    this.save();
    return { ...current.rebuy_states[mint] };
  }

  public resetGuardAndHistory(): { completedTrades: number; rebuyGuardEntries: number; resetAt: string } {
    return this.resetRebuyStatesAndHistory();
  }

  // --- Learning Records ---
  public getLearningRecords(): Record<string, LearningRecord> {
    return { ...this.read().learning_records };
  }

  public getLearningRecord(tradeId: string): LearningRecord | undefined {
    return this.read().learning_records[tradeId];
  }

  public addLearningRecord(record: LearningRecord): LearningRecord {
    if (!isValidSolanaMint(record.mint)) {
      throw new Error('Invalid token mint for LearningRecord.');
    }
    const current = this.read();
    current.learning_records[record.tradeId] = record;
    this.save();
    return { ...record };
  }

  public resetLearningRecords(): { recordsCleared: number; resetAt: string } {
    const current = this.read();
    const recordsCleared = Object.keys(current.learning_records).length;
    const now = new Date().toISOString();
    current.learning_records = {};
    this.save();
    return {
      recordsCleared,
      resetAt: now
    };
  }

  public resetRebuyStatesAndHistory(): { completedTrades: number; rebuyGuardEntries: number; resetAt: string } {
    const current = this.read();
    const completedTradesCount = current.trades.length;
    const rebuyGuardCount = Object.keys(current.rebuy_states).length;
    const now = new Date().toISOString();

    current.trades = [];
    current.rebuy_states = {};

    this.save();
    return {
      completedTrades: completedTradesCount,
      rebuyGuardEntries: rebuyGuardCount,
      resetAt: now
    };
  }

  // --- AI Stats Calculation ---
  public getAIStats(): AIStats {
    const trades = this.getTrades();
    if (trades.length === 0) {
      return {
        tradesAnalyzed: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        averageWinnerSol: 0,
        averageLoserSol: 0,
        bestConditions: [
          'Liquidity > $10,000',
          'Market Cap > $20,000',
          'RugCheck PASSED (LP Locked + Authorities Revoked)',
          'High 10s Buyer Velocity (>15 buyers)',
          'Single profitable rebuy rule active'
        ],
        riskConditions: [
          'Developer holding >= 5%',
          'RugCheck WARN/DANGER (Mint or Freeze authority active)',
          'Liquidity <= $4,000',
          'Multiple losing exits detected'
        ]
      };
    }

    const winning = trades.filter(t => t.pnl_sol > 0);
    const losing = trades.filter(t => t.pnl_sol < 0);

    const winRate = Number(((winning.length / trades.length) * 100).toFixed(1));
    const avgWinner = winning.length > 0 
      ? Number((winning.reduce((acc, t) => acc + t.pnl_sol, 0) / winning.length).toFixed(4))
      : 0;
    const avgLoser = losing.length > 0 
      ? Number((losing.reduce((acc, t) => acc + t.pnl_sol, 0) / losing.length).toFixed(4))
      : 0;

    return {
      tradesAnalyzed: trades.length,
      winningTrades: winning.length,
      losingTrades: losing.length,
      winRate,
      averageWinnerSol: avgWinner,
      averageLoserSol: avgLoser,
      bestConditions: [
        'Liquidity > $10,000',
        'Market Cap > $20,000',
        'RugCheck PASSED (LP Locked + Authorities Revoked)',
        'High 10s Buyer Velocity (>15 buyers)',
        'Single profitable rebuy rule active'
      ],
      riskConditions: [
        'Developer holding >= 5%',
        'RugCheck WARN/DANGER (Mint or Freeze authority active)',
        'Liquidity <= $4,000',
        'Multiple losing exits detected'
      ]
    };
  }
}

export const db = new Database();
