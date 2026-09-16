import { 
  BuyDecision, 
  TradeCandidate, 
  CriteriaResult, 
  SafetyResult, 
  MomentumResult, 
  ExecutionResult, 
  BuyAuthorizationAudit,
  Settings
} from '../types';
import { getRugCheckReport } from './rugcheck';
import { Database } from '../db';
import { MomentumService } from './momentumService';

export class BuyAuthorizationService {
  private static instance: BuyAuthorizationService;
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  public static getInstance(db: Database): BuyAuthorizationService {
    if (!BuyAuthorizationService.instance) {
      BuyAuthorizationService.instance = new BuyAuthorizationService(db);
    }
    return BuyAuthorizationService.instance;
  }

  /**
   * Evaluates a trade candidate against the strict deterministic rules.
   * Only returns 'AUTHORIZED' if all 5 hard filters and security gates are cleared.
   */
  public async evaluate(candidate: Omit<TradeCandidate, 'id' | 'momentum'>): Promise<BuyDecision> {
    const settings = this.db.getSettings();
    const candidateId = 'candidate_' + Math.random().toString(36).substring(2, 11);
    const auditId = 'audit_' + Math.random().toString(36).substring(2, 11);
    const strategyVersion = 'v1.0.0-deterministic';
    
    const mint = candidate.tokenMint.trim();
    const traderWallet = candidate.traderWallet.trim();

    // 1. Fetch Momentum Metrics
    const momentumService = MomentumService.getInstance();
    const momentumMetrics = momentumService.getMomentum(mint);

    const momentum: MomentumResult = {
      buyTxCount5s: momentumMetrics.buyTxCount5s,
      buyTxCount10s: momentumMetrics.buyTxCount10s,
      buyTxCount30s: momentumMetrics.buyTxCount30s,
      buyTxCount60s: momentumMetrics.buyTxCount60s,
      sellTxCount10s: momentumMetrics.sellTxCount10s,
      sellTxCount30s: momentumMetrics.sellTxCount30s,
      buyVolume10s: momentumMetrics.buyVolume10s,
      sellVolume10s: momentumMetrics.sellVolume10s,
      priceChange10s: momentumMetrics.priceChange10s,
      priceChange30s: momentumMetrics.priceChange30s,
      priceChange5m: momentumMetrics.priceChange5m,
      buyAcceleration: momentumMetrics.buyAcceleration,
      buyTxIncreasing: momentumMetrics.buyTxIncreasing,
      buyVelocityIncreasing: momentumMetrics.buyVelocityIncreasing,
      volumeIncreasing: momentumMetrics.volumeIncreasing,
      priceMovingPositively: momentumMetrics.priceMovingPositively,
      earlyMomentumDetected: momentumMetrics.earlyMomentumDetected
    };

    // 2. Fetch Security Details via RugCheck
    const rugcheckReport = await getRugCheckReport(mint);
    
    // Evaluate Security Gate
    const mintAuthRemoved = rugcheckReport.mintAuthority === null || rugcheckReport.mintAuthority === '';
    const freezeAuthRemoved = rugcheckReport.freezeAuthority === null || rugcheckReport.freezeAuthority === '';
    const lpLocked = rugcheckReport.lpLocked;
    const rugcheckScore = rugcheckReport.score;
    
    const settingsRugStatusAllowed = settings.requiredRugStatus || ['Good', 'Warn'];
    const securityRejectReasons: string[] = [];
    if (settings.enableRugCheck) {
      if (!settingsRugStatusAllowed.includes(rugcheckReport.riskLevel)) {
        securityRejectReasons.push(`RISK_LEVEL_${rugcheckReport.riskLevel.toUpperCase()}`);
      }
      if (rugcheckReport.score > (settings.maxRiskScore || 300)) {
        securityRejectReasons.push(`HIGH_RISK_SCORE_${rugcheckReport.score}`);
      }
      if (settings.requireMintAuthorityRemoved && !mintAuthRemoved) {
        securityRejectReasons.push('MINT_AUTH_NOT_REMOVED');
      }
      if (settings.requireFreezeAuthorityRemoved && !freezeAuthRemoved) {
        securityRejectReasons.push('FREEZE_AUTH_NOT_REMOVED');
      }
      if (settings.requireLpLocked && !lpLocked) {
        securityRejectReasons.push('LP_NOT_LOCKED');
      }
      if (rugcheckReport.topHoldersPct > (settings.maxHolderConcentration || 25)) {
        securityRejectReasons.push('HIGH_HOLDER_CONCENTRATION');
      }
    }

    const rugcheckPassed = settings.enableRugCheck ? securityRejectReasons.length === 0 : true;

    const safety: SafetyResult = {
      rugcheckScore,
      rugcheckPassed,
      mintAuthorityRemoved: mintAuthRemoved,
      freezeAuthorityRemoved: freezeAuthRemoved,
      lpLocked,
      passed: rugcheckPassed,
      rejectionReason: rugcheckPassed ? undefined : (securityRejectReasons.join(', ') || 'SECURITY_GATE_FAILED')
    };

    // 3. Evaluate Hard Criteria Metrics
    const mc = candidate.market.marketCapUSD || 0;
    const liq = candidate.market.liquidityUSD || 0;
    const vol = candidate.market.volumeUSD24h || 0;
    const devHolding = candidate.security.developerHoldingPct || 0;
    const velocity10s = momentum.buyTxCount10s;
    const velocity30s = momentum.buyTxCount30s;

    // Hard Rules
    const marketCapPassed = mc > 4000;
    const liquidityPassed = liq > 4000;
    const volumePassed = vol > 5000;
    const developerPassed = devHolding < 5;

    // Beginning-Momentum Authorization Rule:
    // Requires at least 1 recorded BUY in the monitoring window AND positive/increasing momentum signals.
    const minBuyActivityPassed = velocity30s >= 1 || velocity10s >= 1;
    const momentumIncreasingPassed =
      momentum.earlyMomentumDetected ||
      momentum.buyTxIncreasing ||
      momentum.buyVelocityIncreasing ||
      momentum.volumeIncreasing ||
      momentum.priceMovingPositively;

    const buyVelocityPassed = minBuyActivityPassed && momentumIncreasingPassed;

    const criteriaPassed = marketCapPassed && liquidityPassed && volumePassed && developerPassed && buyVelocityPassed;

    const criteria: CriteriaResult = {
      marketCapUSD: mc,
      liquidityUSD: liq,
      volumeUSD: vol,
      developerHoldingPct: devHolding,
      buyTxCount10s: velocity10s,
      marketCapPassed,
      liquidityPassed,
      volumePassed,
      developerPassed,
      buyVelocityPassed,
      passed: criteriaPassed
    };

    // 4. Duplicate checks
    // Unique check against active positions
    const activePositions = this.db.getPositions();
    const isAlreadyHeld = activePositions.some(
      p => p.token_mint.trim().toLowerCase() === mint.toLowerCase() && p.status === 'ACTIVE'
    );

    // Reject reasons collection
    const rejectReasons: string[] = [];
    if (!marketCapPassed) rejectReasons.push('MARKET_CAP_TOO_LOW');
    if (!liquidityPassed) rejectReasons.push('LIQUIDITY_TOO_LOW');
    if (!volumePassed) rejectReasons.push('VOLUME_TOO_LOW');
    if (!developerPassed) rejectReasons.push('DEVELOPER_HOLDING_TOO_HIGH');
    if (!buyVelocityPassed) rejectReasons.push('BEGINNING_MOMENTUM_NOT_MET');
    if (!rugcheckPassed) {
      const details = securityRejectReasons.length > 0 ? `: ${securityRejectReasons.join(', ')}` : '';
      rejectReasons.push(`SECURITY_GATE_FAILED${details}`);
    }
    if (isAlreadyHeld) rejectReasons.push('TOKEN_ALREADY_HELD');

    const execution: ExecutionResult = {
      quoteTimestamp: Date.now(),
      inputAmount: settings.trading_amount_sol,
      expectedOutput: 0, 
      route: 'Direct',
      priceImpact: 0,
      slippage: 1,
      passed: true
    };

    const decisionStatus = rejectReasons.length === 0 ? 'AUTHORIZED' : 'REJECTED';

    const decision: BuyDecision = {
      decision: decisionStatus,
      candidateId,
      tokenMint: mint,
      traderWallet,
      authorizedAt: new Date().toISOString(),
      criteria,
      safety,
      momentum,
      execution,
      rejectReasons,
      auditId,
      strategyVersion
    };

    // Save Buy Authorization Audit
    const auditRecord: Omit<BuyAuthorizationAudit, 'id' | 'createdAt'> = {
      candidateId,
      tokenMint: mint,
      tokenName: candidate.tokenName,
      tokenSymbol: candidate.tokenSymbol,
      traderWallet,
      sourceSignature: candidate.sourceSignature,
      marketSnapshotJSON: JSON.stringify(candidate.market),
      securitySnapshotJSON: JSON.stringify({ ...candidate.security, rugcheckReport }),
      momentumSnapshotJSON: JSON.stringify(momentum),
      traderSnapshotJSON: JSON.stringify(candidate.trader),
      executionSnapshotJSON: JSON.stringify(execution),
      decision: decisionStatus,
      rejectReasons,
      strategyVersion
    };

    this.db.addBuyAuthorizationAudit(auditRecord);

    return decision;
  }
}
