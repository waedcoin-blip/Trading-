import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Database } from '../db';
import { jupiterService } from './jupiterService';
import { isValidSolanaMint, formatTokenQuantity } from '../utils/solana';
import { SolanaRpcQueue } from './rpcQueue';

export interface RealExecutionResult {
  success: boolean;
  signature?: string;
  error?: string;
  details?: string;
}

export class RealExecutionService {
  private static instance: RealExecutionService | null = null;
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public static getInstance(db: Database): RealExecutionService {
    if (!RealExecutionService.instance) {
      RealExecutionService.instance = new RealExecutionService(db);
    }
    return RealExecutionService.instance;
  }

  /**
   * Retrieves the secure wallet Keypair strictly from environment variables.
   * NEVER reads from db.json or frontend settings.
   */
  public getSignerKeypair(): Keypair | null {
    const rawKey = process.env.MAINNET_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
      return null;
    }

    const trimmed = rawKey.trim();
    try {
      // 1. Try parsing JSON array format [12,34,56,...]
      if (trimmed.startsWith('[')) {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr) && arr.length === 64) {
          return Keypair.fromSecretKey(Uint8Array.from(arr));
        }
      }

      // 2. Try parsing Base58 string format
      const decoded = bs58.decode(trimmed);
      if (decoded.length === 64) {
        return Keypair.fromSecretKey(decoded);
      }
    } catch (err) {
      console.error('[RealExecutionService] Error parsing secret key from environment:', err);
    }

    return null;
  }

  public isSignerConfigured(): boolean {
    return this.getSignerKeypair() !== null;
  }

  /**
   * Executes a REAL mainnet trade using Jupiter V6 quote/swap API and server-side signing.
   */
  public async executeBuy(
    mint: string,
    tokenName: string,
    tokenSymbol: string,
    decimals: number,
    priceSol: number,
    traderId: string,
    traderName: string,
    sourceSignature: string,
    connection: Connection | null
  ): Promise<RealExecutionResult> {
    const settings = this.db.getSettings();
    const tradeAmountSol = settings.trading_amount_sol;
    const solLamports = Math.floor(tradeAmountSol * 1e9);

    // 1. Check secure signer keypair
    const keypair = this.getSignerKeypair();
    if (!keypair) {
      console.error('[RealExecution] REAL_EXECUTION_BLOCKED_SIGNER_NOT_CONFIGURED: Secure signer private key is missing.');
      return {
        success: false,
        error: 'REAL_EXECUTION_BLOCKED_SIGNER_NOT_CONFIGURED',
        details: 'MAINNET_PRIVATE_KEY environment variable is not configured on the server.'
      };
    }

    if (!connection) {
      return {
        success: false,
        error: 'JUPITER_SEND_FAILED',
        details: 'No active Solana RPC connection available for mainnet transaction broadcast.'
      };
    }

    const userPubkey = keypair.publicKey.toBase58();
    const solMint = 'So11111111111111111111111111111111111111112';

    // 2. Check wallet balance before execution
    try {
      const rpcQueue = SolanaRpcQueue.getInstance(() => connection);
      const balanceLamports = await rpcQueue.getBalance(keypair.publicKey, 'confirmed', 'HIGH');
      const requiredLamports = solLamports + 10000000; // trade amount + 0.01 SOL buffer for gas and rent
      if (balanceLamports < requiredLamports) {
        console.error(`[RealExecution] Insufficient balance: ${(balanceLamports / 1e9).toFixed(4)} SOL available, requires ${(requiredLamports / 1e9).toFixed(4)} SOL.`);
        return {
          success: false,
          error: 'EXECUTION_INSUFFICIENT_SOL',
          details: `Wallet balance (${(balanceLamports / 1e9).toFixed(4)} SOL) is insufficient for trade of ${tradeAmountSol} SOL plus fees.`
        };
      }
    } catch (balErr: any) {
      console.warn('[RealExecution] Failed to verify wallet balance before trade, proceeding with caution:', balErr?.message);
    }

    console.log(`[RealExecution] Initiating REAL mainnet trade for ${tokenSymbol} (${mint}). Wallet: ${userPubkey}`);

    // 3. Fetch Jupiter Quote
    let quote: any = null;
    try {
      quote = await jupiterService.getQuote(solMint, mint, solLamports, 100);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const isSlippage = errMsg.toLowerCase().includes('slippage') || errMsg.toLowerCase().includes('exceeded');
      return {
        success: false,
        error: isSlippage ? 'JUPITER_SLIPPAGE_EXCEEDED' : 'JUPITER_QUOTE_FAILED',
        details: errMsg || 'Failed to acquire Jupiter swap quote'
      };
    }

    // 4. Build Swap Transaction
    let swapTxBase64 = '';
    try {
      swapTxBase64 = await jupiterService.buildSwapTransaction(quote, userPubkey);
    } catch (err: any) {
      return {
        success: false,
        error: 'JUPITER_SWAP_BUILD_FAILED',
        details: err?.message || 'Failed to construct Jupiter swap transaction'
      };
    }

    // 5. Sign and Broadcast Transaction
    let txSignature = '';
    try {
      const swapTxBuf = Buffer.from(swapTxBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTxBuf);

      // Sign transaction server-side
      transaction.sign([keypair]);

      const rawTx = transaction.serialize();
      const rpcQueue = SolanaRpcQueue.getInstance(() => connection);
      txSignature = await rpcQueue.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 3
      }, 'HIGH');

      console.log(`[RealExecution] Transaction submitted to Solana RPC. Signature: ${txSignature}`);
    } catch (err: any) {
      return {
        success: false,
        error: 'JUPITER_SEND_FAILED',
        details: err?.message || 'Failed to broadcast signed swap transaction to Solana cluster'
      };
    }

    // 6. Confirm Transaction
    try {
      const rpcQueue = SolanaRpcQueue.getInstance(() => connection);
      const confirmation = await rpcQueue.confirmTransaction(txSignature, 'confirmed', 'HIGH');
      if (confirmation.value.err) {
        return {
          success: false,
          signature: txSignature,
          error: 'JUPITER_CONFIRMATION_FAILED',
          details: `Transaction confirmed with on-chain execution error: ${JSON.stringify(confirmation.value.err)}`
        };
      }
    } catch (err: any) {
      return {
        success: false,
        signature: txSignature,
        error: 'JUPITER_CONFIRMATION_FAILED',
        details: err?.message || 'Timed out waiting for transaction confirmation on Solana cluster'
      };
    }

    // 7. Record Position upon successful execution
    const acquiredTokens = quote?.outAmount ? Number(quote.outAmount) / Math.pow(10, decimals) : (solLamports / (priceSol * 1e9));
    const tokenQuantity = formatTokenQuantity(acquiredTokens, decimals);

    const newPosition = this.db.addPosition({
      token_mint: mint,
      token_name: tokenName,
      token_symbol: tokenSymbol,
      source_trader_id: traderId,
      source_trader_name: traderName,
      buy_signature: txSignature,
      sol_in: tradeAmountSol,
      token_amount: acquiredTokens,
      token_decimals: decimals,
      entry_price: priceSol,
      current_price: priceSol,
      current_value_sol: tradeAmountSol,
      unrealized_pnl_sol: 0,
      unrealized_pnl_percent: 0,
      buy_time: new Date().toISOString(),
      status: 'ACTIVE'
    });

    console.log(`[RealExecution] REAL trade confirmed on-chain! Position ID: ${newPosition.id}. Signature: ${txSignature}`);

    return {
      success: true,
      signature: txSignature,
      details: `REAL TRADE CONFIRMED: ${tokenQuantity} ${tokenSymbol} bought for ${tradeAmountSol} SOL`
    };
  }

  /**
   * Executes a REAL on-chain SELL through Jupiter swap back into SOL.
   */
  public async executeSell(
    mint: string,
    tokenAmount: number | string,
    decimals: number,
    connection: Connection | null
  ): Promise<{ success: boolean; signature?: string; solOut?: number; error?: string; details?: string }> {
    const keypair = this.getSignerKeypair();
    if (!keypair) {
      return {
        success: false,
        error: 'REAL_EXECUTION_BLOCKED_SIGNER_NOT_CONFIGURED',
        details: 'MAINNET_PRIVATE_KEY is not configured on the server.'
      };
    }

    if (!connection) {
      return {
        success: false,
        error: 'JUPITER_SEND_FAILED',
        details: 'No active Solana RPC connection available.'
      };
    }

    const userPubkey = keypair.publicKey.toBase58();
    const solMint = 'So11111111111111111111111111111111111111112';

    // Parse token quantity to raw integer units
    const numericAmount = typeof tokenAmount === 'string' ? parseFloat(tokenAmount.replace(/,/g, '')) : tokenAmount;
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return {
        success: false,
        error: 'INVALID_TOKEN_AMOUNT',
        details: 'Token amount to sell must be greater than zero.'
      };
    }

    const rawUnits = Math.floor(numericAmount * Math.pow(10, decimals));

    console.log(`[RealExecution] Initiating REAL on-chain SELL of ${numericAmount} tokens (${mint}) for wallet ${userPubkey}`);

    // 1. Fetch quote for Token -> SOL
    let quote: any = null;
    try {
      quote = await jupiterService.getQuote(mint, solMint, rawUnits, 150);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const isSlippage = errMsg.toLowerCase().includes('slippage') || errMsg.toLowerCase().includes('exceeded');
      return {
        success: false,
        error: isSlippage ? 'JUPITER_SLIPPAGE_EXCEEDED' : 'JUPITER_QUOTE_FAILED',
        details: errMsg
      };
    }

    // 2. Build swap transaction
    let swapTxBase64 = '';
    try {
      swapTxBase64 = await jupiterService.buildSwapTransaction(quote, userPubkey);
    } catch (err: any) {
      return {
        success: false,
        error: 'JUPITER_SWAP_BUILD_FAILED',
        details: err?.message || 'Failed to construct Jupiter sell transaction'
      };
    }

    // 3. Sign and Broadcast Transaction
    let txSignature = '';
    try {
      const swapTxBuf = Buffer.from(swapTxBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTxBuf);

      transaction.sign([keypair]);
      const rawTx = transaction.serialize();

      const rpcQueue = SolanaRpcQueue.getInstance(() => connection);
      txSignature = await rpcQueue.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 3
      }, 'HIGH');

      console.log(`[RealExecution] SELL transaction submitted. Signature: ${txSignature}`);
    } catch (err: any) {
      return {
        success: false,
        error: 'JUPITER_SEND_FAILED',
        details: err?.message || 'Failed to broadcast sell transaction'
      };
    }

    // 4. Confirm Transaction
    try {
      const rpcQueue = SolanaRpcQueue.getInstance(() => connection);
      const confirmation = await rpcQueue.confirmTransaction(txSignature, 'confirmed', 'HIGH');
      if (confirmation.value.err) {
        return {
          success: false,
          signature: txSignature,
          error: 'JUPITER_CONFIRMATION_FAILED',
          details: `Transaction confirmed with on-chain error: ${JSON.stringify(confirmation.value.err)}`
        };
      }
    } catch (err: any) {
      return {
        success: false,
        signature: txSignature,
        error: 'JUPITER_CONFIRMATION_FAILED',
        details: err?.message || 'Confirmation timed out'
      };
    }

    const solOut = quote?.outAmount ? Number(quote.outAmount) / 1e9 : 0;
    console.log(`[RealExecution] REAL SELL confirmed on-chain! Output: ${solOut.toFixed(4)} SOL. Signature: ${txSignature}`);

    return {
      success: true,
      signature: txSignature,
      solOut
    };
  }
}
