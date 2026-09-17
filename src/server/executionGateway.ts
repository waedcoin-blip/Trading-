import { Connection } from '@solana/web3.js';
import { Database } from '../db.js';
import { Settings, Position, Trade, TraderWallet } from '../types.js';
import { PaperExecutionService, PaperExecutionResult } from './paperExecutionService.js';
import { RealExecutionService, RealExecutionResult } from './realExecutionService.js';

export interface UnifiedExecutionResult {
  success: boolean;
  mode: 'PAPER' | 'MAINNET';
  status: 'CONFIRMED' | 'FAILED' | 'REJECTED';
  position?: Position;
  trade?: Trade;
  signature?: string;
  errorReason?: string;
  details?: string;
}

export class ExecutionGateway {
  private static instance: ExecutionGateway | null = null;
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public static getInstance(db: Database): ExecutionGateway {
    if (!ExecutionGateway.instance) {
      ExecutionGateway.instance = new ExecutionGateway(db);
    } else {
      ExecutionGateway.instance.db = db;
    }
    return ExecutionGateway.instance;
  }

  /**
   * Authoritative Centralized Mode Resolver Rule.
   * MAINNET execution requires settings.trading_mode === 'MAINNET'.
   * If settings.trading_mode === 'PAPER', isRealMode is STRICTLY FALSE,
   * even if settings.mainnet_enabled is true.
   */
  public isRealMode(settings?: Settings): boolean {
    const activeSettings = settings || this.db.getSettings();
    if (activeSettings.trading_mode === 'PAPER') {
      return false;
    }
    return activeSettings.trading_mode === 'MAINNET' && activeSettings.mainnet_enabled === true;
  }

  /**
   * Centralized Entry Point for executing BUY orders.
   * Guarantees PAPER mode NEVER invokes real execution.
   */
  public async executeBuy(params: {
    mint: string;
    tokenName: string;
    tokenSymbol: string;
    decimals: number;
    priceSol: number;
    trader: TraderWallet;
    buySignature: string;
    connection?: Connection | null;
    userId?: string;
  }): Promise<UnifiedExecutionResult> {
    const settings = this.db.getSettings();
    const isReal = this.isRealMode(settings);

    // Hard Safety Assertion
    if (settings.trading_mode === 'PAPER') {
      if (isReal) {
        throw new Error('[CRITICAL_SAFETY_VIOLATION] ExecutionGateway invariant breached: isRealMode evaluated to true while trading_mode is PAPER.');
      }
      console.log(`[ExecutionGateway] Routing BUY for ${params.tokenSymbol} (${params.mint}) to PAPER execution engine.`);
      
      const paperService = PaperExecutionService.getInstance(this.db, params.userId || 'default-user');
      const paperResult: PaperExecutionResult = await paperService.executeBuyAtomically({
        mint: params.mint,
        tokenName: params.tokenName,
        tokenSymbol: params.tokenSymbol,
        decimals: params.decimals,
        priceSOL: params.priceSol,
        sourceTraderId: params.trader.id,
        sourceTraderName: params.trader.name,
        buySignature: params.buySignature
      });

      return {
        success: paperResult.success,
        mode: 'PAPER',
        status: paperResult.status,
        position: paperResult.position,
        errorReason: paperResult.errorReason,
        details: paperResult.details
      };
    }

    // MAINNET MODE
    console.log(`[ExecutionGateway] Routing BUY for ${params.tokenSymbol} (${params.mint}) to REAL MAINNET execution engine.`);
    const realService = RealExecutionService.getInstance(this.db);
    const realResult: RealExecutionResult = await realService.executeBuy(
      params.mint,
      params.tokenName,
      params.tokenSymbol,
      params.decimals,
      params.priceSol,
      params.trader.id,
      params.trader.name,
      params.buySignature,
      params.connection || null
    );

    return {
      success: realResult.success,
      mode: 'MAINNET',
      status: realResult.success ? 'CONFIRMED' : 'FAILED',
      signature: realResult.signature,
      errorReason: realResult.error,
      details: realResult.details
    };
  }

  /**
   * Centralized Entry Point for executing SELL orders (Full Exit Only).
   * Guarantees PAPER mode NEVER invokes real execution.
   */
  public async executeSell(params: {
    position: Position;
    currentPriceSol?: number;
    reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'STAGNANT' | 'MANUAL' | 'ERROR_RECOVERY';
    connection?: Connection | null;
    userId?: string;
  }): Promise<UnifiedExecutionResult> {
    const settings = this.db.getSettings();
    const isReal = this.isRealMode(settings);

    // Hard Safety Assertion
    if (settings.trading_mode === 'PAPER') {
      if (isReal) {
        throw new Error('[CRITICAL_SAFETY_VIOLATION] ExecutionGateway invariant breached: isRealMode evaluated to true while trading_mode is PAPER.');
      }
      console.log(`[ExecutionGateway] Routing SELL for ${params.position.token_symbol} (${params.position.token_mint}) to PAPER execution engine.`);

      const paperService = PaperExecutionService.getInstance(this.db, params.userId || 'default-user');
      const paperResult: PaperExecutionResult = await paperService.executeSellAtomically({
        position: params.position,
        currentPriceSol: params.currentPriceSol,
        reason: params.reason
      });

      return {
        success: paperResult.success,
        mode: 'PAPER',
        status: paperResult.status,
        trade: paperResult.trade,
        errorReason: paperResult.errorReason,
        details: paperResult.details
      };
    }

    // MAINNET MODE
    console.log(`[ExecutionGateway] Routing SELL for ${params.position.token_symbol} (${params.position.token_mint}) to REAL MAINNET execution engine.`);
    const remainingNum = parseFloat(String(params.position.remainingTokenQuantity || params.position.tokenQuantity)) || 0;
    const decimals = params.position.tokenDecimals || params.position.token_decimals || 6;

    const realService = RealExecutionService.getInstance(this.db);
    const realResult: RealExecutionResult = await realService.executeSell(
      params.position.token_mint,
      remainingNum,
      decimals,
      params.connection || null
    );

    if (!realResult.success) {
      return {
        success: false,
        mode: 'MAINNET',
        status: 'FAILED',
        errorReason: realResult.error,
        details: realResult.details
      };
    }

    // In Real mode, update position and record trade
    const solOut = realResult.solOut || (params.currentPriceSol ? remainingNum * params.currentPriceSol : 0);
    const pnlSol = Number((solOut - params.position.sol_in).toFixed(4));
    const pnlPercent = params.position.sol_in > 0 ? Number(((pnlSol / params.position.sol_in) * 100).toFixed(2)) : 0;
    const now = new Date().toISOString();
    const sellSignature = realResult.signature || params.position.buy_signature + '_real_exit_' + Date.now();

    this.db.updatePosition(params.position.id, {
      status: 'SOLD',
      remainingTokenQuantity: '0',
      remainingQuantity: '0'
    });
    this.db.deletePosition(params.position.id);

    const completedTrade: Trade = this.db.addTrade({
      position_id: params.position.id,
      token_mint: params.position.token_mint,
      token_name: params.position.token_name,
      token_symbol: params.position.token_symbol,
      source_trader_id: params.position.source_trader_id,
      source_trader_name: params.position.source_trader_name,
      buy_signature: params.position.buy_signature,
      sell_signature: sellSignature,
      sol_in: params.position.sol_in,
      token_amount_bought: parseFloat(String(params.position.tokenQuantity)),
      tokenQuantityBought: String(params.position.tokenQuantity),
      token_amount_sold: remainingNum,
      tokenQuantitySold: String(remainingNum),
      remainingQuantity: '0',
      sol_out: solOut,
      entry_price: params.position.entry_price,
      exit_price: params.currentPriceSol || params.position.entry_price,
      buy_time: params.position.buy_time,
      sell_time: now,
      pnl_sol: pnlSol,
      pnl_percent: pnlPercent,
      sell_reason: params.reason,
      mode: 'MAINNET'
    });

    return {
      success: true,
      mode: 'MAINNET',
      status: 'CONFIRMED',
      trade: completedTrade,
      signature: sellSignature
    };
  }
}
