import { db } from '../../db';
import { TraderWalletRepository } from '../traderWalletRepository';
import { BuyAuthorizationService } from '../buyAuthorization';
import { RealExecutionService } from '../realExecutionService';
import { PaperExecutionService } from '../paperExecutionService';
import { SolanaTransactionQueue } from '../transactionQueue';
import { MomentumService } from '../momentumService';
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

  // TEST 3: SolanaTransactionQueue Rate Limiting & Concurrency Burst Handling
  console.log('\n--- TEST 3: SolanaTransactionQueue Concurrency & Burst Handling ---');
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

  // Enqueue 20 genuine signatures
  let enqueuedCount = 0;
  for (let i = 0; i < 20; i++) {
    const sig = `${validSignature.substring(0, 50)}${i.toString().padStart(2, '0')}${validSignature.substring(52)}`;
    if (queue.enqueue(sig, testTrader)) {
      enqueuedCount++;
    }
  }

  const metrics = queue.getMetrics();
  assert(enqueuedCount > 0, `Enqueued burst of ${enqueuedCount} signatures into transaction queue`);
  assert(metrics.queuedCount > 0, `Queue metrics confirm ${metrics.queuedCount} items waiting in queue`);

  // TEST 4: Beginning Momentum Detection & Authorization
  console.log('\n--- TEST 4: Beginning Momentum Detection & Authorization ---');
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
  const paperMint = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  const paperSignature = '3A4mX4K3pY2R9tW8qL1vN6jM9xZ4wQ7vB3nC2mP5kL8rJ1tY4wV7xZ3qM9P2kL9z';
  const paperPos = PaperExecutionService.getInstance(db).executeBuy(
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
  assert(paperPos.mint === paperMint, 'PAPER position mint matches candidate mint');

  console.log(`\n=== PIPELINE VERIFICATION SUMMARY: ${failures === 0 ? 'ALL TESTS PASSED SUCCESSFULLY' : `${failures} TEST(S) FAILED`} ===`);
  if (failures > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPipelineTests();
