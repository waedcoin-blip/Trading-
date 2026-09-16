import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { Connection, PublicKey } from '@solana/web3.js';
import { db } from './src/db.js';
import { scoreToken } from './src/server/ai.js';
import { RebuyGuard } from './src/server/rebuyGuard.js';
import { getRugCheckReport, validateRugCheck } from './src/server/rugcheck.js';
import { BuyAuthorizationService } from './src/server/buyAuthorization.js';
import { MomentumService } from './src/server/momentumService.js';
import { PaperExecutionService } from './src/server/paperExecutionService.js';
import { UnifiedExitService } from './src/server/unifiedExitService.js';
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
import { jupiterService } from './src/server/jupiterService.js';
import { aiLearningEngine } from './src/server/aiLearningEngine.js';
import { TokenDiscoveryService } from './src/server/tokenDiscoveryService.js';
import { TraderWalletRepository } from './src/server/traderWalletRepository.js';
import { RealExecutionService } from './src/server/realExecutionService.js';
import { PipelineDiagnostics } from './src/types.js';

// Environment-resilient directory resolution for CJS and ESM execution
const appDir = typeof __dirname !== 'undefined'
  ? __dirname
  : (import.meta && import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd());

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Helper to construct sanitized state without exposing sensitive secrets
async function getSanitizedState() {
  const rawSettings = db.getSettings();
  const sanitizedSettings: Settings = {
    ...rawSettings
  };
  delete (sanitizedSettings as any).jupiter_api_key;

  currentConnectionStatus.jupiter = jupiterService.getStatus();

  const traderWallets = await TraderWalletRepository.getInstance(db).getTraderWallets();
  const traderStatuses = TraderWalletRepository.getInstance(db).getMonitoringStatuses();

  const pipeline: PipelineDiagnostics = {
    traderMonitoring: solanaConnection ? 'CONNECTED' : 'DISCONNECTED',
    traderBuyDetection: 'ACTIVE',
    tokenDiscovery: 'ACTIVE',
    dexScreener: 'CONNECTED',
    rugCheck: rawSettings.enableRugCheck ? 'CONNECTED' : 'DISABLED',
    momentumEngine: 'ACTIVE',
    aiAuthorization: 'ACTIVE',
    jupiter: jupiterService.getStatus(),
    execution: rawSettings.trading_mode === 'PAPER' 
      ? 'PAPER_ONLY' 
      : (RealExecutionService.getInstance(db).isSignerConfigured() ? 'READY' : 'NOT_CONFIGURED')
  };

  currentConnectionStatus.pipeline = pipeline;
  currentConnectionStatus.traderStatuses = traderStatuses;

  return {
    settings: sanitizedSettings,
    traders: traderWallets,
    observations: db.getTokenObservations(),
    discoveryFeed: TokenDiscoveryService.getInstance(db).getFeedState(),
    positions: db.getPositions(),
    trades: db.getTrades(),
    connection: currentConnectionStatus,
    aiStats: db.getAIStats(),
    rebuyStates: db.getRebuyStates(),
    aiLearningSummary: aiLearningEngine.getSummary(),
    buy_authorization_audits: db.getBuyAuthorizationAudits()
  };
}

// API: Real-Time Token Discovery & Filter Feed API (Requirement 9)
app.get(['/api/discovery/feed', '/api/discovery'], (req, res) => {
  const feedState = TokenDiscoveryService.getInstance(db).getFeedState();
  res.json({
    success: feedState.status !== 'FAILED',
    timestamp: feedState.timestamp,
    nextRefreshAt: feedState.nextRefreshAt,
    status: feedState.status,
    error: feedState.error,
    tokens: feedState.tokens || []
  });
});

app.post('/api/discovery/refresh', async (req, res) => {
  await TokenDiscoveryService.getInstance(db).runRefreshCycle();
  const feedState = TokenDiscoveryService.getInstance(db).getFeedState();
  res.json({
    success: feedState.status !== 'FAILED',
    timestamp: feedState.timestamp,
    nextRefreshAt: feedState.nextRefreshAt,
    status: feedState.status,
    error: feedState.error,
    tokens: feedState.tokens || []
  });
});

// API: Health endpoint for Render & local health checks
app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'trading-server',
    uptimeSec: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// API: Real Jupiter V3 Health Diagnostic Endpoint
app.get('/api/jupiter/health', async (req, res) => {
  try {
    const health = await jupiterService.getHealth();
    res.json(health);
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      status: 'CONNECTION_ERROR',
      latencyMs: 0,
      error: err?.message || 'Failed to query Jupiter health',
      timestamp: Date.now(),
      configured: Boolean(jupiterService.getApiKey()),
      endpointVersion: 'V3'
    });
  }
});

// API: Get current state
app.get('/api/state', async (req, res) => {
  res.json(await getSanitizedState());
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

// --- API: AI Learning Engine Endpoints ---
app.get('/api/ai/learning', (req, res) => {
  res.json(aiLearningEngine.getSummary());
});

app.get('/api/ai/learning/patterns', (req, res) => {
  res.json({
    winningPatterns: aiLearningEngine.getTopWinningPatterns(),
    losingPatterns: aiLearningEngine.getTopLosingPatterns()
  });
});

app.get('/api/ai/learning/traders', (req, res) => {
  res.json({ traders: aiLearningEngine.getTraderIntelligence() });
});

app.get('/api/ai/learning/performance', (req, res) => {
  res.json(aiLearningEngine.getAIPerformanceMetrics());
});

app.get('/api/ai/learning/score/:mint', async (req, res) => {
  const { mint } = req.params;
  const observations = db.getTokenObservations();
  const obs = observations.find(o => o.token_mint === mint);
  if (!obs) {
    return res.status(404).json({ success: false, error: 'Token observation not found' });
  }
  const evalResult = await scoreToken(obs, db.getTrades());
  res.json(evalResult);
});

app.post('/api/ai/learning/reset', (req, res) => {
  try {
    const result = aiLearningEngine.resetLearning();
    broadcastState();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to reset AI learning' });
  }
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
        const repo = TraderWalletRepository.getInstance(db);
        const added = await repo.addTraderWallet({
          name: data.name,
          wallet_address: data.wallet_address,
          enabled: true
        });
        await setupLogsSubscription();
        await broadcastState();
        res.json({ success: true, trader: added });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err?.message || 'Failed to add trader' });
      }
    }
    else if (actionType === 'TOGGLE_TRADER') {
      try {
        const repo = TraderWalletRepository.getInstance(db);
        await repo.toggleTraderWallet(data.id, data.enabled);
        await setupLogsSubscription();
        await broadcastState();
        res.json({ success: true });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err?.message || 'Failed to toggle trader' });
      }
    }
    else if (actionType === 'DELETE_TRADER') {
      try {
        const repo = TraderWalletRepository.getInstance(db);
        await repo.deleteTraderWallet(data.id);
        await setupLogsSubscription();
        await broadcastState();
        res.json({ success: true });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err?.message || 'Failed to delete trader' });
      }
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
        await UnifiedExitService.getInstance(db).executeManualExit(pos, pos.current_price, () => {
          broadcastState();
        });
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
    else if (actionType === 'RESET_AI_LEARNING') {
      const result = aiLearningEngine.resetLearning();
      broadcastState();
      res.json({
        success: true,
        recordsCleared: result.recordsCleared,
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
async function broadcastState() {
  try {
    const state = await getSanitizedState();
    const payload = JSON.stringify({ type: 'STATE_UPDATE', data: state });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  } catch (err) {
    console.error('[broadcastState] Error building state update:', err);
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
  currentConnectionStatus.jupiter = jupiterService.getStatus();

  // LaserStream configuration status
  if (settings.laserstream_key) {
    currentConnectionStatus.laserstream = 'CONNECTED';
  } else {
    currentConnectionStatus.laserstream = 'DISCONNECTED';
  }

  broadcastState();
}

// Unsubscribe and subscribe to all enabled trader wallets' logs on Solana
async function setupLogsSubscription() {
  if (!solanaConnection) return;

  // Clear existing subscriptions
  for (const subId of activeLogSubscriptions) {
    try {
      await solanaConnection.removeOnLogsListener(subId);
    } catch (err) {
      console.error('[Solana] Error removing log listener', err);
    }
  }
  activeLogSubscriptions = [];

  const repo = TraderWalletRepository.getInstance(db);
  const allTraders = await repo.getTraderWallets();
  const enabledTraders = allTraders.filter(t => t.enabled);

  if (enabledTraders.length === 0) {
    console.log('[Solana] No enabled trader wallets to monitor.');
    return;
  }

  console.log(`[Solana] Setting up on-chain log subscriptions for ${enabledTraders.length} trader(s)...`);

  for (const trader of enabledTraders) {
    if (!isValidSolanaMint(trader.wallet_address)) {
      console.warn(`[Solana] Skipping invalid trader wallet address: ${trader.wallet_address}`);
      repo.updateTraderMonitoringStatus(trader.id, {
        traderName: trader.name,
        walletAddress: trader.wallet_address,
        subscriptionStatus: 'ERROR',
        lastError: 'Invalid Solana Public Key address'
      });
      continue;
    }

    try {
      const pubkey = new PublicKey(trader.wallet_address);
      const subId = solanaConnection.onLogs(
        pubkey,
        async (logs) => {
          if (!logs.signature || processedSignatures.has(logs.signature)) return;
          console.log(`[Solana] Real on-chain log event detected on wallet ${trader.name} (${trader.wallet_address}). Signature: ${logs.signature}`);
          
          repo.updateTraderMonitoringStatus(trader.id, {
            lastDetectedSignature: logs.signature,
            lastProcessedTimestamp: new Date().toISOString(),
            subscriptionStatus: 'MONITORING',
            lastError: null
          });

          // Process transaction in background
          processDetectedTransaction(logs.signature, trader);
        },
        'confirmed'
      );

      activeLogSubscriptions.push(subId);
      repo.updateTraderMonitoringStatus(trader.id, {
        traderName: trader.name,
        walletAddress: trader.wallet_address,
        subscriptionId: subId,
        subscriptionStatus: 'CONNECTED',
        lastError: null
      });

      console.log(`[Solana] Log listener active (ID: ${subId}) for trader: ${trader.name}`);
    } catch (err: any) {
      console.error(`[Solana] Failed to subscribe to logs for trader ${trader.name}:`, err);
      repo.updateTraderMonitoringStatus(trader.id, {
        traderName: trader.name,
        walletAddress: trader.wallet_address,
        subscriptionStatus: 'ERROR',
        lastError: err?.message || 'Failed to establish log listener subscription'
      });
    }
  }
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

    // Retrieve full parsed transaction from blockchain (supports both Version 0 and Version 1 transactions)
    let tx = null;
    try {
      tx = await solanaConnection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });
    } catch (verErr: any) {
      try {
        tx = await solanaConnection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 1,
          commitment: 'confirmed'
        });
      } catch (retryErr: any) {
        console.warn(`[Monitor] Could not parse transaction ${signature}: ${retryErr?.message || retryErr}`);
        return;
      }
    }

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

    // Record in rolling MomentumService for unique buyers/10s calculations
    MomentumService.getInstance().recordTransaction(targetMint, 'BUY', signature, solSpent);

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
      buyers_10s: 0,
      price: price,
      status: 'REJECT',
      rejection_reason: 'Required market metrics unavailable on DexScreener',
      source_trader_name: trader.name
    });
    broadcastState();
    return;
  }

  // Mandatory RugCheck Security Check
  let rugCheck = await getRugCheckReport(mint);
  let rugCheckPassed = false;
  const settings = db.getSettings();
  if (settings.enableRugCheck) {
    const rugValidation = validateRugCheck(rugCheck, settings);
    rugCheckPassed = rugValidation.passed;
  } else {
    rugCheckPassed = true;
  }

  // Construct TradeCandidate
  const candidate = {
    tokenMint: mint,
    tokenName,
    tokenSymbol,
    traderWallet: trader.wallet_address,
    sourceSignature: buyDetails.signature,
    detectedAt: new Date().toISOString(),
    market: {
      tokenMint: mint,
      priceUSD: price,
      priceSOL: cachedSolUsdPrice > 0 ? price / cachedSolUsdPrice : 0,
      marketCapUSD: marketCap,
      liquidityUSD: liquidity,
      volumeUSD24h: volume24h,
      timestamp: new Date().toISOString(),
      source: 'DexScreener'
    },
    security: {
      developerHoldingPct: typeof developerHoldingPercent === 'number' ? developerHoldingPercent : 0,
      mintAuthority: rugCheck?.mintAuthority || null,
      freezeAuthority: rugCheck?.freezeAuthority || null,
      lpLocked: rugCheck?.lpLocked || false,
      rugcheckPassed: rugCheckPassed,
      status: rugCheck?.riskLevel || 'Unknown'
    },
    trader: {
      walletAddress: trader.wallet_address,
      name: trader.name,
      signals: 0,
      paperTrades: 0,
      winRate: 0,
      pnlSol: 0
    }
  };

  // Evaluate using Deterministic BuyAuthorizationService
  const decision = await BuyAuthorizationService.getInstance(db).evaluate(candidate);

  // Run AI scoring gate for extra stats enrichment (does not bypass filters)
  let aiResult: { score: number; confidence?: number; signals: { positive: string[]; risks: string[] } } | null = null;
  try {
    const previousTrades = db.getTrades();
    aiResult = await scoreToken({
      token_mint: mint,
      token_name: tokenName,
      token_symbol: tokenSymbol,
      market_cap: marketCap,
      liquidity: liquidity,
      volume_24h: volume24h,
      developer_holding_percent: developerHoldingPercent,
      buyers_10s: decision.criteria.buyTxCount10s,
      price: price,
      status: 'WAIT'
    }, previousTrades);
  } catch (err) {
    console.error('[Filters] AI scoring errored:', err);
  }

  const isEligible = decision.decision === 'AUTHORIZED';
  const status = isEligible ? 'ELIGIBLE' : 'REJECT';

  // Persist observation (safely upserting via normalized mint address)
  db.addTokenObservation({
    token_mint: mint,
    token_name: tokenName,
    token_symbol: tokenSymbol,
    market_cap: marketCap,
    liquidity: liquidity,
    volume_24h: volume24h,
    developer_holding_percent: developerHoldingPercent,
    buyers_10s: decision.criteria.buyTxCount10s,
    price: price,
    status,
    rejection_reason: decision.rejectReasons.join(', ') || undefined,
    source_trader_name: trader.name,
    ai_score: aiResult ? aiResult.score : undefined,
    ai_signals: aiResult ? aiResult.signals : undefined,
    rugcheck: rugCheck,
    rugcheck_passed: rugCheckPassed
  });

  // Track execution details for audit
  let executionSnapshot: any = {
    mode: settings.trading_mode,
    mainnetEnabled: settings.mainnet_enabled,
    status: isEligible ? 'EXECUTING' : 'REJECTED'
  };

  // If eligible, execute trade entry (PAPER vs REAL mainnet execution)
  if (isEligible) {
    const priceSol = cachedSolUsdPrice > 0 ? (typeof price === 'number' ? price / cachedSolUsdPrice : 0.000001) : 0.000001;
    const isRealMode = settings.trading_mode === 'MAINNET' || settings.mainnet_enabled === true;

    if (!isRealMode) {
      console.log(`[PaperExecution] Executing PAPER trade for ${tokenSymbol} (${mint})...`);
      const paperPos = PaperExecutionService.getInstance(db).executeBuy(
        mint,
        tokenName,
        tokenSymbol,
        decimals,
        priceSol,
        trader.id,
        trader.name,
        buyDetails.signature
      );
      executionSnapshot = {
        mode: 'PAPER',
        status: 'CONFIRMED',
        details: 'PAPER TRADE',
        positionId: paperPos.mint
      };
    } else {
      console.log(`[RealExecution] Executing REAL MAINNET trade for ${tokenSymbol} (${mint})...`);
      const realResult = await RealExecutionService.getInstance(db).executeBuy(
        mint,
        tokenName,
        tokenSymbol,
        decimals,
        priceSol,
        trader.id,
        trader.name,
        buyDetails.signature,
        solanaConnection
      );

      executionSnapshot = {
        mode: 'MAINNET',
        status: realResult.success ? 'CONFIRMED' : 'FAILED',
        signature: realResult.signature,
        error: realResult.error,
        details: realResult.details
      };
    }
  }

  // Record complete BuyAuthorizationAudit entry
  db.addBuyAuthorizationAudit({
    candidateId: mint,
    tokenMint: mint,
    tokenName: tokenName,
    tokenSymbol: tokenSymbol,
    traderWallet: trader.wallet_address,
    sourceSignature: buyDetails.signature,
    marketSnapshotJSON: JSON.stringify(candidate.market),
    securitySnapshotJSON: JSON.stringify(candidate.security),
    momentumSnapshotJSON: JSON.stringify(decision.momentum),
    traderSnapshotJSON: JSON.stringify(candidate.trader),
    executionSnapshotJSON: JSON.stringify(executionSnapshot),
    decision: decision.decision,
    rejectReasons: decision.rejectReasons,
    strategyVersion: decision.strategyVersion
  });

  await broadcastState();
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
  aiConfidence?: number;
  aiSignals?: { positive: string[]; risks: string[] };
  marketCap?: number | 'UNKNOWN';
  liquidity?: number | 'UNKNOWN';
  volume24h?: number | 'UNKNOWN';
  buyers10s?: number | 'UNKNOWN';
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
    rugcheck: activeRugCheck,

    // Trailing stop tracking
    peak_pnl_percent: 0,
    peak_price: entryPriceSol,
    trailing_stop_armed: false,

    // Entry snapshot for AI learning
    ai_score_at_entry: params.aiScore,
    ai_confidence_at_entry: params.aiConfidence ?? 65,
    ai_signals_at_entry: params.aiSignals,
    market_cap_at_entry: params.marketCap ?? 'UNKNOWN',
    liquidity_at_entry: params.liquidity ?? 'UNKNOWN',
    volume_24h_at_entry: params.volume24h ?? 'UNKNOWN',
    buyers_10s_at_entry: params.buyers10s ?? 'UNKNOWN'
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

    // 1. Let UnifiedExitService evaluate triggers and execute exits
    UnifiedExitService.getInstance(db).evaluateExitTriggers(
      pos,
      livePrice.priceSol,
      livePrice.isStale,
      (exitedPos, completedTrade, reason) => {
        // Callback when an exit is successfully executed
        console.log(`[Exit Engine] Broadcast state post-exit for ${exitedPos.token_symbol}. Reason: ${reason}`);
        broadcastState();
      }
    );

    // 2. Fetch updated state for live broadcasting
    const updatedPos = db.getPositions().find(p => p.id === pos.id);
    if (!updatedPos || updatedPos.status !== 'ACTIVE') continue;

    // Broadcast targeted POSITION_PNL_UPDATE for instant UI update
    const pnlPayload = JSON.stringify({
      type: 'POSITION_PNL_UPDATE',
      data: {
        positionId: pos.id,
        mint: pos.token_mint,
        pnlSol: updatedPos.unrealized_pnl_sol,
        pnlPercent: updatedPos.unrealized_pnl_percent,
        currentValueSol: updatedPos.current_value_sol,
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
    await UnifiedExitService.getInstance(db).executeManualExit(pos, pos.current_price, () => {
      broadcastState();
    });
    return;
  }

  const decimals = typeof pos.tokenDecimals === 'number' ? pos.tokenDecimals : (pos.token_decimals || 6);
  const originalBought = pos.tokenQuantity || formatTokenQuantity(pos.token_amount, decimals);
  const currentRemainingNum = parseTokenQuantity(pos.remainingTokenQuantity || pos.tokenQuantity);
  const tokensToSellNum = Number((currentRemainingNum * sellRatio).toFixed(decimals));
  const newRemainingNum = Math.max(0, Number((currentRemainingNum - tokensToSellNum).toFixed(decimals)));

  if (newRemainingNum <= 0) {
    await UnifiedExitService.getInstance(db).executeManualExit(pos, pos.current_price, () => {
      broadcastState();
    });
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
  const partialTrade = db.addTrade({
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

  // Learn from completed partial trade
  aiLearningEngine.learnFromCompletedTrade(partialTrade, pos);

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
          const repo = TraderWalletRepository.getInstance(db);
          await repo.addTraderWallet({
            name: data.name,
            wallet_address: data.wallet_address,
            enabled: true
          });
          await setupLogsSubscription();
          await broadcastState();
        } catch (err: any) {
          ws.send(JSON.stringify({ type: 'ERROR', message: err?.message || 'Failed to add trader' }));
        }
      }

      else if (actionType === 'TOGGLE_TRADER') {
        const repo = TraderWalletRepository.getInstance(db);
        await repo.toggleTraderWallet(data.id, data.enabled);
        await setupLogsSubscription();
        await broadcastState();
      }

      else if (actionType === 'DELETE_TRADER') {
        const repo = TraderWalletRepository.getInstance(db);
        await repo.deleteTraderWallet(data.id);
        await setupLogsSubscription();
        await broadcastState();
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
          await UnifiedExitService.getInstance(db).executeManualExit(pos, pos.current_price, () => {
            broadcastState();
          });
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
    const distPath = fs.existsSync(path.join(appDir, 'index.html'))
      ? appDir
      : path.join(process.cwd(), 'dist');

    console.log(`[Production] Serving static frontend SPA assets from: ${distPath}`);
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
    
    // Initialize persistence repository (PostgreSQL or JSON fallback)
    await TraderWalletRepository.getInstance(db).init();

    // Initial SOL price sync
    await updateSolUsdPrice();
    // Initialize blockchain connection on startup
    await initSolanaConnection();

    // Initialize & start authoritative 120s Token Discovery Service (Requirement 1, 10, 14)
    TokenDiscoveryService.getInstance(db).start((feedState) => {
      // Broadcast WebSocket TOKEN_DISCOVERY_REFRESHED event to all clients
      const discoveryPayload = JSON.stringify({
        type: 'TOKEN_DISCOVERY_REFRESHED',
        data: feedState
      });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(discoveryPayload);
        }
      }
      broadcastState();
    });
  });
}

startServer();
