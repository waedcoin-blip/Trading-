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

  // AI score threshold
  min_ai_score_to_buy: number;

  // Trailing stop & Time/stagnation exit settings
  enable_trailing_stop: boolean;
  trailing_stop_activation_percent: number;
  trailing_stop_percent: number;
  enable_time_exit: boolean;
  max_hold_minutes: number;
  stagnant_pnl_threshold_percent: number;

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
  discoveredAt?: string;
  expiresAt?: string;
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

  // Trailing stop tracking
  peak_pnl_percent?: number;
  peak_price?: number;
  trailing_stop_armed?: boolean;

  // Entry snapshot for AI learning
  ai_score_at_entry?: number;
  ai_confidence_at_entry?: number;
  ai_signals_at_entry?: { positive: string[]; risks: string[] };
  market_cap_at_entry?: number | 'UNKNOWN';
  liquidity_at_entry?: number | 'UNKNOWN';
  volume_24h_at_entry?: number | 'UNKNOWN';
  buyers_10s_at_entry?: number | 'UNKNOWN';
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
  sell_reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'STAGNANT' | 'MANUAL' | 'PARTIAL' | 'ERROR_RECOVERY';
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

export interface LearningRecord {
  tradeId: string;
  network: string;
  mint: string;
  symbol: string;
  sourceTraderId: string;
  sourceTraderName: string;

  entryPrice: number;
  exitPrice: number;
  quantity: number;

  realizedPnL: number;
  realizedPnLPercent: number;
  holdingDuration: number; // in seconds

  aiScoreAtEntry: number;
  aiConfidenceAtEntry: number;

  marketCapAtEntry: number | 'UNKNOWN';
  liquidityAtEntry: number | 'UNKNOWN';
  volumeAtEntry: number | 'UNKNOWN';

  buyerVelocity: number | 'UNKNOWN';
  sellerVelocity: number | 'UNKNOWN';

  tokenAge?: number | 'UNKNOWN';
  RugCheckStatus: string;
  RugCheckScore: number;

  mintAuthority: string | null;
  freezeAuthority: string | null;
  lpStatus: string;

  entryReason: string;
  exitReason: string;

  takeProfitTriggered: boolean;
  stopLossTriggered: boolean;

  rebuyNumber: number;
  wasRebuy: boolean;

  timestamp: string;
}

export interface ScoreFactorBreakdown {
  category: 'Base Analysis' | 'Historical Pattern' | 'Trader History' | 'Liquidity Quality' | 'Momentum' | 'Risk Adjustment' | 'RugCheck Gate';
  impact: number;
  reason: string;
}

export interface LearnedScoreResult {
  finalScore: number;
  confidence: number; // 0 to 100 (%)
  baseScore: number;
  breakdown: ScoreFactorBreakdown[];
  signals: {
    positive: string[];
    risks: string[];
  };
  sampleSizeUsed: number;
}

export interface LearnedPattern {
  id: string;
  patternName: string;
  description: string;
  sampleSize: number;
  winRate: number; // 0 - 100 (%)
  averagePnLPercent: number;
  averagePnLSol: number;
  confidence: number; // 0 - 100 (%)
  type: 'WINNING' | 'LOSING';
}

export interface TraderIntelligence {
  traderId: string;
  traderName: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number; // 0 - 100 (%)
  averagePnLPercent: number;
  medianPnLPercent: number;
  averageHoldingTimeSec: number;
  averageEntryLiquidity: number;
  averageAIScore: number;
  takeProfitRate: number; // 0 - 100 (%)
  stopLossRate: number; // 0 - 100 (%)
  rebuySuccessRate: number; // 0 - 100 (%)
  confidence: number; // 0 - 100 (%)
}

export interface AIScoreBucketPerformance {
  range: string;
  minScore: number;
  maxScore: number;
  trades: number;
  winningTrades: number;
  winRate: number;
  averagePnLPercent: number;
  averagePnLSol: number;
}

export interface AIPerformanceMetrics {
  totalPredictions: number;
  totalCompletedTrades: number;
  aiWins: number;
  aiLosses: number;
  aiWinRate: number;
  averagePredictedScore: number;
  averageWinningScore: number;
  averageLosingScore: number;
  averagePnLPercent: number;
  averagePnLSol: number;
  predictionAccuracy: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  tpPredictionAccuracy: number;
  slPredictionAccuracy: number;
  scoreBuckets: AIScoreBucketPerformance[];
  lastUpdated: string;
}

export interface AILearningSummary {
  status: 'ACTIVE' | 'INITIALIZING';
  totalLearningTrades: number;
  profitableTrades: number;
  losingTrades: number;
  winRate: number;
  averageLearnedPnL: number;
  patternsLearned: number;
  tradersLearned: number;
  lastUpdated: string;
}

export interface AILearningState {
  learningRecords: Record<string, LearningRecord>;
  performance: AIPerformanceMetrics;
  lastUpdated: string;
}

export interface DiscoveryFeedState {
  timestamp: number;
  nextRefreshAt: number;
  status: 'IDLE' | 'REFRESHING' | 'SUCCESS' | 'FAILED';
  error?: string | null;
  tokens?: TokenObservation[];
}

export interface ServerState {
  settings: Settings;
  traders: TraderWallet[];
  observations: TokenObservation[];
  discoveryFeed?: DiscoveryFeedState;
  positions: Position[];
  trades: Trade[];
  connection: ConnectionStatus;
  aiStats: AIStats;
  rebuyStates: Record<string, RebuyState>;
  aiLearningSummary?: AILearningSummary;
  buy_authorization_audits?: BuyAuthorizationAudit[];
}

export type DecisionStatus = 'AUTHORIZED' | 'REJECTED' | 'PENDING';

export interface CriteriaResult {
  marketCapUSD: number;
  liquidityUSD: number;
  volumeUSD: number;
  developerHoldingPct: number;
  buyTxCount10s: number;
  marketCapPassed: boolean;
  liquidityPassed: boolean;
  volumePassed: boolean;
  developerPassed: boolean;
  buyVelocityPassed: boolean;
  passed: boolean;
}

export interface SafetyResult {
  rugcheckScore: number;
  rugcheckPassed: boolean;
  mintAuthorityRemoved: boolean;
  freezeAuthorityRemoved: boolean;
  lpLocked: boolean;
  passed: boolean;
  rejectionReason?: string;
}

export interface MomentumResult {
  buyTxCount5s: number;
  buyTxCount10s: number;
  buyTxCount30s: number;
  buyTxCount60s: number;
  sellTxCount10s: number;
  sellTxCount30s: number;
  buyVolume10s: number;
  sellVolume10s: number;
  priceChange10s: number;
  priceChange30s: number;
  priceChange5m: number;
  buyAcceleration: number;
  buyTxIncreasing?: boolean;
  buyVelocityIncreasing?: boolean;
  volumeIncreasing?: boolean;
  priceMovingPositively?: boolean;
  earlyMomentumDetected?: boolean;
}

export interface ExecutionResult {
  quoteTimestamp: number;
  inputAmount: number;
  expectedOutput: number;
  route: string;
  priceImpact: number;
  slippage: number;
  passed: boolean;
  rejectionReason?: string;
}

export interface BuyDecision {
  decision: DecisionStatus;
  candidateId: string;
  tokenMint: string;
  traderWallet: string;
  authorizedAt: string;
  criteria: CriteriaResult;
  safety: SafetyResult;
  momentum: MomentumResult;
  execution?: ExecutionResult;
  rejectReasons: string[];
  auditId: string;
  strategyVersion: string;
}

export interface TradeCandidate {
  id: string;
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  traderWallet: string;
  sourceSignature: string;
  detectedAt: string;
  market: {
    tokenMint: string;
    priceUSD: number;
    priceSOL: number;
    marketCapUSD: number;
    liquidityUSD: number;
    volumeUSD24h: number;
    timestamp: string;
    source: string;
  };
  security: {
    developerHoldingPct: number;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    lpLocked: boolean;
    rugcheckPassed: boolean;
    status: string;
  };
  momentum: MomentumResult;
  trader: {
    walletAddress: string;
    name: string;
    signals: number;
    paperTrades: number;
    winRate: number;
    pnlSol: number;
  };
}

export interface BuyAuthorizationAudit {
  id: string;
  candidateId: string;
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  traderWallet: string;
  sourceSignature: string;
  createdAt: string;
  marketSnapshotJSON: string;
  securitySnapshotJSON: string;
  momentumSnapshotJSON: string;
  traderSnapshotJSON: string;
  executionSnapshotJSON?: string;
  decision: string;
  rejectReasons: string[];
  strategyVersion: string;
}
