import { jupiterService } from './jupiterService.js';
import { livePriceService } from './priceService.js';

export interface QuoteResult {
  success: boolean;
  inputMint: string;
  outputMint: string;
  inAmountLamports: string;
  outAmountRaw: string;
  outAmountFormatted: number;
  priceSol: number;
  priceUsd: number;
  priceImpactPct: number;
  slippageBps: number;
  tradingFeeLamports: string;
  source: 'JUPITER_V6' | 'SIMULATED_LIVE';
  error?: string;
}

export class QuoteService {
  private static instance: QuoteService;

  public static getInstance(): QuoteService {
    if (!QuoteService.instance) {
      QuoteService.instance = new QuoteService();
    }
    return QuoteService.instance;
  }

  /**
   * Fetches or simulates a BUY quote for swapping SOL to target Token.
   */
  public async getBuyQuote(
    targetMint: string,
    solAmount: number,
    decimals: number,
    currentPriceSol?: number,
    slippageBps: number = 100
  ): Promise<QuoteResult> {
    const solMint = 'So11111111111111111111111111111111111111112';
    const amountLamports = Math.floor(solAmount * 1e9);

    if (!Number.isFinite(solAmount) || solAmount <= 0) {
      return {
        success: false,
        inputMint: solMint,
        outputMint: targetMint,
        inAmountLamports: '0',
        outAmountRaw: '0',
        outAmountFormatted: 0,
        priceSol: 0,
        priceUsd: 0,
        priceImpactPct: 0,
        slippageBps,
        tradingFeeLamports: '0',
        source: 'SIMULATED_LIVE',
        error: 'INVALID_SOL_AMOUNT'
      };
    }

    // 1. Try real Jupiter V6 Quote
    try {
      const jupQuote = await jupiterService.getQuote(solMint, targetMint, amountLamports, slippageBps);
      if (jupQuote && jupQuote.outAmount) {
        const outAmountRaw = BigInt(jupQuote.outAmount);
        const outAmountFormatted = Number(outAmountRaw) / Math.pow(10, decimals);
        const priceSol = outAmountFormatted > 0 ? solAmount / outAmountFormatted : 0;
        const solUsdPrice = livePriceService.getSolUsdPrice();
        const priceUsd = priceSol * solUsdPrice;

        return {
          success: true,
          inputMint: solMint,
          outputMint: targetMint,
          inAmountLamports: amountLamports.toString(),
          outAmountRaw: outAmountRaw.toString(),
          outAmountFormatted,
          priceSol,
          priceUsd,
          priceImpactPct: parseFloat(jupQuote.priceImpactPct || '0') || 0,
          slippageBps,
          tradingFeeLamports: '5000', // ~0.000005 SOL priority fee equivalent
          source: 'JUPITER_V6'
        };
      }
    } catch (err: any) {
      console.warn(`[QuoteService] Jupiter V6 buy quote unavailable for ${targetMint}: ${err?.message}. Falling back to simulated live quote.`);
    }

    // 2. Fallback: Simulated Execution based on Live Price Engine or provided currentPriceSol
    let activePriceSol = currentPriceSol;
    let isStale = false;

    if (!activePriceSol || !Number.isFinite(activePriceSol) || activePriceSol <= 0) {
      const livePrice = livePriceService.getLivePrice(targetMint);
      if (livePrice && Number.isFinite(livePrice.priceSol) && livePrice.priceSol > 0) {
        activePriceSol = livePrice.priceSol;
        isStale = livePrice.isStale;
      }
    }

    if (!activePriceSol || !Number.isFinite(activePriceSol) || activePriceSol <= 0 || isStale) {
      return {
        success: false,
        inputMint: solMint,
        outputMint: targetMint,
        inAmountLamports: amountLamports.toString(),
        outAmountRaw: '0',
        outAmountFormatted: 0,
        priceSol: 0,
        priceUsd: 0,
        priceImpactPct: 0,
        slippageBps,
        tradingFeeLamports: '0',
        source: 'SIMULATED_LIVE',
        error: isStale ? 'STALE_PRICE' : 'NO_VALID_LIVE_PRICE'
      };
    }

    // Apply simulated slippage (e.g. 1% slippage)
    const effectivePriceSol = activePriceSol * (1 + slippageBps / 10000);
    const outAmountFormatted = solAmount / effectivePriceSol;
    const outAmountRaw = BigInt(Math.floor(outAmountFormatted * Math.pow(10, decimals)));

    return {
      success: true,
      inputMint: solMint,
      outputMint: targetMint,
      inAmountLamports: amountLamports.toString(),
      outAmountRaw: outAmountRaw.toString(),
      outAmountFormatted,
      priceSol: effectivePriceSol,
      priceUsd: effectivePriceSol * livePriceService.getSolUsdPrice(),
      priceImpactPct: 0.1,
      slippageBps,
      tradingFeeLamports: '5000',
      source: 'SIMULATED_LIVE'
    };
  }

  /**
   * Fetches or simulates a SELL quote for swapping target Token to SOL.
   */
  public async getSellQuote(
    targetMint: string,
    tokenAmountFormatted: number,
    decimals: number,
    currentPriceSol?: number,
    slippageBps: number = 100
  ): Promise<QuoteResult> {
    const solMint = 'So11111111111111111111111111111111111111112';
    const rawTokenAmount = BigInt(Math.floor(tokenAmountFormatted * Math.pow(10, decimals)));

    if (!Number.isFinite(tokenAmountFormatted) || tokenAmountFormatted <= 0) {
      return {
        success: false,
        inputMint: targetMint,
        outputMint: solMint,
        inAmountLamports: '0',
        outAmountRaw: '0',
        outAmountFormatted: 0,
        priceSol: 0,
        priceUsd: 0,
        priceImpactPct: 0,
        slippageBps,
        tradingFeeLamports: '0',
        source: 'SIMULATED_LIVE',
        error: 'INVALID_TOKEN_AMOUNT'
      };
    }

    // 1. Try real Jupiter V6 Quote
    try {
      const jupQuote = await jupiterService.getQuote(targetMint, solMint, Number(rawTokenAmount), slippageBps);
      if (jupQuote && jupQuote.outAmount) {
        const outLamports = BigInt(jupQuote.outAmount);
        const solOut = Number(outLamports) / 1e9;
        const exitPriceSol = solOut / tokenAmountFormatted;
        const solUsdPrice = livePriceService.getSolUsdPrice();

        return {
          success: true,
          inputMint: targetMint,
          outputMint: solMint,
          inAmountLamports: rawTokenAmount.toString(),
          outAmountRaw: outLamports.toString(),
          outAmountFormatted: solOut,
          priceSol: exitPriceSol,
          priceUsd: exitPriceSol * solUsdPrice,
          priceImpactPct: parseFloat(jupQuote.priceImpactPct || '0') || 0,
          slippageBps,
          tradingFeeLamports: '5000',
          source: 'JUPITER_V6'
        };
      }
    } catch (err: any) {
      console.warn(`[QuoteService] Jupiter V6 sell quote unavailable for ${targetMint}: ${err?.message}. Falling back to live price engine.`);
    }

    // 2. Fallback: Live price engine or passed current valid price
    let activePriceSol = currentPriceSol;
    let isStale = false;

    if (!activePriceSol || !Number.isFinite(activePriceSol) || activePriceSol <= 0) {
      const livePrice = livePriceService.getLivePrice(targetMint);
      if (livePrice && Number.isFinite(livePrice.priceSol) && livePrice.priceSol > 0) {
        activePriceSol = livePrice.priceSol;
        isStale = livePrice.isStale;
      }
    }

    if (!activePriceSol || !Number.isFinite(activePriceSol) || activePriceSol <= 0 || isStale) {
      return {
        success: false,
        inputMint: targetMint,
        outputMint: solMint,
        inAmountLamports: rawTokenAmount.toString(),
        outAmountRaw: '0',
        outAmountFormatted: 0,
        priceSol: 0,
        priceUsd: 0,
        priceImpactPct: 0,
        slippageBps,
        tradingFeeLamports: '0',
        source: 'SIMULATED_LIVE',
        error: isStale ? 'STALE_PRICE' : 'NO_VALID_LIVE_PRICE'
      };
    }

    // Apply simulated slippage (e.g. 1% slippage deduction on sell)
    const effectiveExitPriceSol = activePriceSol * (1 - slippageBps / 10000);
    const solOut = tokenAmountFormatted * effectiveExitPriceSol;
    const outLamports = BigInt(Math.floor(solOut * 1e9));

    return {
      success: true,
      inputMint: targetMint,
      outputMint: solMint,
      inAmountLamports: rawTokenAmount.toString(),
      outAmountRaw: outLamports.toString(),
      outAmountFormatted: solOut,
      priceSol: effectiveExitPriceSol,
      priceUsd: effectiveExitPriceSol * livePriceService.getSolUsdPrice(),
      priceImpactPct: 0.1,
      slippageBps,
      tradingFeeLamports: '5000',
      source: 'SIMULATED_LIVE'
    };
  }
}

export const quoteService = QuoteService.getInstance();
