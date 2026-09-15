import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { Connection, PublicKey } from '@solana/web3.js';
import { db } from './src/db.js';
import { scoreToken } from './src/server/ai.js';
import { RebuyGuard } from './src/server/rebuyGuard.js';
import { getRugCheckReport, validateRugCheck } from './src/server/rugcheck.js';
import { 
  isValidSolanaMint, 
  isValidSolanaSignature, 
  formatTokenQuantity, 
  calculateTokenQuantityFromFill, 
  parseTokenQuantity 
} from './src/utils/solana.js';
import { 
  TraderWallet, 
  Settings, 
  TokenObservation, 
  Position, 
  Trade, 
  ConnectionStatus 
} from './src/types.js';
import { livePriceService, LivePrice } from './src/server/priceService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = 3000;

app.use(express.json());

// Helper to construct sanitized state without exposing sensitive secrets
function getSanitizedState() {
  const rawSettings = db.getSettings();
  const jupApiKey = livePriceService.getJupiterApiKey();
  const sanitizedSettings: Settings = {
    ...rawSettings,
    jupiter_api_key: jupApiKey ? '[CONFIGURED]' : ''
  };

  currentConnectionStatus.jupiter = livePriceService.getJupiterStatus();

  return {
    settings: sanitizedSettings,
    traders: db.getTraderWallets(),
    observations: db.getTokenObservations(),
    positions: db.getPositions(),
    trades: db.getTrades(),
    connection: currentConnectionStatus,
    aiStats: db.getAIStats(),
    rebuyStates: db.getRebuyStates()
  };
}

// API: Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API: Get current state
app.get('/api/state', (req, res) => {
  res.json(getSanitizedState());
});

// API: Check RebuyGuard status for a specific mint
app.get('/api/rebuy/:mint', async (req, res) => {
  const { mint } = req.params;
  const decision = await RebuyGuard.canBuy(mint);
  const state = await RebuyGuard.getRebuyState(mint);
  res.json({ decision, state });
});

// API: Check RugCheck security report for a specific mint
app.get('/api/rugcheck/:mint', async (req, res) => {
  const { mint } = req.params;
  const settings = db.getSettings();
  const report = await getRugCheckReport(mint);
  const validation = validateRugCheck(report, settings);
  res.json({ report, validation });
});

// API: Reset Profitable-Only Rebuy Guard Matrix and Completed Trade History
app.post('/api/trading/reset-guard-history', async (req, res) => {
  try {
    console.log('[API] Processing Reset Profitable-Only Rebuy Guard Matrix & Completed History...');
    const result = await RebuyGuard.resetAll();
    broadcastState();
    res.json({
      success: true,
      completedTrades: result.completedTrades,
      rebuyGuardEntries: result.rebuyGuardEntries,
      resetAt: result.resetAt
    });
  } catch (err: any) {
    console.error('[API] Failed to reset guard and history:', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to reset guard and history' });
  }
});

// API: Handle actions as HTTP fallback
app.post('/api/action', async (req, res) => {
  try {
    const { type, action, data } = req.body;
    const actionType = type || action;
    console.log(`[HTTP API] Received action: ${actionType}`);

    if (actionType === 'ADD_TRADER') {
      if (!isValidSolanaMint(data.wallet_address)) {
        return res.status(400).json({ success: false, error: 'Invalid Solana Public Key address' });
      }
      try {
        db.addTraderWallet({
          name: data.name,
          wallet_address: data.wallet_address,
          enabled: true
        });
        setupLogsSubscription();
        broadcastState();
        res.json({ success: true });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err?.message || 'Failed to add trader' });
      }
    }
    else if (actionType === 'TOGGLE_TRADER') {
      db.updateTraderWallet(data.id, { enabled: data.enabled });
      setupLogsSubscription();
      broadcastState();
      res.json({ success: true });
    }
    else if (actionType === 'DELETE_TRADER') {
      db.deleteTraderWallet(data.id);
      setupLogsSubscription();
      broadcastState();
      res.json({ success: true });
    }
    else if (actionType === 'UPDATE_SETTINGS') {
      const updatePayload = { ...data };
      if (updatePayload.jupiter_api_key === '[CONFIGURED]') {
        delete updatePayload.jupiter_api_key;
      }
      db.updateSettings(updatePayload);
      if (data.rpc_url || data.wss_url) {
        await initSolanaConnection();
      } else {
        broadcastState();
      }
      res.json({ success: true });
    }
    else if (actionType === 'CLOSE_POSITION') {
      const positions = db.getPositions();
      const pos = positions.find(p => p.id === data.id);
      if (pos) {
        await executePositionExit(pos, pos.current_price, pos.current_value_sol, pos.unrealized_pnl_sol, pos.unrealized_pnl_percent, 'MANUAL');
      }
      res.json({ success: true });
    }
    else if (actionType === 'PARTIAL_SELL') {
      const positions = db.getPositions();
      const pos = positions.find(p => p.id === data.id);
      if (pos) {
        const ratio = typeof data.ratio === 'number' ? data.ratio : 0.5;
        await executePartialSell(pos, ratio, 'MANUAL');
      }
      res.json({ success: true });
    }
    else if (actionType === 'RECONCILE_POSITION') {
      const positions = db.getPositions();
      const pos = positions.find(p => p.id === data.id);
      if (pos) {
        const resRecon = await reconcilePositionWithOnChainBalance(pos);
        return res.json({ success: true, reconciliation: resRecon });
      }
      res.json({ success: true });
    }
    else if (actionType === 'RESET_BALANCE') {
      db.updateSettings({ paper_balance_sol: 10.0 });
      broadcastState();
      res.json({ success: true });
    }
    else if (actionType === 'RESET_GUARD_AND_HISTORY' || actionType === 'RESET_GUARD_HISTORY') {
      const result = await RebuyGuard.resetAll();
      broadcastState();
      res.json({
        success: true,
        completedTrades: result.completedTrades,
        rebuyGuardEntries: result.rebuyGuardEntries,
        resetAt: result.resetAt
      });
    }
    else {
      res.status(400).json({ success: false, error: 'Unknown action type' });
    }
  } catch (err) {
    console.error('[HTTP API] Error processing action:', err);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// Create WebSocket server on top of HTTP server
const wss = new WebSocketServer({ noServer: true });

// Track client connections
const clients = new Set<WebSocket>();

server.on('upgrade', (request, socket, head) => {
  const url = request.url || '';
  const pathname = url.split('?')[0];
  
  if (pathname === '/ws' || pathname === '/ws/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

// Broadcast state to all connected clients
function broadcastState() {
  const state = getSanitizedState();
  const payload = JSON.stringify({ type: 'STATE_UPDATE', data: state });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Current Connection Status State
let currentConnectionStatus: ConnectionStatus = {
  rpc: 'DISCONNECTED',
  wss: 'DISCONNECTED',
  laserstream: 'DISCONNECTED',
  jupiter: 'NOT_CONFIGURED'
};

// Map of processed transaction signatures to avoid duplicate copy trading (Idempotency)
const processedSignatures = new Set<string>();

// Solana Connection instances
let solanaConnection: Connection | null = null;
let activeLogSubscriptions: number[] = [];

// Estimated SOL/USD price cache (updated via DexScreener periodically)
let cachedSolUsdPrice = 160.0;

async function updateSolUsdPrice() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    if (res.ok) {
      const data = await res.json();
      const solPair = (data.pairs || []).find((p: any) => p.chainId === 'solana' && p.priceUsd);
      if (solPair?.priceUsd) {
        cachedSolUsdPrice = Number(solPair.priceUsd);
      }
    }
  } catch (err) {
    console.warn('[Pricing] Could not refresh SOL/USD price from DexScreener, using cached value:', cachedSolUsdPrice);
  }
}

// Initialize connection based on settings
async function initSolanaConnection() {
  const settings = db.getSettings();
  if (!settings.rpc_url) {
    currentConnectionStatus.rpc = 'DISCONNECTED';
    currentConnectionStatus.wss = 'DISCONNECTED';
    return;
  }

  currentConnectionStatus.rpc = 'CONNECTING';
  currentConnectionStatus.wss = 'CONNECTING';
  broadcastState();

  try {
    // Attempt primary RPC
    solanaConnection = new Connection(settings.rpc_url, {
      wsEndpoint: settings.wss_url || undefined,
      commitment: 'confirmed'
    });

    const version = await solanaConnection.getVersion();
    console.log(`[Solana] Connected to RPC. Version:`, version);
    currentConnectionStatus.rpc = 'CONNECTED';
    currentConnectionStatus.wss = settings.wss_url ? 'CONNECTED' : 'DISCONNECTED';
    
    // Subscribe to trader wallets logs if any exist
    setupLogsSubscription();
  } catch (err) {
    console.error('[Solana] Primary RPC failed. Attempting failover...', err);
    currentConnectionStatus.rpc = 'ERROR';
    broadcastState();

    if (settings.backup_rpc_url) {
      try {
        console.log('[Solana] Using backup RPC:', settings.backup_rpc_url);
        solanaConnection = new Connection(settings.backup_rpc_url, {
          wsEndpoint: settings.backup_wss_url || undefined,
          commitment: 'confirmed'
        });
        await solanaConnection.getVersion();
        currentConnectionStatus.rpc = 'CONNECTED';
        currentConnectionStatus.wss = settings.backup_wss_url ? 'CONNECTED' : 'DISCONNECTED';
        setupLogsSubscription();
      } catch (backupErr) {
        console.error('[Solana] Backup RPC also failed.', backupErr);
        currentConnectionStatus.rpc = 'ERROR';
        currentConnectionStatus.wss = 'ERROR';
      }
    }
  }

  // Jupiter API credentials status
  if (settings.jupiter_api_key) {
    currentConnectionStatus.jupiter = 'CONNECTED';
  } else {
    currentConnectionStatus.jupiter = 'NOT_CONFIGURED';
  }

  // LaserStream configuration status
  if (settings.laserstream_key) {
    currentConnectionStatus.laserstream = 'CONNECTED';
  } else {
    currentConnectionStatus.laserstream = 'DISCONNECTED';
  }

  broadcastState();
}

// Unsubscribe and subscribe to all enabled trader wallets' logs on Solana
function setupLogsSubscription() {
  if (!solanaConnection) return;

  // Clear existing subscriptions
  for (const subId of activeLogSubscriptions) {
    try {
      solanaConnection.removeOnLogsListener(subId);
    } catch (err) {
      console.error('[Solana] Error removing log listener', err);
    }
  }
  activeLogSubscriptions = [];

  const enabledTraders = db.getTraderWallets().filter(t => t.enabled);
  if (enabledTraders.length === 0) {
    console.log('[Solana] No enabled trader wallets to monitor.');
    return;
  }

  console.log(`[Solana] Setting up on-chain log subscriptions for ${enabledTraders.length} trader(s)...`);

  enabledTraders.forEach(trader => {
    if (!isValidSolanaMint(trader.wallet_address)) {
      console.warn(`[Solana] Skipping invalid trader wallet address: ${trader.wallet_address}`);
      return;
    }

    try {
      const pubkey = new PublicKey(trader.wallet_address);
      const subId = solanaConnection!.onLogs(
        pubkey,
        async (logs) => {
          if (!logs.signature || processedSignatures.has(logs.signature)) return;
          console.log(`[Solana] Real on-chain log event detected on wallet ${trader.name} (${trader.wallet_address}). Signature: ${logs.signature}`);
          
          // Process transaction in background
          processDetectedTransaction(logs.signature, trader);
        },
        'confirmed'
      );
      activeLogSubscriptions.push(subId);
      console.log(`[Solana] Log listener active for trader: ${trader.name}`);
    } catch (err) {
      console.error(`[Solana] Failed to subscribe to logs for trader ${trader.name}:`, err);
    }
  });
}

// Real Transaction Parsing & Token Discovery
async function processDetectedTransaction(signature: string, trader: TraderWallet) {
  if (processedSignatures.has(signature)) return;
  processedSignatures.add(signature);

  console.log(`[Monitor] Processing transaction ${signature} for trader ${trader.name}`);

  try {
    if (!solanaConnection) {
      console.warn('[Monitor] No active Solana RPC connection available.');
      return;
    }

    // Retrieve full parsed transaction from blockchain
    const tx = await solanaConnection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx || !tx.meta) {
      console.warn(`[Monitor] Could not fetch parsed transaction metadata for signature: ${signature}`);
      return;
    }

    const slot = tx.slot || 0;
    const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);

    // Locate the monitored trader's account index
    const accountKeys = tx.transaction.message.accountKeys.map(a => a.pubkey.toString());
    const traderIndex = accountKeys.indexOf(trader.wallet_address);

    if (traderIndex === -1) {
      console.warn(`[Monitor] Monitored trader ${trader.wallet_address} not found in transaction accounts.`);
      return;
    }

    // SOL Balance Change Analysis
    const preSol = tx.meta.preBalances[traderIndex];
    const postSol = tx.meta.postBalances[traderIndex];
    const solSpentLamports = preSol - postSol; // If positive, trader spent SOL

    if (solSpentLamports <= 0) {
      console.log(`[Monitor] Transaction ${signature} is not a SOL-spending BUY. Ignoring.`);
      return;
    }

    // SPL Token Balance Change Analysis
    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];

    let targetMint = '';
    let targetDecimals = 0;
    let tokenAcquiredAmount = 0;

    for (const post of postTokenBalances) {
      if (post.owner === trader.wallet_address) {
        const pre = preTokenBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
        const postAmount = Number(post.uiTokenAmount.amount);

        if (postAmount > preAmount) {
          const candidateMint = post.mint;
          if (isValidSolanaMint(candidateMint)) {
            targetMint = candidateMint;
            targetDecimals = post.uiTokenAmount.decimals;
            tokenAcquiredAmount = (postAmount - preAmount) / Math.pow(10, targetDecimals);
            break;
          }
        }
      }
    }

    // Strict validation: Reject if no valid Solana mint detected
    if (!targetMint || !isValidSolanaMint(targetMint)) {
      console.warn(`[TokenDiscovery] REJECTED: No valid Solana mint identified in transaction ${signature}`);
      return;
    }

    const solSpent = solSpentLamports / 1e9;

    // Diagnostic logging as required by production specifications
    console.log(`[TokenDiscovery] Real Solana token detected\nMint: ${targetMint}\nTrader: ${trader.name} (${trader.wallet_address})\nSignature: ${signature}\nSlot: ${slot}`);

    // Log genuine monitored transaction into database
    db.addMonitoredTransaction({
      signature,
      trader_wallet_id: trader.id,
      token_mint: targetMint,
      transaction_type: 'BUY',
      sol_amount: solSpent,
      token_amount: tokenAcquiredAmount,
      timestamp: new Date(blockTime * 1000).toISOString()
    });

    // Run DexScreener metrics gate, filters, AI scoring, and copy-trading execution
    await evaluateAndCopyToken(targetMint, targetDecimals, trader, {
      signature,
      solSpent,
      tokenAcquiredAmount
    });

  } catch (err) {
    console.error(`[Monitor] Error parsing transaction ${signature}:`, err);
  }
}

// Fetch on-chain developer holding or authority status
async function getOnChainDevHolding(mintStr: string): Promise<number | 'UNKNOWN'> {
  try {
    if (!solanaConnection) return 'UNKNOWN';
    const mintPk = new PublicKey(mintStr);
    const accInfo = await solanaConnection.getParsedAccountInfo(mintPk);
    const parsed = (accInfo.value?.data as any)?.parsed?.info;
    if (parsed) {
      const mintAuthority = parsed.mintAuthority;
      if (!mintAuthority) {
        // Mint authority is fully renounced/revoked
        return 0.0;
      }
    }
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

// Evaluate Real Token using DexScreener API, run through 5 strict filters, AI score, and execute paper/mainnet copy-trade
async function evaluateAndCopyToken(
  mint: string, 
  decimals: number, 
  trader: TraderWallet, 
  buyDetails: { signature: string; solSpent: number; tokenAcquiredAmount: number }
) {
  if (!isValidSolanaMint(mint)) {
    console.warn(`[Filters] REJECTED invalid mint passed to evaluation: "${mint}"`);
    return;
  }

  console.log(`[Filters] Evaluating genuine Solana token ${mint} for copy trade eligibility...`);

  // Fetch token metadata from DexScreener API
  let tokenName = '';
  let tokenSymbol = '';
  let marketCap: number | 'UNKNOWN' = 'UNKNOWN';
  let liquidity: number | 'UNKNOWN' = 'UNKNOWN';
  let volume24h: number | 'UNKNOWN' = 'UNKNOWN';
  let developerHoldingPercent: number | 'UNKNOWN' = 'UNKNOWN';
  let buyers10s: number | 'UNKNOWN' = 'UNKNOWN';
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

        // Derive 10s rolling buyer count from DexScreener 5m buy transaction velocity (300s / 30 = 10s)
        if (pair.txns?.m5?.buys !== undefined) {
          buyers10s = Math.round(Number(pair.txns.m5.buys) / 30);
        }

        // Check on-chain dev holding / authority
        developerHoldingPercent = await getOnChainDevHolding(mint);
      }
    }
  } catch (err) {
    console.error('[Filters] Failed to retrieve token metrics from DexScreener:', err);
  }

  // Strict Data Completeness Gate: If crucial metrics are missing, reject immediately. Do NOT fabricate data.
  if (
    !tokenName ||
    !tokenSymbol ||
    marketCap === 'UNKNOWN' || 
    liquidity === 'UNKNOWN' || 
    volume24h === 'UNKNOWN' || 
    price === 'UNKNOWN'
  ) {
    console.warn(`[TokenMetrics] REJECTED\nMint: ${mint}\nReason: Required market metrics unavailable`);
    db.addTokenObservation({
      token_mint: mint,
      token_name: tokenName || 'WAITING FOR MARKET DATA',
      token_symbol: tokenSymbol || 'UNAVAILABLE',
      market_cap: marketCap,
      liquidity: liquidity,
      volume_24h: volume24h,
      developer_holding_percent: developerHoldingPercent,
      buyers_10s: buyers10s,
      price: price,
      status: 'REJECT',
      rejection_reason: 'Required market metrics unavailable on DexScreener',
      source_trader_name: trader.name
    });
    broadcastState();
    return;
  }

  // Evaluate RebuyGuard for this token mint
  const rebuyDecision = await RebuyGuard.canBuy(mint);
  if (!rebuyDecision.allowed) {
    console.log(`[RebuyGuard] Automated BUY blocked for ${tokenSymbol} (${mint}). Reason: ${rebuyDecision.reason}`);
    db.addTokenObservation({
      token_mint: mint,
      token_name: tokenName,
      token_symbol: tokenSymbol,
      market_cap: marketCap,
      liquidity: liquidity,
      volume_24h: volume24h,
      developer_holding_percent: developerHoldingPercent,
      buyers_10s: buyers10s,
      price: price,
      status: 'REJECT',
      rejection_reason: `RebuyGuard: ${rebuyDecision.reason}`,
      source_trader_name: trader.name
    });
    broadcastState();
    return;
  }

  // Apply strict requirement checks:
  let rejectionReason = '';
  const settings = db.getSettings();
  
  // Requirement 1: Market Cap > $4,000. Reject <= $4,000
  if (marketCap <= 4000) {
    rejectionReason = `Market Cap ($${marketCap.toLocaleString()}) is <= $4,000`;
  }
  // Requirement 2: Liquidity > $4,000. Reject <= $4,000
  else if (liquidity <= 4000) {
    rejectionReason = `Liquidity ($${liquidity.toLocaleString()}) is <= $4,000`;
  }
  // Requirement 3: Developer Holding < 5%. Reject >= 5% (if known)
  else if (developerHoldingPercent !== 'UNKNOWN' && developerHoldingPercent >= 5) {
    rejectionReason = `Developer holding (${developerHoldingPercent}%) is >= 5%`;
  }
  // Requirement 4: 24h Volume > $5,000. Reject <= $5,000
  else if (volume24h <= 5000) {
    rejectionReason = `24h Volume ($${volume24h.toLocaleString()}) is <= $5,000`;
  }
  // Requirement 5: Unique buyers in rolling 10-second window > 10. Reject <= 10 (if known)
  else if (buyers10s !== 'UNKNOWN' && buyers10s <= 10) {
    rejectionReason = `Rolling 10s buyers (${buyers10s}) is <= 10`;
  }

  // Mandatory Security Gate: RugCheck Security Verification (Runs before AI & before BUY)
  let rugCheck = undefined;
  let rugCheckPassed = false;
  if (!rejectionReason && settings.enableRugCheck) {
    console.log(`[RugCheck] Running security verification for ${tokenSymbol} (${mint})...`);
    rugCheck = await getRugCheckReport(mint);
    const rugValidation = validateRugCheck(rugCheck, settings);

    if (!rugValidation.passed) {
      rejectionReason = rugValidation.reason || 'RugCheck Security Filter Failed';
      rugCheckPassed = false;
      console.warn(`[RugCheck] REJECTED: Token ${tokenSymbol} (${mint}) failed security validation. Reason: ${rejectionReason}`);
    } else {
      rugCheckPassed = true;
      console.log(`[RugCheck] PASSED: Token ${tokenSymbol} (${mint}) verified safe. Risk Level: ${rugCheck.riskLevel}, LP Locked: ${rugCheck.lpLocked}, Mint Auth: ${rugCheck.mintAuthority === null ? 'Revoked' : 'Active'}, Freeze Auth: ${rugCheck.freezeAuthority === null ? 'Revoked' : 'Active'}`);
    }
  }

  const isEligible = rejectionReason === '';
  const status = isEligible ? 'ELIGIBLE' : 'REJECT';

  // Calculate AI Score using Gemini AI learning engine (ONLY IF token passed all prior security checks)
  let aiResult = { score: 50, signals: { positive: [], risks: [] } };
  if (isEligible) {
    const previousTrades = db.getTrades();
    aiResult = await scoreToken({
      token_mint: mint,
      token_name: tokenName,
      token_symbol: tokenSymbol,
      market_cap: marketCap,
      liquidity: liquidity,
      volume_24h: volume24h,
      developer_holding_percent: developerHoldingPercent,
      buyers_10s: buyers10s,
      price: price,
      status: status
    }, previousTrades);
  }

  console.log(`[Filters] Evaluation completed for ${tokenSymbol} (${mint}). Status: ${status}.${isEligible ? ` AI Score: ${aiResult.score}` : ` Reason: ${rejectionReason}`}`);

  // Persist observation
  db.addTokenObservation({
    token_mint: mint,
    token_name: tokenName,
    token_symbol: tokenSymbol,
    market_cap: marketCap,
    liquidity: liquidity,
    volume_24h: volume24h,
    developer_holding_percent: developerHoldingPercent,
    buyers_10s: buyers10s,
    price: price,
    status,
    rejection_reason: rejectionReason || undefined,
    source_trader_name: trader.name,
    ai_score: isEligible ? aiResult.score : undefined,
    ai_signals: isEligible ? aiResult.signals : undefined,
    rugcheck: rugCheck,
    rugcheck_passed: rugCheck ? rugCheckPassed : undefined
  });

  // If eligible, execute trade entry in background!
  if (isEligible) {
    if (settings.trading_mode === 'PAPER') {
      await executePaperBuy({
        mint,
        decimals,
        tokenName,
        tokenSymbol,
        trader,
        buySignature: buyDetails.signature,
        aiScore: aiResult.score,
        priceUsd: price,
        rugcheck: rugCheck
      });
    } else {
      console.warn(`[Mainnet] Copy trading on MAINNET mode requested. Mainnet requires explicit manual transaction signing.`);
    }
  }

  broadcastState();
}

// Helper to resolve genuine token decimals from on-chain mint account
async function getMintDecimals(mintStr: string): Promise<number> {
  try {
    if (solanaConnection && isValidSolanaMint(mintStr)) {
      const mintPk = new PublicKey(mintStr);
      const accInfo = await solanaConnection.getParsedAccountInfo(mintPk);
      const parsed = (accInfo.value?.data as any)?.parsed?.info;
      if (parsed && typeof parsed.decimals === 'number') {
        return parsed.decimals;
      }
    }
  } catch (err) {
    console.warn(`[MintDecimals] Could not resolve on-chain decimals for ${mintStr}:`, err);
  }
  return 6; // Standard SPL fallback
}

// Executes a Paper Trade Entry Buy with precise Token Quantity calculation
async function executePaperBuy(params: {
  mint: string;
  decimals: number;
  tokenName: string;
  tokenSymbol: string;
  trader: TraderWallet;
  buySignature: string;
  aiScore: number;
  priceUsd: number;
  rugcheck?: any;
}) {
  const settings = db.getSettings();
  const tradeAmountSol = settings.trading_amount_sol;

  // MANDATORY FINAL BUY GATE: Strict RugCheck Verification before any buy execution
  let activeRugCheck = params.rugcheck;
  if (settings.enableRugCheck) {
    if (!activeRugCheck) {
      activeRugCheck = await getRugCheckReport(params.mint);
    }
    const rugValidation = validateRugCheck(activeRugCheck, settings);
    if (!rugValidation.passed) {
      console.error(`[BuyGate] BLOCKED BUY: Token ${params.tokenSymbol} (${params.mint}) failed RugCheck: ${rugValidation.reason}`);
      throw new Error(`BUY_BLOCKED_RUGCHECK_FAILED: ${rugValidation.reason}`);
    }
  }

  // Atomic Rebuy Guard Check
  const rebuyDecision = await RebuyGuard.canBuy(params.mint);
  if (!rebuyDecision.allowed) {
    console.warn(`[Paper Trade] ABORTED BUY: RebuyGuard blocked ${params.tokenSymbol} (${params.mint}). Reason: ${rebuyDecision.reason}`);
    return;
  }

  if (settings.paper_balance_sol < tradeAmountSol) {
    console.error(`[Paper Trade] Insufficient paper balance (${settings.paper_balance_sol} SOL) for trade amount (${tradeAmountSol} SOL)`);
    return;
  }

  // Check if we already have an active position for this mint (prevent duplicates)
  const activePositions = db.getPositions().filter(p => p.status === 'ACTIVE');
  if (activePositions.some(p => p.token_mint === params.mint)) {
    console.log(`[Paper Trade] Position for ${params.tokenSymbol} is already active. Skipping duplicate.`);
    return;
  }

  // Deduct from paper balance
  const remainingBalance = Number((settings.paper_balance_sol - tradeAmountSol).toFixed(4));
  db.updateSettings({ paper_balance_sol: remainingBalance });

  // Resolve genuine decimals
  let tokenDecimals = params.decimals;
  if (!tokenDecimals || tokenDecimals <= 0) {
    tokenDecimals = await getMintDecimals(params.mint);
  }

  // Calculate Entry Price in SOL from USD token price and SOL/USD rate
  const solUsdRate = cachedSolUsdPrice > 0 ? cachedSolUsdPrice : 160.0;
  const entryPriceSol = Number((params.priceUsd / solUsdRate).toFixed(12));
  const entryPriceUsdFormatted = `$${params.priceUsd < 0.01 ? params.priceUsd.toFixed(8) : params.priceUsd.toFixed(4)}`;
  const investedUsdFormatted = `$${(tradeAmountSol * solUsdRate).toFixed(2)}`;

  // Rule 3: Token Quantity = Investment Amount ÷ Actual Market Execution Price
  const tokenFill = calculateTokenQuantityFromFill({
    investedAmount: tradeAmountSol,
    executionPrice: entryPriceSol,
    tokenDecimals
  });

  const existingRebuyState = await RebuyGuard.getRebuyState(params.mint);
  const isRebuy = Boolean(existingRebuyState && existingRebuyState.initialBuyCount >= 1 && existingRebuyState.rebuyCount === 0);
  const tradeNumber = isRebuy ? 2 : 1;
  const initialBuyQuantity = isRebuy ? (existingRebuyState?.initialBuyQuantity || tokenFill.tokenQuantity) : tokenFill.tokenQuantity;
  const rebuyQuantity = isRebuy ? tokenFill.tokenQuantity : undefined;
  const totalBoughtQuantity = isRebuy
    ? formatTokenQuantity(parseTokenQuantity(initialBuyQuantity) + parseTokenQuantity(tokenFill.tokenQuantity), tokenDecimals)
    : tokenFill.tokenQuantity;

  const rawSolIn = (BigInt(Math.floor(tradeAmountSol * 1e9))).toString();

  // Save the position
  const newPos = db.addPosition({
    token_mint: params.mint,
    mint: params.mint,
    token_name: params.tokenName,
    token_symbol: params.tokenSymbol,
    symbol: params.tokenSymbol,
    source_trader_id: params.trader.id,
    source_trader_name: params.trader.name,
    buy_signature: params.buySignature,
    buySignature: params.buySignature,

    // Explicit Token Quantities (Strictly maintained, never derived from current price)
    tokenQuantity: tokenFill.tokenQuantity,
    remainingTokenQuantity: tokenFill.tokenQuantity,
    remainingQuantity: tokenFill.tokenQuantity,
    tokenDecimals,
    token_decimals: tokenDecimals,
    token_amount: tokenFill.numericAmount,
    raw_token_amount: tokenFill.rawUnits,

    // Rebuy Tracking
    initialBuyQuantity,
    rebuyQuantity,
    totalBoughtQuantity,
    isRebuy,
    tradeNumber,

    // Pricing & Value
    entryPrice: `${entryPriceSol.toFixed(10)} SOL (${entryPriceUsdFormatted})`,
    entry_price: entryPriceSol,
    investedAmount: `${tradeAmountSol.toFixed(4)} SOL (${investedUsdFormatted})`,
    sol_in: tradeAmountSol,
    raw_sol_in: rawSolIn,
    buy_time: new Date().toISOString(),
    current_price: entryPriceSol,
    currentPrice: `${entryPriceSol.toFixed(10)} SOL`,
    current_value_sol: tradeAmountSol,
    currentValue: `${tradeAmountSol.toFixed(4)} SOL`,
    unrealized_pnl_sol: 0,
    unrealizedPnl: '+0.0000 SOL',
    unrealized_pnl_percent: 0,
    unrealizedPnlPercent: '+0.00%',
    network: 'mainnet-beta',
    status: 'ACTIVE',
    take_profit_percent: settings.take_profit_percent,
    stop_loss_percent: settings.stop_loss_percent,
    rugcheck: activeRugCheck
  });

  // Record BUY in RebuyGuard
  if (newPos) {
    await RebuyGuard.onBuyExecuted({
      mint: params.mint,
      positionId: newPos.id,
      tokenQuantity: tokenFill.tokenQuantity,
      entryPrice: entryPriceSol,
      entryCost: tradeAmountSol,
      isRebuy
    });
  }

  console.log(`[Paper Trade] BUY SUCCESS: Created active position for ${params.tokenSymbol} (${params.mint}). Tokens Bought: ${tokenFill.tokenQuantity} (Decimals: ${tokenDecimals}). Invested: ${tradeAmountSol} SOL.`);
}

// Event-driven Active Position Live Price & PnL Engine
// Powered by Jupiter Batch API primary with DexScreener fallback.
const exitingPositions = new Set<string>();

function handleLivePriceUpdate(livePrice: LivePrice) {
  const activePositions = db.getPositions().filter(p => p.status === 'ACTIVE' && p.token_mint === livePrice.mint);
  if (activePositions.length === 0) return;

  const solUsdRate = livePriceService.getSolUsdPrice();

  for (const pos of activePositions) {
    if (exitingPositions.has(pos.id)) continue;

    const remainingTokens = parseTokenQuantity(pos.remainingTokenQuantity || pos.tokenQuantity || String(pos.token_amount));
    const currentValueSol = Number((remainingTokens * livePrice.priceSol).toFixed(4));
    const pnlSol = Number((currentValueSol - pos.sol_in).toFixed(4));
    const pnlPercent = pos.sol_in > 0 ? Number(((pnlSol / pos.sol_in) * 100).toFixed(2)) : 0;

    const currentPriceUsdFormatted = `$${livePrice.priceUsd < 0.01 ? livePrice.priceUsd.toFixed(8) : livePrice.priceUsd.toFixed(4)}`;
    const currentValueUsdFormatted = `$${(currentValueSol * solUsdRate).toFixed(2)}`;

    // Update active position metrics in DB
    db.updatePosition(pos.id, {
      current_price: livePrice.priceSol,
      currentPrice: `${livePrice.priceSol.toFixed(10)} SOL (${currentPriceUsdFormatted})`,
      current_value_sol: currentValueSol,
      currentValue: `${currentValueSol.toFixed(4)} SOL (${currentValueUsdFormatted})`,
      unrealized_pnl_sol: pnlSol,
      unrealizedPnl: `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`,
      unrealized_pnl_percent: pnlPercent,
      unrealizedPnlPercent: `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`
    });

    // Broadcast targeted POSITION_PNL_UPDATE for instant UI update
    const pnlPayload = JSON.stringify({
      type: 'POSITION_PNL_UPDATE',
      data: {
        positionId: pos.id,
        mint: pos.token_mint,
        pnlSol,
        pnlPercent,
        currentValueSol,
        currentPriceSol: livePrice.priceSol,
        currentPriceUsd: livePrice.priceUsd,
        solUsdRate,
        priceUpdatedAt: livePrice.updatedAt,
        priceSource: livePrice.source,
        isStale: livePrice.isStale
      }
    });

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(pnlPayload);
      }
    }

    // Evaluate Take Profit / Stop Loss triggers (Skip if price is stale)
    if (!livePrice.isStale) {
      let triggerReason: 'TAKE_PROFIT' | 'STOP_LOSS' | null = null;
      if (pnlPercent >= pos.take_profit_percent) {
        triggerReason = 'TAKE_PROFIT';
      } else if (pnlPercent <= -pos.stop_loss_percent) {
        triggerReason = 'STOP_LOSS';
      }

      if (triggerReason) {
        exitingPositions.add(pos.id);
        executePositionExit(pos, livePrice.priceSol, currentValueSol, pnlSol, pnlPercent, triggerReason)
          .catch(err => console.error(`[Exit Engine] Trigger exit failed for position ${pos.id}:`, err))
          .finally(() => exitingPositions.delete(pos.id));
      }
    } else {
      console.warn(`[Exit Engine] Price for ${pos.token_symbol} is STALE (${Date.now() - livePrice.updatedAt}ms). Automatic TP/SL execution skipped.`);
    }
  }
}

// Execute partial sell (e.g. 25%, 50%, 75%) on an active position
async function executePartialSell(
  pos: Position,
  sellRatio: number, // 0.25, 0.50, etc. (between 0 and 1)
  triggerReason: 'PARTIAL' | 'MANUAL' = 'PARTIAL'
) {
  if (sellRatio >= 1) {
    // 100% full exit
    await executePositionExit(pos, pos.current_price, pos.current_value_sol, pos.unrealized_pnl_sol, pos.unrealized_pnl_percent, 'MANUAL');
    return;
  }

  const decimals = typeof pos.tokenDecimals === 'number' ? pos.tokenDecimals : (pos.token_decimals || 6);
  const originalBought = pos.tokenQuantity || formatTokenQuantity(pos.token_amount, decimals);
  const currentRemainingNum = parseTokenQuantity(pos.remainingTokenQuantity || pos.tokenQuantity);
  const tokensToSellNum = Number((currentRemainingNum * sellRatio).toFixed(decimals));
  const newRemainingNum = Math.max(0, Number((currentRemainingNum - tokensToSellNum).toFixed(decimals)));

  if (newRemainingNum <= 0) {
    await executePositionExit(pos, pos.current_price, pos.current_value_sol, pos.unrealized_pnl_sol, pos.unrealized_pnl_percent, 'MANUAL');
    return;
  }

  const solOut = Number((tokensToSellNum * pos.current_price).toFixed(4));
  const solInPortion = Number((pos.sol_in * sellRatio).toFixed(4));
  const pnlSol = Number((solOut - solInPortion).toFixed(4));
  const pnlPercent = solInPortion > 0 ? Number(((pnlSol / solInPortion) * 100).toFixed(2)) : 0;

  // Restore proceeds to paper balance
  const settings = db.getSettings();
  db.updateSettings({ paper_balance_sol: Number((settings.paper_balance_sol + solOut).toFixed(4)) });

  const remainingFormatted = formatTokenQuantity(newRemainingNum, decimals);
  const newSolIn = Number((pos.sol_in - solInPortion).toFixed(4));
  const newCurrentValue = Number((newRemainingNum * pos.current_price).toFixed(4));

  // Update active position with new remaining quantity
  db.updatePosition(pos.id, {
    remainingTokenQuantity: remainingFormatted,
    remainingQuantity: remainingFormatted,
    token_amount: newRemainingNum,
    sol_in: newSolIn,
    investedAmount: `${newSolIn.toFixed(4)} SOL`,
    current_value_sol: newCurrentValue,
    currentValue: `${newCurrentValue.toFixed(4)} SOL`
  });

  // Log trade entry for the partial sell
  db.addTrade({
    position_id: pos.id,
    token_mint: pos.token_mint,
    token_name: pos.token_name,
    token_symbol: pos.token_symbol,
    source_trader_id: pos.source_trader_id,
    source_trader_name: pos.source_trader_name,
    buy_signature: pos.buy_signature,
    sell_signature: `${pos.buy_signature}_partial_${Date.now()}`,
    sol_in: solInPortion,
    token_amount_bought: parseTokenQuantity(originalBought),
    tokenQuantityBought: originalBought,
    token_amount_sold: tokensToSellNum,
    tokenQuantitySold: formatTokenQuantity(tokensToSellNum, decimals),
    remainingQuantity: remainingFormatted,
    sol_out: solOut,
    entry_price: pos.entry_price,
    exit_price: pos.current_price,
    buy_time: pos.buy_time,
    sell_time: new Date().toISOString(),
    pnl_sol: pnlSol,
    pnl_percent: pnlPercent,
    sell_reason: triggerReason,
    mode: settings.trading_mode
  });

  console.log(`[Partial Sell] Sold ${formatTokenQuantity(tokensToSellNum, decimals)} of ${pos.token_symbol}. Remaining: ${remainingFormatted} tokens.`);
  broadcastState();
}

// On-chain wallet balance cross-check
async function reconcilePositionWithOnChainBalance(pos: Position): Promise<{ matched: boolean; onChainAmount?: number; message: string }> {
  if (!solanaConnection || !pos.token_mint || !isValidSolanaMint(pos.token_mint)) {
    return { matched: true, message: 'Paper trading mode or no active connection' };
  }

  try {
    const settings = db.getSettings();
    let targetWalletStr: string | null = null;

    if (pos.source_trader_id) {
      const traders = db.getTraderWallets();
      const trader = traders.find(t => t.id === pos.source_trader_id || t.wallet_address === pos.source_trader_id);
      if (trader && isValidSolanaMint(trader.wallet_address)) {
        targetWalletStr = trader.wallet_address;
      } else if (isValidSolanaMint(pos.source_trader_id)) {
        targetWalletStr = pos.source_trader_id;
      }
    }

    // If no valid base58 wallet address exists (e.g. paper mode with synthetic source_trader_id), skip safely
    if (!targetWalletStr || !isValidSolanaMint(targetWalletStr)) {
      return { matched: true, message: 'Paper trading mode (no on-chain wallet address)' };
    }

    const decimals = typeof pos.tokenDecimals === 'number' ? pos.tokenDecimals : (pos.token_decimals || 6);
    const ownerPubkey = new PublicKey(targetWalletStr);
    const mintPubkey = new PublicKey(pos.token_mint);

    const accounts = await solanaConnection.getParsedTokenAccountsByOwner(
      ownerPubkey, 
      { mint: mintPubkey }
    );

    if (accounts.value && accounts.value.length > 0) {
      const info = accounts.value[0].account.data.parsed.info;
      const uiAmount = info.tokenAmount.uiAmount || 0;
      const accDecimals = info.tokenAmount.decimals || decimals;
      const currentRecordedRemaining = parseTokenQuantity(pos.remainingTokenQuantity || pos.tokenQuantity);

      if (Math.abs(uiAmount - currentRecordedRemaining) > 0.0001) {
        console.warn(`[Reconcile] Discrepancy detected for ${pos.token_symbol}: Recorded=${currentRecordedRemaining}, OnChain=${uiAmount}`);
        db.updatePosition(pos.id, {
          remainingTokenQuantity: formatTokenQuantity(uiAmount, accDecimals),
          remainingQuantity: formatTokenQuantity(uiAmount, accDecimals),
          token_amount: uiAmount,
          tokenDecimals: accDecimals,
          token_decimals: accDecimals
        });
        broadcastState();
        return { matched: false, onChainAmount: uiAmount, message: `Reconciled with on-chain balance: ${formatTokenQuantity(uiAmount, accDecimals)}` };
      }
    }
  } catch (err: any) {
    console.warn(`[Reconcile] Skipped on-chain reconciliation for ${pos.token_mint}: ${err?.message || err}`);
  }
  return { matched: true, message: 'On-chain balance matches recorded position' };
}

// Execute 100% full position exit
async function executePositionExit(
  pos: Position, 
  exitPrice: number, 
  solOut: number, 
  pnlSol: number, 
  pnlPercent: number, 
  reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL' | 'ERROR_RECOVERY'
) {
  console.log(`[Exit Engine] TRIGGERED: Selling 100% of ${pos.token_symbol} (${pos.token_mint}). Reason: ${reason}. PnL: ${pnlPercent}%`);

  const decimals = typeof pos.tokenDecimals === 'number' ? pos.tokenDecimals : (pos.token_decimals || 6);
  const remainingNum = parseTokenQuantity(pos.remainingTokenQuantity || pos.tokenQuantity);

  // Move position to COMPLETED status and delete from active list
  db.updatePosition(pos.id, { status: 'SOLD', remainingTokenQuantity: '0', remainingQuantity: '0' });
  db.deletePosition(pos.id); // Remove from active list

  const settings = db.getSettings();

  // Restore paper balance with output SOL
  const updatedBalance = Number((settings.paper_balance_sol + solOut).toFixed(4));
  db.updateSettings({ paper_balance_sol: updatedBalance });

  // Record trade history
  db.addTrade({
    position_id: pos.id,
    token_mint: pos.token_mint,
    token_name: pos.token_name,
    token_symbol: pos.token_symbol,
    source_trader_id: pos.source_trader_id,
    source_trader_name: pos.source_trader_name,
    buy_signature: pos.buy_signature,
    sell_signature: pos.buy_signature + '_exit',
    sol_in: pos.sol_in,
    token_amount_bought: parseTokenQuantity(pos.tokenQuantity),
    tokenQuantityBought: pos.tokenQuantity,
    token_amount_sold: remainingNum,
    tokenQuantitySold: formatTokenQuantity(remainingNum, decimals),
    remainingQuantity: '0',
    sol_out: solOut,
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    buy_time: pos.buy_time,
    sell_time: new Date().toISOString(),
    pnl_sol: pnlSol,
    pnl_percent: pnlPercent,
    sell_reason: reason,
    mode: settings.trading_mode
  });

  // Centralized RebuyGuard update: records realized PnL and decides future rebuy eligibility
  await RebuyGuard.onPositionExited({
    mint: pos.token_mint,
    positionId: pos.id,
    tokenQuantity: pos.tokenQuantity,
    entryPrice: pos.entry_price,
    exitPrice,
    entryCost: pos.sol_in,
    exitProceeds: solOut,
    fees: 0,
    sellReason: reason
  });

  console.log(`[Exit Engine] SELL SUCCESS: Logged completed trade for ${pos.token_symbol}. Received ${solOut} SOL.`);
}

// Event-Driven Live Price Monitoring Engine:
// High-frequency live pricing (1-1.5s interval) via Jupiter batch API primary with DexScreener fallback.
livePriceService.startLiveMonitoring(
  () => {
    const active = db.getPositions().filter(p => p.status === 'ACTIVE');
    return active.map(p => p.token_mint);
  },
  handleLivePriceUpdate
);

// Periodic SOL/USD rate sync (every 60 seconds)
setInterval(updateSolUsdPrice, 60000);

// WebSocket Connection Handlers
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  clients.add(ws);

  // Send initial data state immediately
  ws.send(JSON.stringify({
    type: 'STATE_UPDATE',
    data: getSanitizedState()
  }));

  ws.on('message', async (message) => {
    try {
      const { type, action, data } = JSON.parse(message.toString());
      const actionType = type || action;
      console.log(`[WS] Received action: ${actionType}`);

      if (actionType === 'ADD_TRADER') {
        if (!isValidSolanaMint(data.wallet_address)) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid Solana Public Key address' }));
          return;
        }
        try {
          db.addTraderWallet({
            name: data.name,
            wallet_address: data.wallet_address,
            enabled: true
          });
          setupLogsSubscription();
          broadcastState();
        } catch (err: any) {
          ws.send(JSON.stringify({ type: 'ERROR', message: err?.message || 'Failed to add trader' }));
        }
      }

      else if (actionType === 'TOGGLE_TRADER') {
        db.updateTraderWallet(data.id, { enabled: data.enabled });
        setupLogsSubscription();
        broadcastState();
      }

      else if (actionType === 'DELETE_TRADER') {
        db.deleteTraderWallet(data.id);
        setupLogsSubscription();
        broadcastState();
      }

      else if (actionType === 'UPDATE_SETTINGS') {
        const updatePayload = { ...data };
        if (updatePayload.jupiter_api_key === '[CONFIGURED]') {
          delete updatePayload.jupiter_api_key;
        }
        db.updateSettings(updatePayload);
        if (data.rpc_url || data.wss_url) {
          await initSolanaConnection();
        } else {
          broadcastState();
        }
      }

      else if (actionType === 'CLOSE_POSITION') {
        const positions = db.getPositions();
        const pos = positions.find(p => p.id === data.id);
        if (pos) {
          await executePositionExit(pos, pos.current_price, pos.current_value_sol, pos.unrealized_pnl_sol, pos.unrealized_pnl_percent, 'MANUAL');
        }
      }

      else if (actionType === 'PARTIAL_SELL') {
        const positions = db.getPositions();
        const pos = positions.find(p => p.id === data.id);
        if (pos) {
          const ratio = typeof data.ratio === 'number' ? data.ratio : 0.5;
          await executePartialSell(pos, ratio, 'MANUAL');
        }
      }

      else if (actionType === 'RECONCILE_POSITION') {
        const positions = db.getPositions();
        const pos = positions.find(p => p.id === data.id);
        if (pos) {
          await reconcilePositionWithOnChainBalance(pos);
        }
      }

      else if (actionType === 'RESET_BALANCE') {
        db.updateSettings({ paper_balance_sol: 10.0 });
        broadcastState();
      }

      else if (actionType === 'RESET_GUARD_AND_HISTORY' || actionType === 'RESET_GUARD_HISTORY') {
        const result = await RebuyGuard.resetAll();
        broadcastState();
        ws.send(JSON.stringify({
          type: 'RESET_GUARD_HISTORY_SUCCESS',
          data: result
        }));
      }
    } catch (err) {
      console.error('[WS] Failed to parse client message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    clients.delete(ws);
  });
});

async function startServer() {
  // Vite dev mode integration or production static serving
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    try {
      const { createServer: createViteServer } = await import('vite');
      const viteDevServer = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(viteDevServer.middlewares);
    } catch (err) {
      console.warn('[Vite] Dev middleware initialization warning:', err);
    }
  }

  // Start HTTP server on port 3000
  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`[Server] Ultra Trading Bot listening on port ${PORT}`);
    // Initial SOL price sync
    await updateSolUsdPrice();
    // Initialize blockchain connection on startup
    await initSolanaConnection();
  });
}

startServer();
