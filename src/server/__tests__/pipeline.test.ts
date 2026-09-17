import { db } from '../../db';
import { TraderWalletRepository } from '../traderWalletRepository';
import { BuyAuthorizationService } from '../buyAuthorization';
import { RealExecutionService } from '../realExecutionService';
import { PaperExecutionService } from '../paperExecutionService';
import { ExecutionGateway } from '../executionGateway';
import { QuoteService } from '../quoteService';
import { LivePriceService } from '../priceService';
import { SolanaTransactionQueue } from '../transactionQueue';
import { SolanaRpcQueue } from '../rpcQueue';
import { MomentumService } from '../momentumService';
import { TransactionClassifier } from '../transactionClassifier';
import { RebuyGuard } from '../rebuyGuard';
import { isValidSolanaMint, isValidSolanaSignature } from '../../utils/solana';

async function runPipelineTests() {
  console.log('=== STARTING AUTOMATED PIPELINE VERIFICATION TESTS ===\n');
  let failures = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
    } else {
      console.error(`[FAIL] ${message}`);
      failures++;
    }
  }

  // TEST 1: Solana Mint & Signature Validation
  console.log('--- TEST 1: Solana Address & Signature Validation ---');
  const validMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const syntheticMint = 'mint_12345';
  const validSignature = '5K7mX4K3pY2R9tW8qL1vN6jM9xZ4wQ7vB3nC2mP5kL8rJ1tY4wV7xZ3qM9P2kL5r';
  const fakeSignature = 'buy_sig_fake_123';

  assert(isValidSolanaMint(validMint) === true, 'Valid Solana Public Key recognized');
  assert(isValidSolanaMint(syntheticMint) === false, 'Synthetic mint rejected');
  assert(isValidSolanaSignature(validSignature) === true, 'Genuine transaction signature recognized');
  assert(isValidSolanaSignature(fakeSignature) === false, 'Synthetic signature rejected');

  // TEST 2: Transaction Classification & Token Balance Deltas
  console.log('\n--- TEST 2: Transaction Classification & Balance Deltas ---');
  const traderWallet = '7vwQy2Xp2bB5n5mP5kL8rJ1tY4wV7xZ3qM9P2kL5r8aB';
  const targetTokenMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

  // 2a. Failed on-chain tx
  const failedTx = {
    meta: {
      err: { InstructionError: [0, 'CustomError'] },
      preBalances: [1000000000],
      postBalances: [999995000]
    },
    transaction: {
      message: {
        accountKeys: [traderWallet]
      }
    }
  };
  const failedClass = TransactionClassifier.classify(failedTx, traderWallet);
  assert(failedClass.type === 'FAILED', 'Failed on-chain transaction classified as FAILED');

  // 2b. BUY tx with positive balance delta and SOL spent
  const buyTx = {
    meta: {
      err: null,
      preBalances: [5000000000],
      postBalances: [4800000000], // 0.2 SOL spent
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: targetTokenMint,
          owner: traderWallet,
          uiTokenAmount: { amount: '0', decimals: 6 }
        }
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: targetTokenMint,
          owner: traderWallet,
          uiTokenAmount: { amount: '5000000000', decimals: 6 } // 5,000 tokens acquired
        }
      ]
    },
    transaction: {
      message: {
        accountKeys: [traderWallet, 'tokenAccount1']
      }
    }
  };
  const buyClass = TransactionClassifier.classify(buyTx, traderWallet);
  assert(buyClass.type === 'BUY', 'Transaction with positive token balance delta classified as BUY');
  assert(buyClass.mint === targetTokenMint, 'Correct non-base target mint extracted');
  assert(buyClass.tokenAcquiredAmount === 5000, 'Calculated correct token acquired amount from delta');
  assert(buyClass.solSpent! >= 0.19, 'Calculated correct SOL spent amount');

  // 2c. SELL tx with negative balance delta
  const sellTx = {
    meta: {
      err: null,
      preBalances: [4000000000],
      postBalances: [4500000000],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: targetTokenMint,
          owner: traderWallet,
          uiTokenAmount: { amount: '5000000000', decimals: 6 }
        }
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: targetTokenMint,
          owner: traderWallet,
          uiTokenAmount: { amount: '0', decimals: 6 }
        }
      ]
    },
    transaction: {
      message: {
        accountKeys: [traderWallet, 'tokenAccount1']
      }
    }
  };
  const sellClass = TransactionClassifier.classify(sellTx, traderWallet);
  assert(sellClass.type === 'SELL', 'Transaction with negative token balance delta classified as SELL');

  // 2d. BASE_COIN_ONLY swap (e.g. SOL to USDC)
  const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const baseSwapTx = {
    meta: {
      err: null,
      preBalances: [5000000000],
      postBalances: [4800000000],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: usdcMint,
          owner: traderWallet,
          uiTokenAmount: { amount: '0', decimals: 6 }
        }
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: usdcMint,
          owner: traderWallet,
          uiTokenAmount: { amount: '35000000', decimals: 6 }
        }
      ]
    },
    transaction: {
      message: {
        accountKeys: [traderWallet, 'tokenAccount1']
      }
    }
  };
  const baseSwapClass = TransactionClassifier.classify(baseSwapTx, traderWallet);
  assert(baseSwapClass.type === 'BASE_COIN_ONLY', 'Stablecoin/Base asset swap classified as BASE_COIN_ONLY');

  // 2e. Token balance deltas helper verification
  const deltas = TransactionClassifier.calculateTokenBalanceDeltas(
    buyTx.meta.preTokenBalances,
    buyTx.meta.postTokenBalances,
    traderWallet
  );
  const tokenDelta = deltas.get(targetTokenMint);
  assert(tokenDelta !== undefined && tokenDelta.deltaRaw === 5000000000, 'calculateTokenBalanceDeltas accurately computes net balance increase');

  // TEST 3: Trader Wallet Repository CRUD & Persistence
  console.log('\n--- TEST 3: Trader Wallet Repository CRUD & Persistence ---');
  const repo = TraderWalletRepository.getInstance(db);
  await repo.init();

  const testWalletAddress = '7vwQy2Xp2bB5n5mP5kL8rJ1tY4wV7xZ3qM9P2kL5r8aB';
  const testName = 'Test Persistence Trader';

  const userId = 'test_user';
  try {
    const added = await repo.addTraderWallet(userId, {
      name: testName,
      wallet_address: testWalletAddress,
      enabled: true
    });

    assert(Boolean(added.id), 'Trader wallet created with unique ID');
    assert(added.wallet_address === testWalletAddress, 'Trader wallet address preserved');

    const allWallets = await repo.getTraderWallets(userId);
    const found = allWallets.find(w => w.wallet_address === testWalletAddress);
    assert(Boolean(found), 'Trader wallet persisted and retrieved');

    // Duplicate check
    let duplicateRejected = false;
    try {
      await repo.addTraderWallet(userId, {
        name: 'Duplicate Trader',
        wallet_address: testWalletAddress
      });
    } catch {
      duplicateRejected = true;
    }
    assert(duplicateRejected, 'Duplicate trader wallet address rejected with error');

    // Toggle status
    const toggled = await repo.toggleTraderWallet(userId, added.id, false);
    assert(toggled?.enabled === false, 'Trader wallet status toggled to disabled');

    // Clean up
    await repo.deleteTraderWallet(userId, added.id);
    const afterDelete = await repo.getTraderWallets(userId);
    assert(!afterDelete.some(w => w.id === added.id), 'Trader wallet deleted successfully');
  } catch (err: any) {
    console.error('Persistence test error:', err);
    if (err?.message?.includes('Missing or insufficient permissions') || err?.message?.includes('PERSISTENCE_UNAVAILABLE')) {
      console.log('[SKIP] Skipping persistence test due to Firestore credentials/availability.');
    } else {
      assert(false, `Persistence test failed with exception: ${err?.message}`);
    }
  }

  // TEST 4: Queue Deduplication, Rate Limiting & Concurrency
  console.log('\n--- TEST 4: Queue Deduplication & Concurrency ---');
  const queue = SolanaTransactionQueue.getInstance(db, () => null);
  const testTrader = {
    id: 'trader_burst',
    user_id: 'default-user',
    name: 'Burst Test Trader',
    wallet_address: validMint,
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const testSig = '4A7mX4K3pY2R9tW8qL1vN6jM9xZ4wQ7vB3nC2mP5kL8rJ1tY4wV7xZ3qM9P2kL9a';
  const firstEnqueue = queue.enqueue(testSig, testTrader);
  const duplicateEnqueue = queue.enqueue(testSig, testTrader);
  assert(firstEnqueue === true, 'First signature enqueue accepted into transaction queue');
  assert(duplicateEnqueue === false, 'Duplicate signature in queue immediately rejected/deduplicated');

  // TEST 5: Solana RPC Queue 429 Handling & Retries
  console.log('\n--- TEST 5: Solana RPC Queue 429 Handling & Retries ---');
  const rpcQueue = SolanaRpcQueue.getInstance(() => null);
  const rpcMetricsBefore = rpcQueue.getMetrics();
  assert(typeof rpcMetricsBefore.rateLimit429Count === 'number', 'RPC Queue exposes rateLimit429Count metric');
  assert(typeof rpcMetricsBefore.queuedCount === 'number', 'RPC Queue exposes queuedCount metric');

  // TEST 6: Beginning Momentum Detection & Authorization
  console.log('\n--- TEST 6: Beginning Momentum Detection & Authorization ---');
  db.updateSettings({ enableRugCheck: false });
  const momentumService = MomentumService.getInstance();
  const testMint = '7GCih33JYaA2HGR22K2k6Pz9w5S1u5N3Q8m3P2kL5r8a';
  momentumService.recordTransaction(testMint, 'BUY', validSignature, 0.5);

  const mockCandidate: any = {
    tokenMint: testMint,
    tokenName: 'Early Momentum Token',
    tokenSymbol: 'EARLY',
    traderWallet: validMint,
    sourceSignature: validSignature,
    detectedAt: new Date().toISOString(),
    market: {
      tokenMint: testMint,
      priceUSD: 0.05,
      priceSOL: 0.0003,
      marketCapUSD: 250000,
      liquidityUSD: 45000,
      volumeUSD24h: 120000,
      timestamp: new Date().toISOString(),
      source: 'DexScreener'
    },
    security: {
      developerHoldingPct: 1.2,
      mintAuthority: null,
      freezeAuthority: null,
      lpLocked: true,
      rugcheckPassed: true,
      status: 'Good'
    },
    trader: {
      walletAddress: validMint,
      name: 'Alpha Trader',
      signals: 10,
      paperTrades: 5,
      winRate: 80,
      pnlSol: 12.5
    }
  };

  const evalResult = await BuyAuthorizationService.getInstance(db).evaluate(mockCandidate);
  assert(evalResult.decision === 'AUTHORIZED', 'Early momentum candidate (1 BUY) AUTHORIZED without 11-BUY gate');
  assert(evalResult.criteria.buyVelocityPassed === true, 'buyVelocityPassed is TRUE for beginning momentum candidate');

  // TEST 7: Rebuy Guard Rules: Profitable-Only & Maximum One Rebuy
  console.log('\n--- TEST 7: Rebuy Guard: Profitable-Only & Maximum One Rebuy ---');
  const rebuyMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const profitableMint = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

  // Clean up any stale active positions for test mints from previous test runs
  for (const pos of db.getPositions()) {
    if (pos.token_mint === rebuyMint || pos.token_mint === profitableMint) {
      db.deletePosition(pos.id);
    }
  }

  await RebuyGuard.resetAll();

  // 7a. Initial buy check on clean token
  const canInitialBuy = await RebuyGuard.canBuy(rebuyMint);
  assert(canInitialBuy.allowed === true && canInitialBuy.type === 'INITIAL_BUY', 'Initial buy on fresh token allowed');

  // Simulate execution of initial buy
  await RebuyGuard.onBuyExecuted({
    mint: rebuyMint,
    positionId: 'pos_1',
    tokenQuantity: '1000',
    entryPrice: 0.01,
    entryCost: 0.1,
    isRebuy: false
  });

  // 7b. Test LOSS exit -> Rebuy must be permanently blocked
  await RebuyGuard.onPositionExited({
    mint: rebuyMint,
    positionId: 'pos_1',
    entryCost: 0.1,
    exitProceeds: 0.05, // 0.05 SOL returned on 0.1 SOL cost -> -0.05 SOL (LOSS)
    entryPrice: 0.01,
    exitPrice: 0.005,
    sellReason: 'STOP_LOSS'
  });

  const canBuyAfterLoss = await RebuyGuard.canBuy(rebuyMint);
  assert(canBuyAfterLoss.allowed === false, 'Rebuy BLOCKED after losing trade');
  assert(canBuyAfterLoss.reason === 'PREVIOUS_TRADE_LOSS', 'Block reason accurately reported as PREVIOUS_TRADE_LOSS');

  // 7c. Test PROFIT exit -> Rebuy allowed once
  await RebuyGuard.onBuyExecuted({
    mint: profitableMint,
    positionId: 'pos_prof_1',
    tokenQuantity: '1000',
    entryPrice: 0.01,
    entryCost: 0.1,
    isRebuy: false
  });

  await RebuyGuard.onPositionExited({
    mint: profitableMint,
    positionId: 'pos_prof_1',
    entryCost: 0.1,
    exitProceeds: 0.15, // +0.05 SOL profit (+50%)
    entryPrice: 0.01,
    exitPrice: 0.015,
    sellReason: 'TAKE_PROFIT'
  });

  const canBuyAfterProfit = await RebuyGuard.canBuy(profitableMint);
  assert(canBuyAfterProfit.allowed === true, 'Rebuy ALLOWED after profitable trade');
  assert(canBuyAfterProfit.type === 'ONE_PROFITABLE_REBUY', 'Decision classified as ONE_PROFITABLE_REBUY');

  // 7d. Test Maximum One Rebuy: Execute rebuy and exit -> 3rd buy blocked permanently
  await RebuyGuard.onBuyExecuted({
    mint: profitableMint,
    positionId: 'pos_prof_2',
    tokenQuantity: '1000',
    entryPrice: 0.015,
    entryCost: 0.1,
    isRebuy: true
  });

  await RebuyGuard.onPositionExited({
    mint: profitableMint,
    positionId: 'pos_prof_2',
    entryCost: 0.1,
    exitProceeds: 0.15, // Even if 2nd trade was profitable!
    entryPrice: 0.015,
    exitPrice: 0.02,
    sellReason: 'TAKE_PROFIT'
  });

  const canBuyThirdTime = await RebuyGuard.canBuy(profitableMint);
  assert(canBuyThirdTime.allowed === false, 'Third buy BLOCKED (maximum 1 rebuy rule enforced)');
  assert(canBuyThirdTime.reason === 'MAX_REBUY_REACHED', 'Block reason accurately reported as MAX_REBUY_REACHED');

  // TEST 8: Execution Mode Paths (PAPER vs REAL)
  console.log('\n--- TEST 8: Execution Modes (PAPER vs REAL) ---');
  const realService = RealExecutionService.getInstance(db);
  const isSignerConfigured = realService.isSignerConfigured();
  
  if (!isSignerConfigured) {
    console.log('[Info] MAINNET_PRIVATE_KEY is not set. Testing fallback protection...');
    const result = await realService.executeBuy(
      validMint,
      'Test Token',
      'TEST',
      9,
      0.0001,
      'trader_1',
      'Trader One',
      validSignature,
      null
    );

    assert(result.success === false, 'REAL mode fails gracefully when signer key is unconfigured');
    assert(result.error === 'REAL_EXECUTION_BLOCKED_SIGNER_NOT_CONFIGURED', 'Returns REAL_EXECUTION_BLOCKED_SIGNER_NOT_CONFIGURED status');
  }

  // Paper execution test
  const paperMint = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  const paperSignature = ('3A4mX4K3pY2R9tW8qL1vN6jM9xZ4wQ7vB3nC2mP5kL8rJ1tY4wV7xZ3qM9P2kL9z' + Date.now().toString()).slice(0, 88);
  const paperPos = await PaperExecutionService.getInstance(db).executeBuy(
    paperMint,
    'Paper Token',
    'PAPER',
    9,
    0.0001,
    'trader_paper',
    'Paper Trader',
    paperSignature
  );
  assert(Boolean(paperPos), 'PAPER trade executed successfully');
  if (paperPos) {
    assert(paperPos.mint === paperMint, 'PAPER position mint matches candidate mint');
    db.deletePosition(paperPos.id);
  }

  // TEST 9: Comprehensive Paper Trading Audit Scenarios (Requirements 1-22)
  console.log('\n--- TEST 9: Comprehensive Paper Trading Audit Scenarios ---');
  const gateway = ExecutionGateway.getInstance(db);
  const paperExec = PaperExecutionService.getInstance(db);

  // Scenario 1: PAPER mode cannot execute MAINNET trades
  db.updateSettings({ trading_mode: 'PAPER', mainnet_enabled: true });
  assert(gateway.isRealMode() === false, 'PAPER mode prevents isRealMode even if mainnet_enabled is true');

  // Scenario 2: MAINNET mode requires explicit MAINNET setting
  db.updateSettings({ trading_mode: 'MAINNET', mainnet_enabled: true });
  assert(gateway.isRealMode() === true, 'MAINNET mode returns isRealMode true when mainnet_enabled is true');
  db.updateSettings({ trading_mode: 'PAPER', mainnet_enabled: false });

  // Scenario 3: Invalid price (0, NaN, null) causes order rejection
  const invalidPriceResult = await gateway.executeBuy({
    mint: 'So11111111111111111111111111111111111111112',
    tokenName: 'Bad Price Token',
    tokenSymbol: 'BADPRICE',
    decimals: 9,
    priceSol: 0,
    trader: { id: 't1', user_id: 'u1', name: 'Trader 1', wallet_address: '0x123', enabled: true, created_at: '', updated_at: '' },
    buySignature: 'sig_bad_price_1'
  });
  assert(invalidPriceResult.success === false, 'Zero priceSOL buy is rejected');
  assert(invalidPriceResult.status === 'FAILED', 'Invalid price status is FAILED');

  // Scenario 4: Paper buy failure results in FAILED status (not CONFIRMED)
  const nanPriceResult = await paperExec.executeBuyAtomically({
    mint: 'So11111111111111111111111111111111111111112',
    tokenName: 'NaN Price Token',
    tokenSymbol: 'NANPRICE',
    decimals: 9,
    priceSOL: NaN,
    sourceTraderId: 't1',
    sourceTraderName: 'Trader 1',
    buySignature: 'sig_nan_price_1'
  });
  assert(nanPriceResult.success === false && nanPriceResult.status === 'FAILED', 'NaN price returns FAILED status');

  // Scenario 5: Insufficient balance fails trade and balance remains unchanged
  db.updateSettings({ paper_balance_sol: 0.05, trading_amount_sol: 0.25 });
  const lowBalanceResult = await paperExec.executeBuyAtomically({
    mint: 'So11111111111111111111111111111111111111112',
    tokenName: 'Expensive Token',
    tokenSymbol: 'EXP',
    decimals: 9,
    priceSOL: 0.001,
    sourceTraderId: 't1',
    sourceTraderName: 'Trader 1',
    buySignature: 'sig_low_bal_1'
  });
  assert(lowBalanceResult.success === false, 'Insufficient balance buy is rejected');
  assert(lowBalanceResult.errorReason === 'INSUFFICIENT_BALANCE', 'Reports INSUFFICIENT_BALANCE reason');
  assert(db.getSettings().paper_balance_sol === 0.05, 'Paper balance remains unchanged on failure');

  // Scenario 6: Duplicate concurrent BUYs for same token produce only 1 position
  db.updateSettings({ paper_balance_sol: 10.0, trading_amount_sol: 0.25 });
  const auditMint = 'AuditMint1111111111111111111111111111111111';
  const buy1 = await paperExec.executeBuyAtomically({
    mint: auditMint,
    tokenName: 'Audit Token',
    tokenSymbol: 'AUDIT',
    decimals: 6,
    priceSOL: 0.0001,
    sourceTraderId: 't1',
    sourceTraderName: 'Trader 1',
    buySignature: 'sig_audit_1'
  });
  assert(buy1.success === true && buy1.status === 'CONFIRMED', 'First buy order succeeds');

  const buy2 = await paperExec.executeBuyAtomically({
    mint: auditMint,
    tokenName: 'Audit Token',
    tokenSymbol: 'AUDIT',
    decimals: 6,
    priceSOL: 0.0001,
    sourceTraderId: 't1',
    sourceTraderName: 'Trader 1',
    buySignature: 'sig_audit_2'
  });
  assert(buy2.success === false, 'Duplicate buy for active position is rejected');
  assert(buy2.errorReason === 'POSITION_ALREADY_HELD', 'Reason reported as POSITION_ALREADY_HELD');

  // Scenario 7: Atomic SELL closes position and credits paper balance
  const initialBalanceBeforeSell = db.getSettings().paper_balance_sol;
  assert(buy1.position !== undefined, 'Position exists for sell test');
  if (buy1.position) {
    const sellResult = await paperExec.executeSellAtomically({
      position: buy1.position,
      currentPriceSol: 0.00015,
      reason: 'MANUAL'
    });
    assert(sellResult.success === true && sellResult.status === 'CONFIRMED', 'Atomic SELL executed successfully');
    assert(db.getSettings().paper_balance_sol > initialBalanceBeforeSell, 'Paper balance credited after sell');
    assert(db.getPositions().some(p => p.id === buy1.position!.id) === false, 'Position removed from active list');
  }

  // Scenario 8: Manual SELL uses current fresh price
  const freshBuy = await paperExec.executeBuyAtomically({
    mint: 'FreshMint11111111111111111111111111111111111',
    tokenName: 'Fresh Token',
    tokenSymbol: 'FRESH',
    decimals: 6,
    priceSOL: 0.0002,
    sourceTraderId: 't1',
    sourceTraderName: 'Trader 1',
    buySignature: 'sig_fresh_1'
  });
  if (freshBuy.position) {
    const freshSell = await paperExec.executeSellAtomically({
      position: freshBuy.position,
      currentPriceSol: 0.0003,
      reason: 'MANUAL'
    });
    assert(freshSell.success === true, 'Manual sell with fresh price executed');
    assert(freshSell.trade?.exit_price === freshSell.quote?.priceSol, 'Trade recorded with exact fresh exit price from quote');
  }

  // Scenario 9-11: Validate partial sell removal
  assert(typeof (db as any).executePartialSell === 'undefined', 'executePartialSell function removed from server db');

  console.log(`\n=== PIPELINE VERIFICATION SUMMARY: ${failures === 0 ? 'ALL TESTS PASSED SUCCESSFULLY' : `${failures} TEST(S) FAILED`} ===`);
  if (failures > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPipelineTests();
