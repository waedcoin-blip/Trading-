export interface User {
  id: string;
  created_at: string;
}

export interface Settings {
  id: string;
  user_id: string;
  rpc_url: string;
  backup_rpc_url: string;
  wss_url: string;
  backup_wss_url: string;
  laserstream_key: string;
  jupiter_api_key?: string; // Deprecated/Removed from storage; managed strictly via JUPITER_API_KEY env var
  trading_amount_sol: number;
  take_profit_percent: number;
  stop_loss_percent: number;
  paper_balance_sol: number;
  trading_mode: 'PAPER' | 'MAINNET';
  mainnet_enabled: boolean;

  // RugCheck Security Filter settings
  enableRugCheck: boolean;
  requiredRugStatus: string[];
  maxHolderConcentration: number; // e.g. 20%
  requireLpLocked: boolean;
  requireMintAuthorityRemoved: boolean;
  requireFreezeAuthorityRemoved: boolean;
  maxRiskScore: number; // e.g. 300

  created_at: string;
  updated_at: string;
}

export interface RugCheckRisk {
  name: string;
  value?: string | number;
  description: string;
  score: number;
  level: 'danger' | 'warn' | 'info' | 'critical' | string;
}

export interface RugCheckResult {
  score: number;
  riskLevel: 'Good' | 'Warn' | 'Danger' | 'Critical' | 'Unknown' | string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  lpLocked: boolean;
  lpLockedPct: number;
  topHoldersPct: number;
  risks: RugCheckRisk[];
  status: 'PASSED' | 'FAILED' | 'UNAVAILABLE';
  rejectionReason?: string;
  checkedAt: string;
}

export interface TraderWallet {
  id: string;
  user_id: string;
  name: string;
  wallet_address: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface MonitoredTransaction {
  id: string;
  signature: string;
  trader_wallet_id: string;
  token_mint: string;
  transaction_type: 'BUY' | 'SELL' | 'UNKNOWN';
  sol_amount: number;
  token_amount: number;
  timestamp: string;
  processed_at: string;
}

export interface TokenObservation {
  id: string;
  token_mint: string;
  token_name: string;
  token_symbol: string;
  market_cap: number | 'UNKNOWN';
  liquidity: number | 'UNKNOWN';
  volume_24h: number | 'UNKNOWN';
  developer_holding_percent: number | 'UNKNOWN';
  buyers_10s: number | 'UNKNOWN';
  price: number | 'UNKNOWN';
  timestamp: string;
  status: 'ELIGIBLE' | 'REJECT' | 'WAIT';
  rejection_reason?: string;
  source_trader_name?: string;
  ai_score?: number;
  ai_signals?: {
    positive: string[];
    risks: string[];
  };
  rugcheck?: RugCheckResult;
  rugcheck_passed?: boolean;
}

export interface ActivePosition {
  mint: string;
  symbol?: string;

  tokenQuantity: string;
  tokenDecimals: number;

  entryPrice: string;
  investedAmount: string;

  currentPrice?: string;
  currentValue?: string;

  unrealizedPnl?: string;
  unrealizedPnlPercent?: string;

  buySignature?: string;
  network: 'mainnet-beta';
}

export interface Position extends ActivePosition {
  id: string;
  user_id: string;
  token_mint: string;
  token_name: string;
  token_symbol: string;
  source_trader_id: string;
  source_trader_name: string;
  buy_signature: string;

  // Exact token quantity bought and remaining
  tokenQuantity: string;
  remainingTokenQuantity: string;
  remainingQuantity?: string;
  tokenDecimals: number;

  // Rebuy breakdown
  initialBuyQuantity?: string;
  rebuyQuantity?: string;
  totalBoughtQuantity?: string;
  isRebuy?: boolean;
  tradeNumber?: number;

  entry_price: number; // in SOL per token
  entryPrice: string;
  sol_in: number; // SOL invested
  raw_sol_in: string; // lamports (as string for safety)
  investedAmount: string;
  token_amount: number; // Decimals-adjusted
  raw_token_amount: string; // raw token units
  token_decimals: number;
  buy_time: string;
  current_price: number; // in SOL per token
  currentPrice?: string;
  current_value_sol: number;
  currentValue?: string;
  unrealized_pnl_sol: number;
  unrealizedPnl?: string;
  unrealized_pnl_percent: number;
  unrealizedPnlPercent?: string;
  network: 'mainnet-beta';
  status: 'ACTIVE' | 'SOLD' | 'ERROR';
  data_error?: boolean;
  data_error_message?: string;
  take_profit_percent: number;
  stop_loss_percent: number;
  rugcheck?: RugCheckResult;
  created_at: string;
  updated_at: string;

  // Real-time metadata
  priceUpdatedAt?: number;
  priceSource?: 'jupiter' | 'fallback';
  isStale?: boolean;
}

export interface Trade {
  id: string;
  user_id: string;
  position_id: string;
  token_mint: string;
  token_name: string;
  token_symbol: string;
  source_trader_id: string;
  source_trader_name: string;
  buy_signature: string;
  sell_signature: string;
  sol_in: number;
  token_amount_bought: number;
  tokenQuantityBought?: string;
  token_amount_sold: number;
  tokenQuantitySold?: string;
  remainingQuantity?: string;
  sol_out: number;
  entry_price: number;
  exit_price: number;
  buy_time: string;
  sell_time: string;
  pnl_sol: number;
  pnl_percent: number;
  sell_reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL' | 'PARTIAL' | 'ERROR_RECOVERY';
  mode: 'PAPER' | 'MAINNET';
  tradeNumber?: number;
  isRebuy?: boolean;
  created_at: string;
}

export interface AISignals {
  positive: string[];
  risks: string[];
}

export interface AIStats {
  tradesAnalyzed: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  averageWinnerSol: number;
  averageLoserSol: number;
  bestConditions: string[];
  riskConditions: string[];
}

export interface ConnectionStatus {
  rpc: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR';
  wss: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR';
  laserstream: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR';
  jupiter: 'CONNECTED' | 'INVALID_API_KEY' | 'RATE_LIMITED' | 'CONNECTION_ERROR' | 'NOT_CONFIGURED';
}

export interface TradeAuditRecord {
  mint: string;
  positionId: string;
  tokenQuantity?: string;
  remainingQuantity?: string;
  entryPrice: number;
  exitPrice: number;
  entryCost: number;
  exitProceeds: number;
  fees: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  tradeNumber: number; // 1 for initial buy, 2 for rebuy
  isRebuy: boolean;
  timestamp: string;
  reason: string;
}

export interface RebuyState {
  mint: string;
  initialBuyCount: number;
  initialBuyQuantity?: string;
  rebuyCount: number;
  rebuyQuantity?: string;
  totalBoughtQuantity?: string;
  profitableExits: number;
  losingExits: number;
  rebuyBlocked: boolean;
  lastRealizedPnl: number;
  lastRealizedPnlPercent: number;
  lastExitTimestamp?: string;
  activePosition: boolean;
  history: TradeAuditRecord[];
}

export interface RebuyDecision {
  allowed: boolean;
  type?: 'INITIAL_BUY' | 'ONE_PROFITABLE_REBUY';
  reason?: string;
  state?: RebuyState;
}

export interface ServerState {
  settings: Settings;
  traders: TraderWallet[];
  observations: TokenObservation[];
  positions: Position[];
  trades: Trade[];
  connection: ConnectionStatus;
  aiStats: AIStats;
  rebuyStates: Record<string, RebuyState>;
}
