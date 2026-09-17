import { Database } from '../db';
import { Position, Trade, Settings } from '../types';
import { aiLearningEngine } from './aiLearningEngine';
import { RebuyGuard } from './rebuyGuard';
import { Connection } from '@solana/web3.js';
import { ExecutionGateway } from './executionGateway';

export class UnifiedExitService {
  private static instance: UnifiedExitService;
  private db: Database;
  private connectionSupplier: (() => Connection | null) | null = null;
  private exitingPositions: Set<string> = new Set();

  private constructor(db: Database, connectionSupplier?: () => Connection | null) {
    this.db = db;
    if (connectionSupplier) this.connectionSupplier = connectionSupplier;
  }

  public static getInstance(db: Database, connectionSupplier?: () => Connection | null): UnifiedExitService {
    if (!UnifiedExitService.instance) {
      UnifiedExitService.instance = new UnifiedExitService(db, connectionSupplier);
    } else if (connectionSupplier && !UnifiedExitService.instance.connectionSupplier) {
      UnifiedExitService.instance.connectionSupplier = connectionSupplier;
    }
    return UnifiedExitService.instance;
  }

  public setConnectionSupplier(connectionSupplier: () => Connection | null): void {
    this.connectionSupplier = connectionSupplier;
  }

  /**
   * Helper to parse string token quantities safely
   */
  private parseTokenQuantity(val: any): number {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const cleaned = String(val).replace(/[^0-9.]/g, '');
    return parseFloat(cleaned) || 0;
  }

  /**
   * Helper to format token quantities safely
   */
  private formatTokenQuantity(val: number, decimals: number): string {
    return val.toFixed(decimals);
  }

  /**
   * Evaluates if an active position has breached its TP, SL, Trailing Stop, or Stagnation criteria.
   * If yes, executes a full exit.
   */
  public evaluateExitTriggers(
    pos: Position,
    currentPriceSol: number,
    isStale: boolean,
    onExitExecuted: (pos: Position, trade: Trade, reason: string) => void
  ): void {
    if (pos.status !== 'ACTIVE' || this.exitingPositions.has(pos.id)) return;

    const settings = this.db.getSettings();
    const remainingTokens = this.parseTokenQuantity(pos.remainingTokenQuantity || pos.tokenQuantity || pos.token_amount);
    const currentValueSol = Number((remainingTokens * currentPriceSol).toFixed(4));
    const pnlSol = Number((currentValueSol - pos.sol_in).toFixed(4));
    const pnlPercent = pos.sol_in > 0 ? Number(((pnlSol / pos.sol_in) * 100).toFixed(2)) : 0;

    // Calculate trailing stop parameters
    const currentPeakPnl = Math.max(pos.peak_pnl_percent ?? 0, pnlPercent);
    const currentPeakPrice = Math.max(pos.peak_price ?? pos.entry_price, currentPriceSol);
    const trailingStopActivation = settings.trailing_stop_activation_percent ?? 15;
    const trailingStopDist = settings.trailing_stop_percent ?? 10;
    
    const isTrailingArmed = Boolean(
      pos.trailing_stop_armed ||
      (settings.enable_trailing_stop && currentPeakPnl >= trailingStopActivation)
    );

    // Update the position in the database with the latest prices and peak tracking
    this.db.updatePosition(pos.id, {
      current_price: currentPriceSol,
      current_value_sol: currentValueSol,
      unrealized_pnl_sol: pnlSol,
      unrealized_pnl_percent: pnlPercent,
      peak_pnl_percent: currentPeakPnl,
      peak_price: currentPeakPrice,
      trailing_stop_armed: isTrailingArmed
    });

    // Skip exits if price source is marked as stale
    if (isStale) {
      console.warn(`[Exit Engine] Exit trigger evaluation suppressed for ${pos.token_symbol} (${pos.token_mint}): Price data is marked STALE.`);
      return;
    }

    let triggerReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'STAGNANT' | null = null;

    // 1. Take Profit
    if (pnlPercent >= pos.take_profit_percent) {
      triggerReason = 'TAKE_PROFIT';
    }
    // 2. Stop Loss
    else if (pnlPercent <= -pos.stop_loss_percent) {
      triggerReason = 'STOP_LOSS';
    }
    // 3. Trailing Stop
    else if (
      settings.enable_trailing_stop &&
      isTrailingArmed &&
      (currentPeakPnl - pnlPercent) >= trailingStopDist
    ) {
      triggerReason = 'TRAILING_STOP';
    }
    // 4. Stagnation Exit
    else if (settings.enable_time_exit) {
      const holdDurationMs = Date.now() - new Date(pos.buy_time).getTime();
      const maxHoldMs = (settings.max_hold_minutes ?? 30) * 60 * 1000;
      const stagnantThresh = settings.stagnant_pnl_threshold_percent ?? 5;
      if (holdDurationMs >= maxHoldMs && Math.abs(pnlPercent) < stagnantThresh) {
        triggerReason = 'STAGNANT';
      }
    }

    if (triggerReason) {
      this.exitingPositions.add(pos.id);
      this.executeFullExit(pos, currentPriceSol, currentValueSol, pnlSol, pnlPercent, triggerReason)
        .then(trade => {
          if (trade) {
            onExitExecuted(pos, trade, triggerReason!);
          }
        })
        .catch(err => console.error(`[Exit Engine] Full exit failed for ${pos.token_symbol}:`, err))
        .finally(() => this.exitingPositions.delete(pos.id));
    }
  }

  /**
   * Executes a manual exit on an active position.
   */
  public async executeManualExit(
    pos: Position,
    currentPriceSol: number,
    onExitExecuted: (pos: Position, trade: Trade, reason: string) => void
  ): Promise<Trade | null> {
    if (pos.status !== 'ACTIVE' || this.exitingPositions.has(pos.id)) return null;

    this.exitingPositions.add(pos.id);
    try {
      const remainingTokens = this.parseTokenQuantity(pos.remainingTokenQuantity || pos.tokenQuantity || pos.token_amount);
      const currentValueSol = Number((remainingTokens * currentPriceSol).toFixed(4));
      const pnlSol = Number((currentValueSol - pos.sol_in).toFixed(4));
      const pnlPercent = pos.sol_in > 0 ? Number(((pnlSol / pos.sol_in) * 100).toFixed(2)) : 0;

      const trade = await this.executeFullExit(pos, currentPriceSol, currentValueSol, pnlSol, pnlPercent, 'MANUAL');
      if (trade) {
        onExitExecuted(pos, trade, 'MANUAL');
      }
      return trade;
    } finally {
      this.exitingPositions.delete(pos.id);
    }
  }

  /**
   * Performs the actual state transitions and DB updates for a full 100% position exit.
   */
  private async executeFullExit(
    pos: Position,
    exitPrice: number,
    solOut: number,
    pnlSol: number,
    pnlPercent: number,
    reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'STAGNANT' | 'MANUAL' | 'ERROR_RECOVERY'
  ): Promise<Trade | null> {
    console.log(`[Exit Engine] Executing full exit for ${pos.token_symbol} (${pos.token_mint}). Reason: ${reason}. PnL: ${pnlPercent}%`);

    const gateway = ExecutionGateway.getInstance(this.db);
    const conn = this.connectionSupplier ? this.connectionSupplier() : null;

    const result = await gateway.executeSell({
      position: pos,
      currentPriceSol: exitPrice,
      reason,
      connection: conn
    });

    if (!result.success || !result.trade) {
      console.error(`[Exit Engine] Full exit failed for ${pos.token_symbol}: ${result.errorReason} (${result.details})`);
      return null;
    }

    const completedTrade = result.trade;

    // Feed Completed Trade to AI Learning Engine
    try {
      aiLearningEngine.learnFromCompletedTrade(completedTrade, pos);
    } catch (err) {
      console.error('[Exit Engine] AI learning update failed:', err);
    }

    // Update RebuyGuard state
    try {
      await RebuyGuard.onPositionExited({
        mint: pos.token_mint,
        positionId: pos.id,
        tokenQuantity: pos.tokenQuantity,
        entryPrice: pos.entry_price,
        exitPrice,
        entryCost: pos.sol_in,
        exitProceeds: result.trade.sol_out || solOut,
        fees: 0,
        sellReason: reason
      });
    } catch (err) {
      console.error('[Exit Engine] RebuyGuard exit update failed:', err);
    }

    console.log(`[Exit Engine] SOLD SUCCESS: Sold 100% of ${pos.token_symbol} for ${(result.trade.sol_out || solOut).toFixed(4)} SOL.`);
    return completedTrade;
  }
}
