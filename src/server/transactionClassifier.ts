import { ParsedTransactionWithMeta } from '@solana/web3.js';
import { isValidSolanaMint, isBaseAsset } from '../utils/solana.js';

export type TransactionClassificationType =
  | 'FAILED'
  | 'BUY'
  | 'SELL'
  | 'TRANSFER'
  | 'SWAP_OTHER'
  | 'BASE_COIN_ONLY'
  | 'UNKNOWN';

export interface TokenDelta {
  mint: string;
  accountIndex: number;
  preAmount: number;
  postAmount: number;
  deltaRaw: number;
  decimals: number;
  deltaUi: number;
}

export interface ClassificationResult {
  type: TransactionClassificationType;
  mint?: string;
  decimals?: number;
  tokenAcquiredAmount?: number;
  solSpent?: number;
  reason?: string;
  candidateMints?: string[];
}

export class TransactionClassifier {
  public static readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';

  /**
   * Calculates net token balance deltas for a specific wallet owner across all token accounts.
   */
  public static calculateTokenBalanceDeltas(
    preTokenBalances: any[] = [],
    postTokenBalances: any[] = [],
    walletAddress: string,
    accountKeys: string[] = []
  ): Map<string, TokenDelta> {
    const deltas = new Map<string, TokenDelta>();

    const isOwnedByTrader = (entry: any) => {
      if (entry.owner === walletAddress) return true;
      if (!entry.owner && typeof entry.accountIndex === 'number' && accountKeys[entry.accountIndex] === walletAddress) {
        return true;
      }
      return false;
    };

    for (const post of postTokenBalances) {
      if (isOwnedByTrader(post)) {
        const mint = post.mint;
        const decimals = post.uiTokenAmount?.decimals ?? 0;
        const postRaw = Number(post.uiTokenAmount?.amount || 0);

        const pre = preTokenBalances.find(p => p.accountIndex === post.accountIndex);
        const preRaw = pre ? Number(pre.uiTokenAmount?.amount || 0) : 0;

        const deltaRaw = postRaw - preRaw;
        const deltaUi = decimals > 0 ? deltaRaw / Math.pow(10, decimals) : deltaRaw;

        deltas.set(mint, {
          mint,
          accountIndex: post.accountIndex,
          preAmount: preRaw,
          postAmount: postRaw,
          deltaRaw,
          decimals,
          deltaUi
        });
      }
    }

    // Also check for accounts present in preTokenBalances but closed in postTokenBalances (e.g. full burns or transfers)
    for (const pre of preTokenBalances) {
      if (isOwnedByTrader(pre) && !deltas.has(pre.mint)) {
        const mint = pre.mint;
        const decimals = pre.uiTokenAmount?.decimals ?? 0;
        const preRaw = Number(pre.uiTokenAmount?.amount || 0);
        const postRaw = 0;
        const deltaRaw = -preRaw;
        const deltaUi = decimals > 0 ? deltaRaw / Math.pow(10, decimals) : deltaRaw;

        deltas.set(mint, {
          mint,
          accountIndex: pre.accountIndex,
          preAmount: preRaw,
          postAmount: postRaw,
          deltaRaw,
          decimals,
          deltaUi
        });
      }
    }

    return deltas;
  }

  /**
   * Evaluates token balance deltas to extract candidate non-base asset received in a BUY.
   */
  public static extractBuyMintFromDeltas(
    deltas: Map<string, TokenDelta>
  ): { mint?: string; decimals?: number; amount?: number; error?: string; candidates: string[] } {
    const positiveTokens: TokenDelta[] = [];

    for (const delta of deltas.values()) {
      if (delta.deltaRaw > 0) {
        // Exclude base assets (SOL, WSOL, USDC, USDT, etc.)
        if (isValidSolanaMint(delta.mint) && !isBaseAsset(delta.mint)) {
          positiveTokens.push(delta);
        }
      }
    }

    const candidateMints = positiveTokens.map(t => t.mint);

    if (positiveTokens.length === 0) {
      return { candidates: [], error: 'NO_POSITIVE_NON_BASE_TOKEN' };
    }

    if (positiveTokens.length === 1) {
      const winner = positiveTokens[0];
      return {
        mint: winner.mint,
        decimals: winner.decimals,
        amount: winner.deltaUi,
        candidates: candidateMints
      };
    }

    // Multiple positive non-base tokens -> check if one dominates or if ambiguous
    return {
      candidates: candidateMints,
      error: 'BUY_MINT_AMBIGUOUS'
    };
  }

  /**
   * Classifies a Solana transaction into a distinct classification category.
   */
  public static classify(
    tx: ParsedTransactionWithMeta | any,
    traderWalletAddress: string
  ): ClassificationResult {
    if (!tx || !tx.meta) {
      return { type: 'UNKNOWN', reason: 'MISSING_METADATA' };
    }

    // 1. Check for on-chain error
    if (tx.meta.err !== null) {
      return { type: 'FAILED', reason: 'ONCHAIN_TRANSACTION_ERROR' };
    }

    const accountKeys = tx.transaction?.message?.accountKeys?.map((a: any) =>
      typeof a === 'string' ? a : (a?.pubkey ? a.pubkey.toString() : String(a))
    ) || [];

    const traderIndex = accountKeys.indexOf(traderWalletAddress);
    if (traderIndex === -1) {
      return { type: 'UNKNOWN', reason: 'TRADER_NOT_IN_ACCOUNTS' };
    }

    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];

    // 2. Calculate balance deltas for all token accounts belonging to trader
    const deltas = this.calculateTokenBalanceDeltas(preTokenBalances, postTokenBalances, traderWalletAddress, accountKeys);

    // 3. Extract candidate buy mint from deltas
    const extraction = this.extractBuyMintFromDeltas(deltas);

    // 4. Calculate SOL / WSOL balance delta for the trader
    const preSol = tx.meta.preBalances?.[traderIndex] ?? 0;
    const postSol = tx.meta.postBalances?.[traderIndex] ?? 0;
    let solSpentLamports = preSol - postSol;

    const wsolDelta = deltas.get(this.WSOL_MINT);
    if (wsolDelta && wsolDelta.deltaRaw < 0) {
      solSpentLamports += Math.abs(wsolDelta.deltaRaw);
    }

    const solSpent = Math.max(0.0001, solSpentLamports / 1e9);

    // Check if trader acquired a non-base token
    if (extraction.mint && extraction.amount && extraction.amount > 0) {
      // Genuine BUY: Acquired target token and spent native SOL/WSOL
      return {
        type: 'BUY',
        mint: extraction.mint,
        decimals: extraction.decimals,
        tokenAcquiredAmount: extraction.amount,
        solSpent,
        candidateMints: extraction.candidates
      };
    }

    if (extraction.error === 'BUY_MINT_AMBIGUOUS') {
      return {
        type: 'SWAP_OTHER',
        reason: 'BUY_MINT_AMBIGUOUS',
        candidateMints: extraction.candidates
      };
    }

    // Check if trader sold a non-base token (negative delta)
    const negativeTokens = Array.from(deltas.values()).filter(
      d => d.deltaRaw < 0 && isValidSolanaMint(d.mint) && !isBaseAsset(d.mint)
    );
    if (negativeTokens.length > 0) {
      return {
        type: 'SELL',
        reason: 'NEGATIVE_TOKEN_BALANCE_DELTA',
        candidateMints: negativeTokens.map(t => t.mint)
      };
    }

    // Check if only base assets were exchanged (SOL, WSOL, USDC, USDT)
    const baseTokensMoved = Array.from(deltas.values()).filter(
      d => d.deltaRaw !== 0 && isBaseAsset(d.mint)
    );
    if (baseTokensMoved.length > 0) {
      return {
        type: 'BASE_COIN_ONLY',
        reason: 'BASE_ASSETS_ONLY_EXCHANGED',
        candidateMints: baseTokensMoved.map(t => t.mint)
      };
    }

    // Check instructions to see if it's a simple TRANSFER
    const instructions = tx.transaction?.message?.instructions || [];
    const hasTransferInstruction = instructions.some((ix: any) => {
      const parsed = ix.parsed;
      return parsed?.type === 'transfer' || parsed?.type === 'transferChecked';
    });

    if (hasTransferInstruction) {
      return { type: 'TRANSFER', reason: 'TOKEN_OR_SOL_TRANSFER' };
    }

    return { type: 'UNKNOWN', reason: 'NON_BUY_OR_UNCLASSIFIED' };
  }
}
