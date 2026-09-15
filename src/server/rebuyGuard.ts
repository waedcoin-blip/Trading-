import { db } from '../db.js';
import { isValidSolanaMint, formatTokenQuantity, parseTokenQuantity } from '../utils/solana.js';
import { RebuyState, RebuyDecision, TradeAuditRecord } from '../types.js';

/**
 * RebuyGuard - Centralized, Atomic, Persistent Trading Guard
 * 
 * Enforces the primary rule:
 * - Max number of rebuys = 1
 * - Rebuy is allowed ONLY when the previous completed trade for that exact mint was profitable (realizedPnl > 0)
 * - Any loss (realizedPnl <= 0) or break-even PERMANENTLY blocks future automated buys for that mint
 * - After a rebuy completes (2nd trade exit), NO 3rd buy is EVER allowed (profit or loss)
 * - Atomic per-mint locking protects against concurrent buy signals and race conditions
 * - Persistent server-side state survives restarts, browser refreshes, reconnects
 */
export class RebuyGuard {
  // In-memory per-mint async mutex to prevent concurrent race conditions
  private static mintLocks: Map<string, Promise<void>> = new Map();

  /**
   * Acquires a serialized execution lock for the given mint
   */
  private static async withLock<T>(mint: string, fn: () => Promise<T> | T): Promise<T> {
    while (this.mintLocks.has(mint)) {
      try {
        await this.mintLocks.get(mint);
      } catch {
        // Continue if previous lock errored
      }
    }

    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    this.mintLocks.set(mint, lockPromise);

    try {
      return await fn();
    } finally {
      this.mintLocks.delete(mint);
      resolveLock();
    }
  }

  /**
   * Centralized evaluation check: Is this token allowed to be bought?
   * Every automated buy path MUST call this check.
   */
  public static async canBuy(mint: string): Promise<RebuyDecision> {
    return this.withLock(mint, async () => {
      if (!isValidSolanaMint(mint)) {
        return {
          allowed: false,
          reason: 'INVALID_SOLANA_MINT'
        };
      }

      // Check if there is already an active position for this mint
      const activePositions = db.getPositions().filter(p => p.status === 'ACTIVE' && p.token_mint === mint);
      if (activePositions.length > 0) {
        return {
          allowed: false,
          reason: 'POSITION_ALREADY_ACTIVE'
        };
      }

      const state = db.getRebuyState(mint);

      // Case 1: Token has never been traded before -> Initial Buy is allowed
      if (!state || state.initialBuyCount === 0) {
        return {
          allowed: true,
          type: 'INITIAL_BUY'
        };
      }

      // Case 2: Token is permanently blocked due to a previous loss or max rebuys reached
      if (state.rebuyBlocked) {
        const reason = state.rebuyCount >= 1 ? 'MAX_REBUY_REACHED' : 'PREVIOUS_TRADE_LOSS';
        console.log(`[REBUY-GUARD] BLOCKED\nMint: ${mint}\nPrevious Realized P&L: ${state.lastRealizedPnl.toFixed(4)} SOL (${state.lastRealizedPnlPercent.toFixed(2)}%)\nReason: ${reason}\nToken permanently blocked from automated rebuy`);
        return {
          allowed: false,
          reason,
          state
        };
      }

      // Case 3: Token already completed its 1 allowed rebuy
      if (state.rebuyCount >= 1) {
        console.log(`[REBUY-GUARD] BLOCKED\nMint: ${mint}\nRebuy Count: ${state.rebuyCount}/1\nReason: MAX_REBUY_REACHED`);
        return {
          allowed: false,
          reason: 'MAX_REBUY_REACHED',
          state
        };
      }

      // Case 4: Previous trade was NOT profitable (<= 0)
      if (state.lastRealizedPnl <= 0) {
        // Enforce safety update
        state.rebuyBlocked = true;
        db.setRebuyState(mint, state);

        console.log(`[REBUY-GUARD] BLOCKED\nMint: ${mint}\nPrevious Realized P&L: ${state.lastRealizedPnl.toFixed(4)} SOL (${state.lastRealizedPnlPercent.toFixed(2)}%)\nReason: PREVIOUS_TRADE_LOSS\nToken permanently blocked from automated rebuy`);
        return {
          allowed: false,
          reason: 'PREVIOUS_TRADE_NOT_PROFITABLE',
          state
        };
      }

      // Case 5: Previous trade was profitable and 0 rebuys used -> 1 Rebuy Allowed
      if (state.profitableExits >= 1 && state.rebuyCount === 0) {
        console.log(`[REBUY-GUARD] ALLOWED\nMint: ${mint}\nPrevious Realized P&L: +${state.lastRealizedPnl.toFixed(4)} SOL (+${state.lastRealizedPnlPercent.toFixed(2)}%)\nRebuy Count: 0/1\nReason: Previous trade profitable`);
        return {
          allowed: true,
          type: 'ONE_PROFITABLE_REBUY',
          state
        };
      }

      return {
        allowed: false,
        reason: 'NOT_ELIGIBLE_FOR_REBUY',
        state
      };
    });
  }

  /**
   * Alias method for canBuy as specified in the interface requirements
   */
  public static async canRebuy(mint: string): Promise<RebuyDecision> {
    return this.canBuy(mint);
  }

  /**
   * Records that an authorized BUY has been filled and created a position
   */
  public static async onBuyExecuted(params: {
    mint: string;
    positionId: string;
    tokenQuantity: string;
    entryPrice: number;
    entryCost: number;
    isRebuy?: boolean;
  }): Promise<RebuyState> {
    return this.withLock(params.mint, async () => {
      let state = db.getRebuyState(params.mint);

      if (!state) {
        // First initial buy for this token
        state = {
          mint: params.mint,
          initialBuyCount: 1,
          initialBuyQuantity: params.tokenQuantity,
          rebuyCount: 0,
          totalBoughtQuantity: params.tokenQuantity,
          profitableExits: 0,
          losingExits: 0,
          rebuyBlocked: false,
          lastRealizedPnl: 0,
          lastRealizedPnlPercent: 0,
          activePosition: true,
          history: []
        };
      } else {
        // Subsequent buy (Rebuy #1)
        state.rebuyCount = 1;
        state.rebuyQuantity = params.tokenQuantity;
        const initialNum = parseTokenQuantity(state.initialBuyQuantity || '0');
        const rebuyNum = parseTokenQuantity(params.tokenQuantity);
        state.totalBoughtQuantity = formatTokenQuantity(initialNum + rebuyNum);
        state.activePosition = true;
      }

      db.setRebuyState(params.mint, state);
      console.log(`[REBUY-GUARD] RECORDED BUY: Mint: ${params.mint}, Initial: ${state.initialBuyCount} (Qty: ${state.initialBuyQuantity || params.tokenQuantity}), Rebuys: ${state.rebuyCount}/1 (Qty: ${state.rebuyQuantity || 'N/A'})`);
      return state;
    });
  }

  /**
   * Records completed position exit with final realized P&L and updates rebuy eligibility
   */
  public static async onPositionExited(params: {
    mint: string;
    positionId: string;
    tokenQuantity?: string;
    entryPrice: number;
    exitPrice: number;
    entryCost: number;
    exitProceeds: number;
    fees?: number;
    sellReason: string;
  }): Promise<RebuyState> {
    return this.withLock(params.mint, async () => {
      const fees = params.fees || 0;
      const realizedPnl = Number((params.exitProceeds - params.entryCost - fees).toFixed(4));
      const realizedPnlPercent = params.entryCost > 0 
        ? Number(((realizedPnl / params.entryCost) * 100).toFixed(2))
        : 0;

      let state = db.getRebuyState(params.mint);
      if (!state) {
        state = {
          mint: params.mint,
          initialBuyCount: 1,
          initialBuyQuantity: params.tokenQuantity,
          rebuyCount: 0,
          totalBoughtQuantity: params.tokenQuantity,
          profitableExits: 0,
          losingExits: 0,
          rebuyBlocked: false,
          lastRealizedPnl: 0,
          lastRealizedPnlPercent: 0,
          activePosition: false,
          history: []
        };
      }

      state.activePosition = false;
      state.lastRealizedPnl = realizedPnl;
      state.lastRealizedPnlPercent = realizedPnlPercent;
      state.lastExitTimestamp = new Date().toISOString();

      const isRebuyTrade = state.rebuyCount > 0;
      const tradeNumber = isRebuyTrade ? 2 : 1;

      // Add audit history record
      const auditRecord: TradeAuditRecord = {
        mint: params.mint,
        positionId: params.positionId,
        tokenQuantity: params.tokenQuantity || (isRebuyTrade ? state.rebuyQuantity : state.initialBuyQuantity),
        remainingQuantity: '0',
        entryPrice: params.entryPrice,
        exitPrice: params.exitPrice,
        entryCost: params.entryCost,
        exitProceeds: params.exitProceeds,
        fees,
        realizedPnl,
        realizedPnlPercent,
        tradeNumber,
        isRebuy: isRebuyTrade,
        timestamp: new Date().toISOString(),
        reason: params.sellReason
      };
      state.history.push(auditRecord);

      // Decision tree for rebuy authorization
      if (realizedPnl <= 0) {
        // Loss or break-even trade -> PERMANENTLY BLOCK
        state.losingExits = (state.losingExits || 0) + 1;
        state.rebuyBlocked = true;

        console.log(`[REBUY-GUARD] BLOCKED\nMint: ${params.mint}\nPrevious Realized P&L: ${realizedPnl.toFixed(4)} SOL (${realizedPnlPercent.toFixed(2)}%)\nReason: PREVIOUS_TRADE_LOSS\nToken permanently blocked from automated rebuy`);
      } else {
        // Profitable trade (realizedPnl > 0)
        state.profitableExits = (state.profitableExits || 0) + 1;

        if (isRebuyTrade || state.rebuyCount >= 1) {
          // This was the rebuy trade! Even if profitable, MAX REBUY = 1 is reached.
          state.rebuyBlocked = true;
          console.log(`[REBUY-GUARD] BLOCKED\nMint: ${params.mint}\nRebuy Count: 1/1\nReason: MAX_REBUY_REACHED\nToken reached maximum lifetime rebuys (1). Permanently blocked.`);
        } else {
          // This was trade #1 and it was profitable! Exactly ONE rebuy is unlocked.
          state.rebuyBlocked = false;
          state.rebuyCount = 0;
          console.log(`[REBUY-GUARD] ALLOWED\nMint: ${params.mint}\nPrevious Realized P&L: +${realizedPnl.toFixed(4)} SOL (+${realizedPnlPercent.toFixed(2)}%)\nRebuy Count: 0/1\nReason: Previous trade profitable`);
        }
      }

      db.setRebuyState(params.mint, state);
      return state;
    });
  }

  /**
   * Retrieves the current persisted rebuy state for a token mint
   */
  public static async getRebuyState(mint: string): Promise<RebuyState | null> {
    return db.getRebuyState(mint);
  }

  /**
   * Retrieves all persisted rebuy states
   */
  public static async getAllRebuyStates(): Promise<Record<string, RebuyState>> {
    return db.getRebuyStates();
  }

  /**
   * Completely resets the Profitable-Only Rebuy Guard Matrix and Completed Trade History.
   * Clears in-memory mutex locks and purges all persisted rebuy states and completed trade records.
   */
  public static async resetAll(): Promise<{ completedTrades: number; rebuyGuardEntries: number; resetAt: string }> {
    this.mintLocks.clear();
    return db.resetGuardAndHistory();
  }
}
