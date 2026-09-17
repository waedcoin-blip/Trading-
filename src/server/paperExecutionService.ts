import { Database } from '../db.js';
import { Position, Trade } from '../types.js';
import { adminFirestore } from '../lib/firebase-admin.js';
import { quoteService, QuoteResult } from './quoteService.js';
import { livePriceService } from './priceService.js';

export interface PaperExecutionResult {
  success: boolean;
  status: 'CONFIRMED' | 'FAILED';
  position?: Position;
  trade?: Trade;
  quote?: QuoteResult;
  errorReason?: string;
  details?: string;
}

export class PaperExecutionService {
  private static instance: PaperExecutionService | null = null;
  private db: Database;
  private userId: string;
  private executionLocks: Set<string> = new Set();

  constructor(db: Database, userId: string = 'default-user') {
    this.db = db;
    this.userId = userId;
  }

  public static getInstance(db: Database, userId: string = 'default-user'): PaperExecutionService {
    if (!PaperExecutionService.instance) {
      PaperExecutionService.instance = new PaperExecutionService(db, userId);
    } else {
      // Update db reference dynamically if needed
      PaperExecutionService.instance.db = db;
      if (userId && userId !== 'default-user') {
        PaperExecutionService.instance.userId = userId;
      }
    }
    return PaperExecutionService.instance;
  }

  /**
   * Helper to check if Firestore admin connection is available
   */
  private isFirestoreConnected(): boolean {
    return Boolean(adminFirestore);
  }

  /**
   * Atomically executes a paper buy order with quote simulation and Firestore transaction ledger updates.
   */
  public async executeBuyAtomically(params: {
    mint: string;
    tokenName: string;
    tokenSymbol: string;
    decimals: number;
    priceSOL: number;
    sourceTraderId: string;
    sourceTraderName: string;
    buySignature: string;
  }): Promise<PaperExecutionResult> {
    const { mint, tokenName, tokenSymbol, decimals, priceSOL, sourceTraderId, sourceTraderName, buySignature } = params;

    // Hard Assertion: Validate input price strictly
    if (!Number.isFinite(priceSOL) || priceSOL <= 0 || isNaN(priceSOL)) {
      console.error(`[PaperExecution] BUY REJECTED: Invalid priceSOL (${priceSOL}) for ${tokenSymbol} (${mint}).`);
      return {
        success: false,
        status: 'FAILED',
        errorReason: 'INVALID_PRICE',
        details: `Price '${priceSOL}' is not a valid positive number.`
      };
    }

    // Atomic Lock Check
    const lockKey = `BUY_${mint.trim().toLowerCase()}`;
    if (this.executionLocks.has(lockKey)) {
      console.warn(`[PaperExecution] BUY REJECTED: Concurrent execution lock active for mint ${mint}.`);
      return {
        success: false,
        status: 'FAILED',
        errorReason: 'DUPLICATE_CONCURRENT_EXECUTION',
        details: `A buy order for ${mint} is currently in-flight.`
      };
    }

    this.executionLocks.add(lockKey);

    try {
      const settings = this.db.getSettings();
      const activePositions = this.db.getPositions();

      // Check Idempotency: Signature duplicate
      if (activePositions.some(p => p.buy_signature === buySignature)) {
        console.log(`[PaperExecution] Idempotency block: signature ${buySignature} already executed.`);
        return {
          success: false,
          status: 'FAILED',
          errorReason: 'DUPLICATE_SIGNATURE',
          details: `Signature ${buySignature} has already been executed.`
        };
      }

      // Check Idempotency: Already holding position
      const isAlreadyHeld = activePositions.some(
        p => p.token_mint.trim().toLowerCase() === mint.trim().toLowerCase() && p.status === 'ACTIVE'
      );
      if (isAlreadyHeld) {
        console.log(`[PaperExecution] Idempotency block: token ${mint} is already active.`);
        return {
          success: false,
          status: 'FAILED',
          errorReason: 'POSITION_ALREADY_HELD',
          details: `Position for ${mint} is already active.`
        };
      }

      const solAmountToSpend = settings.trading_amount_sol;

      // Check Balance
      if (settings.paper_balance_sol < solAmountToSpend) {
        console.warn(`[PaperExecution] Insufficient balance! Required: ${solAmountToSpend} SOL, Have: ${settings.paper_balance_sol} SOL.`);
        return {
          success: false,
          status: 'FAILED',
          errorReason: 'INSUFFICIENT_BALANCE',
          details: `Required ${solAmountToSpend} SOL, but paper balance is ${settings.paper_balance_sol} SOL.`
        };
      }

      // Fetch simulated/Jupiter Quote
      const quote = await quoteService.getBuyQuote(mint, solAmountToSpend, decimals, priceSOL);
      if (!quote.success || !Number.isFinite(quote.outAmountFormatted) || quote.outAmountFormatted <= 0) {
        console.error(`[PaperExecution] BUY REJECTED: Quote failed for ${mint}. Reason: ${quote.error}`);
        return {
          success: false,
          status: 'FAILED',
          quote,
          errorReason: quote.error || 'QUOTE_SIMULATION_FAILED',
          details: 'Failed to obtain a valid simulated fill quote.'
        };
      }

      const fillPriceSol = quote.priceSol;
      const tokenOutput = quote.outAmountFormatted;
      const rawTokenAmount = BigInt(quote.outAmountRaw);
      const solLamports = BigInt(quote.inAmountLamports);
      const now = new Date().toISOString();

      const newBalance = Math.max(0, settings.paper_balance_sol - solAmountToSpend);

      const positionData: Omit<Position, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
        token_mint: mint,
        mint,
        token_name: tokenName,
        token_symbol: tokenSymbol,
        source_trader_id: sourceTraderId,
        source_trader_name: sourceTraderName,
        buy_signature: buySignature,
        tokenQuantity: tokenOutput.toFixed(decimals),
        remainingTokenQuantity: tokenOutput.toFixed(decimals),
        remainingQuantity: tokenOutput.toFixed(decimals),
        tokenDecimals: decimals,
        entry_price: fillPriceSol,
        entryPrice: `${fillPriceSol.toFixed(9)} SOL`,
        sol_in: solAmountToSpend,
        raw_sol_in: solLamports.toString(),
        investedAmount: `${solAmountToSpend} SOL`,
        token_amount: tokenOutput,
        raw_token_amount: rawTokenAmount.toString(),
        token_decimals: decimals,
        buy_time: now,
        current_price: fillPriceSol,
        currentPrice: `${fillPriceSol.toFixed(9)} SOL`,
        current_value_sol: solAmountToSpend,
        currentValue: `${solAmountToSpend} SOL`,
        unrealized_pnl_sol: 0,
        unrealizedPnl: '0.0000 SOL',
        unrealized_pnl_percent: 0,
        unrealizedPnlPercent: '0.00%',
        network: 'mainnet-beta',
        status: 'ACTIVE',
        take_profit_percent: settings.take_profit_percent,
        stop_loss_percent: settings.stop_loss_percent,
        peak_pnl_percent: 0,
        peak_price: fillPriceSol,
        trailing_stop_armed: false
      };

      // Firestore Atomic Transaction Ledger write if connected
      if (this.isFirestoreConnected()) {
        try {
          const userRef = adminFirestore.collection('users').doc(this.userId);
          const portfolioRef = userRef.collection('paper_portfolios').doc('default');
          const positionRef = userRef.collection('paper_positions').doc();
          const execRecordRef = userRef.collection('paper_execution_records').doc();

          await adminFirestore.runTransaction(async (transaction) => {
            const portfolioDoc = await transaction.get(portfolioRef);
            let currentFirestoreBalance = settings.paper_balance_sol;
            if (portfolioDoc.exists) {
              currentFirestoreBalance = portfolioDoc.data()?.paperBalanceSol ?? settings.paper_balance_sol;
            }

            if (currentFirestoreBalance < solAmountToSpend) {
              throw new Error(`INSUFFICIENT_BALANCE_FIRESTORE: Need ${solAmountToSpend}, have ${currentFirestoreBalance}`);
            }

            const updatedFirestoreBalance = currentFirestoreBalance - solAmountToSpend;

            transaction.set(portfolioRef, {
              id: 'default',
              userId: this.userId,
              paperBalanceSol: updatedFirestoreBalance,
              updatedAt: now
            }, { merge: true });

            transaction.set(positionRef, {
              ...positionData,
              id: positionRef.id,
              userId: this.userId,
              mode: 'PAPER',
              createdAt: now,
              updatedAt: now
            });

            transaction.set(execRecordRef, {
              id: execRecordRef.id,
              userId: this.userId,
              tokenMint: mint,
              action: 'BUY',
              status: 'CONFIRMED',
              amountSol: solAmountToSpend,
              priceSol: fillPriceSol,
              createdAt: now
            });
          });
          console.log(`[PaperExecution] Firestore atomic transaction written for BUY ${tokenSymbol}`);
        } catch (fsErr: any) {
          console.error('[PaperExecution] Firestore transaction error:', fsErr?.message || fsErr);
        }
      }

      // Update in-memory db
      this.db.updateSettings({ paper_balance_sol: newBalance });
      const newPosition = this.db.addPosition(positionData);

      console.log(`[PaperExecution] BUY CONFIRMED!\nMint: ${mint}\nSpend: ${solAmountToSpend} SOL\nToken Qty: ${tokenOutput}\nEntry Price: ${fillPriceSol} SOL`);

      return {
        success: true,
        status: 'CONFIRMED',
        position: newPosition,
        quote
      };
    } finally {
      this.executionLocks.delete(lockKey);
    }
  }

  /**
   * Atomically executes a full paper sell order with fresh quote simulation and Firestore transaction ledger updates.
   */
  public async executeSellAtomically(params: {
    position: Position;
    currentPriceSol?: number;
    reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'STAGNANT' | 'MANUAL' | 'ERROR_RECOVERY';
  }): Promise<PaperExecutionResult> {
    const { position, currentPriceSol, reason } = params;

    if (!position || position.status !== 'ACTIVE') {
      return {
        success: false,
        status: 'FAILED',
        errorReason: 'POSITION_NOT_ACTIVE',
        details: 'Position is not active or does not exist.'
      };
    }

    const lockKey = `SELL_${position.id}`;
    if (this.executionLocks.has(lockKey)) {
      console.warn(`[PaperExecution] SELL REJECTED: Concurrent exit lock active for position ${position.id}.`);
      return {
        success: false,
        status: 'FAILED',
        errorReason: 'DUPLICATE_CONCURRENT_EXECUTION',
        details: `A sell order for position ${position.id} is already in-flight.`
      };
    }

    this.executionLocks.add(lockKey);

    try {
      const decimals = position.tokenDecimals || position.token_decimals || 6;
      const remainingNum = parseFloat(String(position.remainingTokenQuantity || position.tokenQuantity || position.token_amount)) || 0;

      if (remainingNum <= 0) {
        return {
          success: false,
          status: 'FAILED',
          errorReason: 'ZERO_QUANTITY',
          details: 'Remaining token quantity is zero.'
        };
      }

      // Obtain fresh SELL quote
      const quote = await quoteService.getSellQuote(
        position.token_mint,
        remainingNum,
        decimals,
        currentPriceSol
      );

      if (!quote.success || !Number.isFinite(quote.outAmountFormatted) || quote.outAmountFormatted <= 0) {
        console.error(`[PaperExecution] SELL REJECTED: Fresh quote failed for ${position.token_symbol}. Error: ${quote.error}`);
        return {
          success: false,
          status: 'FAILED',
          quote,
          errorReason: quote.error || 'STALE_OR_INVALID_PRICE',
          details: 'Failed to obtain a valid fresh fill quote for sell execution.'
        };
      }

      const exitPriceSol = quote.priceSol;
      const solOut = quote.outAmountFormatted;
      const pnlSol = Number((solOut - position.sol_in).toFixed(4));
      const pnlPercent = position.sol_in > 0 ? Number(((pnlSol / position.sol_in) * 100).toFixed(2)) : 0;
      const now = new Date().toISOString();
      const sellSignature = position.buy_signature + '_exit_' + Date.now();

      const settings = this.db.getSettings();
      const updatedBalance = Number((settings.paper_balance_sol + solOut).toFixed(4));

      // Firestore Atomic Transaction Ledger write if connected
      if (this.isFirestoreConnected()) {
        try {
          const userRef = adminFirestore.collection('users').doc(this.userId);
          const portfolioRef = userRef.collection('paper_portfolios').doc('default');
          const positionRef = userRef.collection('paper_positions').doc(position.id);
          const tradeRef = userRef.collection('paper_trades').doc();
          const execRecordRef = userRef.collection('paper_execution_records').doc();

          await adminFirestore.runTransaction(async (transaction) => {
            const portfolioDoc = await transaction.get(portfolioRef);
            let currentFirestoreBalance = settings.paper_balance_sol;
            if (portfolioDoc.exists) {
              currentFirestoreBalance = portfolioDoc.data()?.paperBalanceSol ?? settings.paper_balance_sol;
            }

            const updatedFirestoreBalance = currentFirestoreBalance + solOut;

            transaction.set(portfolioRef, {
              id: 'default',
              userId: this.userId,
              paperBalanceSol: updatedFirestoreBalance,
              updatedAt: now
            }, { merge: true });

            transaction.set(positionRef, {
              status: 'SOLD',
              remainingTokenQuantity: '0',
              remainingQuantity: '0',
              updatedAt: now
            }, { merge: true });

            transaction.set(tradeRef, {
              id: tradeRef.id,
              userId: this.userId,
              positionId: position.id,
              tokenMint: position.token_mint,
              tokenName: position.token_name,
              tokenSymbol: position.token_symbol,
              buySignature: position.buy_signature,
              sellSignature,
              solIn: position.sol_in,
              solOut,
              tokenAmountBought: parseFloat(String(position.tokenQuantity)),
              tokenAmountSold: remainingNum,
              entryPrice: position.entry_price,
              exitPrice: exitPriceSol,
              pnlSol,
              pnlPercent,
              sellReason: reason,
              buyTime: position.buy_time,
              sellTime: now,
              mode: 'PAPER',
              createdAt: now
            });

            transaction.set(execRecordRef, {
              id: execRecordRef.id,
              userId: this.userId,
              tokenMint: position.token_mint,
              action: 'SELL',
              status: 'CONFIRMED',
              amountSol: solOut,
              priceSol: exitPriceSol,
              createdAt: now
            });
          });
          console.log(`[PaperExecution] Firestore atomic transaction written for SELL ${position.token_symbol}`);
        } catch (fsErr: any) {
          console.error('[PaperExecution] Firestore sell transaction error:', fsErr?.message || fsErr);
        }
      }

      // Update in-memory db
      this.db.updatePosition(position.id, {
        status: 'SOLD',
        remainingTokenQuantity: '0',
        remainingQuantity: '0'
      });
      this.db.deletePosition(position.id);
      this.db.updateSettings({ paper_balance_sol: updatedBalance });

      const completedTrade: Trade = this.db.addTrade({
        position_id: position.id,
        token_mint: position.token_mint,
        token_name: position.token_name,
        token_symbol: position.token_symbol,
        source_trader_id: position.source_trader_id,
        source_trader_name: position.source_trader_name,
        buy_signature: position.buy_signature,
        sell_signature: sellSignature,
        sol_in: position.sol_in,
        token_amount_bought: parseFloat(String(position.tokenQuantity)),
        tokenQuantityBought: String(position.tokenQuantity),
        token_amount_sold: remainingNum,
        tokenQuantitySold: String(remainingNum),
        remainingQuantity: '0',
        sol_out: solOut,
        entry_price: position.entry_price,
        exit_price: exitPriceSol,
        buy_time: position.buy_time,
        sell_time: now,
        pnl_sol: pnlSol,
        pnl_percent: pnlPercent,
        sell_reason: reason,
        mode: 'PAPER'
      });

      console.log(`[PaperExecution] FULL SELL CONFIRMED!\nMint: ${position.token_symbol}\nProceeds: ${solOut} SOL\nPnL: ${pnlPercent}%`);

      return {
        success: true,
        status: 'CONFIRMED',
        trade: completedTrade,
        quote
      };
    } finally {
      this.executionLocks.delete(lockKey);
    }
  }

  /**
   * Compatibility wrapper for existing callers expecting executeBuy signature.
   */
  public async executeBuy(
    mint: string,
    tokenName: string,
    tokenSymbol: string,
    decimals: number,
    priceSOL: number,
    sourceTraderId: string,
    sourceTraderName: string,
    buySignature: string
  ): Promise<Position | null> {
    const result = await this.executeBuyAtomically({
      mint,
      tokenName,
      tokenSymbol,
      decimals,
      priceSOL,
      sourceTraderId,
      sourceTraderName,
      buySignature
    });
    return result.success ? result.position || null : null;
  }
}
