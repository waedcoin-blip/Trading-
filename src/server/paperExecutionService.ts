import { Database } from '../db';
import { Position } from '../types';

export class PaperExecutionService {
  private static instance: PaperExecutionService;
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  public static getInstance(db: Database): PaperExecutionService {
    if (!PaperExecutionService.instance) {
      PaperExecutionService.instance = new PaperExecutionService(db);
    }
    return PaperExecutionService.instance;
  }

  /**
   * Executes a paper buy order idempotently.
   * Deducts SOL from paper balance, calculates token amount using current price, and adds the position.
   */
  public executeBuy(
    mint: string,
    tokenName: string,
    tokenSymbol: string,
    decimals: number,
    priceSOL: number, // SOL per raw token unit (decimals adjusted)
    sourceTraderId: string,
    sourceTraderName: string,
    buySignature: string
  ): Position | null {
    const settings = this.db.getSettings();
    const activePositions = this.db.getPositions();

    // Idempotency: Prevent duplicate positions for the exact same signature
    if (activePositions.some(p => p.buy_signature === buySignature)) {
      console.log(`[PaperExecution] Idempotency block: signature ${buySignature} already executed.`);
      return null;
    }

    // Idempotency: Prevent duplicate holding of the same token in active positions
    const isAlreadyHeld = activePositions.some(
      p => p.token_mint.trim().toLowerCase() === mint.trim().toLowerCase() && p.status === 'ACTIVE'
    );
    if (isAlreadyHeld) {
      console.log(`[PaperExecution] Idempotency block: token ${mint} is already active in a position.`);
      return null;
    }

    const solAmountToSpend = settings.trading_amount_sol;

    // Check paper balance
    if (settings.paper_balance_sol < solAmountToSpend) {
      console.warn(`[PaperExecution] Insufficient paper balance! Need ${solAmountToSpend} SOL, have ${settings.paper_balance_sol} SOL.`);
      return null;
    }

    // Calculate token output (using integer-safe units for lamports and raw tokens)
    const solLamports = BigInt(Math.floor(solAmountToSpend * 1e9));
    const entryPriceSOL = priceSOL > 0 ? priceSOL : 0.000001; // Fallback to avoid division by zero
    
    // Exact token quantity as a float/decimal adjusted
    const tokenOutput = solAmountToSpend / entryPriceSOL;
    
    // Safe raw token amount with decimals handling
    const rawTokenAmount = BigInt(Math.floor(tokenOutput * Math.pow(10, decimals)));

    // Update settings: deduct SOL from paper balance
    const newBalance = Math.max(0, settings.paper_balance_sol - solAmountToSpend);
    this.db.updateSettings({
      paper_balance_sol: newBalance
    });

    const now = new Date().toISOString();

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
      entry_price: entryPriceSOL,
      entryPrice: `${entryPriceSOL.toFixed(9)} SOL`,
      sol_in: solAmountToSpend,
      raw_sol_in: solLamports.toString(),
      investedAmount: `${solAmountToSpend} SOL`,
      token_amount: tokenOutput,
      raw_token_amount: rawTokenAmount.toString(),
      token_decimals: decimals,
      buy_time: now,
      current_price: entryPriceSOL,
      currentPrice: `${entryPriceSOL.toFixed(9)} SOL`,
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
      peak_price: entryPriceSOL,
      trailing_stop_armed: false
    };

    const newPosition = this.db.addPosition(positionData);
    console.log(`[PaperExecution] BUY executed successfully!\nMint: ${mint}\nSpend: ${solAmountToSpend} SOL\nToken Qty: ${tokenOutput}\nEntry Price: ${entryPriceSOL} SOL`);

    return newPosition;
  }
}
