import { db } from '../../db';
import { TraderWalletRepository } from '../traderWalletRepository';
import { BuyAuthorizationService } from '../buyAuthorization';
import { RealExecutionService } from '../realExecutionService';
import { PaperExecutionService } from '../paperExecutionService';
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

  // TEST 2: Trader Wallet Repository Persistence
  console.log('\n--- TEST 2: Trader Wallet Repository Persistence ---');
  const repo = TraderWalletRepository.getInstance(db);
  await repo.init();

  const testWalletAddress = '7vwQy2Xp2bB5n5mP5kL8rJ1tY4wV7xZ3qM9P2kL5r8aB';
  const testName = 'Test Persistence Trader';

  try {
    const added = await repo.addTraderWallet({
      name: testName,
      wallet_address: testWalletAddress,
      enabled: true
    });

    assert(Boolean(added.id), 'Trader wallet created with unique ID');
    assert(added.wallet_address === testWalletAddress, 'Trader wallet address preserved');

    const allWallets = await repo.getTraderWallets();
    const found = allWallets.find(w => w.wallet_address === testWalletAddress);
    assert(Boolean(found), 'Trader wallet persisted and retrieved');

    // Toggle status
    const toggled = await repo.toggleTraderWallet(added.id, false);
    assert(toggled?.enabled === false, 'Trader wallet status toggled to disabled');

    // Clean up
    await repo.deleteTraderWallet(added.id);
    const afterDelete = await repo.getTraderWallets();
    assert(!afterDelete.some(w => w.id === added.id), 'Trader wallet deleted successfully');
  } catch (err: any) {
    console.error('Persistence test error:', err);
    assert(false, `Persistence test failed with exception: ${err?.message}`);
  }

  // TEST 3: Monitoring Diagnostics Tracking
  console.log('\n--- TEST 3: Monitored Trader Diagnostic Tracker ---');
  const mockTraderId = 'trader_diag_1';
  repo.updateTraderMonitoringStatus(mockTraderId, {
    traderId: mockTraderId,
    traderName: 'Diagnostic Monitored Trader',
    walletAddress: validMint,
    subscriptionStatus: 'MONITORING',
    lastDetectedSignature: validSignature,
    lastProcessedTimestamp: new Date().toISOString()
  });

  const statuses = repo.getMonitoringStatuses();
  const diagStatus = statuses[mockTraderId];
  assert(Boolean(diagStatus), 'Trader monitoring status tracked');
  assert(diagStatus?.subscriptionStatus === 'MONITORING', 'Subscription status correctly reported as MONITORING');
  assert(diagStatus?.lastDetectedSignature === validSignature, 'Last detected signature recorded');

  // TEST 4: Buy Authorization & Safety Filter Pipeline
  console.log('\n--- TEST 4: Buy Authorization & Safety Filter Pipeline ---');
  const mockCandidate: any = {
    tokenMint: validMint,
    tokenName: 'Test Pipeline Token',
    tokenSymbol: 'TESTPIPE',
    traderWallet: validMint,
    sourceSignature: validSignature,
    detectedAt: new Date().toISOString(),
    market: {
      tokenMint: validMint,
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
    momentum: {
      buyTxCount5s: 4,
      buyTxCount10s: 8,
      buyTxCount30s: 15,
      buyVolume10s: 2500,
      sellVolume10s: 300,
      priceChange10s: 5.2,
      priceChange30s: 12.0,
      priceChange5m: 25.0,
      buyAcceleration: 2.0,
      buyTxIncreasing: true,
      buyVelocityIncreasing: true,
      volumeIncreasing: true,
      priceMovingPositively: true,
      earlyMomentumDetected: true
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
  assert(evalResult.decision === 'AUTHORIZED' || evalResult.decision === 'REJECTED', 'Evaluation produces explicit AUTHORIZED or REJECTED decision');
  assert(Array.isArray(evalResult.rejectReasons), 'Evaluation produces structured rejection reasons array');

  // TEST 5: Execution Mode Paths (PAPER vs REAL)
  console.log('\n--- TEST 5: Execution Modes (PAPER vs REAL) ---');
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
  } else {
    console.log('[Info] MAINNET_PRIVATE_KEY is set in environment.');
  }

  // Paper execution test
  const paperPos = PaperExecutionService.getInstance(db).executeBuy(
    validMint,
    'Paper Token',
    'PAPER',
    9,
    0.0001,
    'trader_paper',
    'Paper Trader',
    validSignature
  );
  assert(Boolean(paperPos), 'PAPER trade executed successfully');
  assert(paperPos.mint === validMint, 'PAPER position mint matches candidate mint');

  console.log(`\n=== PIPELINE VERIFICATION SUMMARY: ${failures === 0 ? 'ALL TESTS PASSED SUCCESSFULLY' : `${failures} TEST(S) FAILED`} ===`);
  if (failures > 0) {
    process.exit(1);
  }
}

runPipelineTests();
