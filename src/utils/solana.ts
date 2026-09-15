import { PublicKey } from '@solana/web3.js';

/**
 * Validates whether a given string is a genuine, valid Solana Mint / Public Key.
 * Strictly rejects synthetic, simulated, or placeholder mints (e.g. mint_*, obs_*, UNKNOWN).
 */
export function isValidSolanaMint(mint: string | null | undefined): boolean {
  if (!mint || typeof mint !== 'string') {
    return false;
  }

  const trimmed = mint.trim();

  // Basic length check for Solana base58 PublicKeys (typically 32 to 44 characters)
  if (trimmed.length < 32 || trimmed.length > 44) {
    return false;
  }

  // Reject known synthetic / placeholder prefix patterns
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('mint_') ||
    lower.startsWith('obs_') ||
    lower.startsWith('sim_') ||
    lower.startsWith('pos_') ||
    lower.startsWith('trade_') ||
    lower.startsWith('tx_') ||
    lower === 'unknown' ||
    lower === 'unkwn' ||
    lower.includes('undefined') ||
    lower.includes('null') ||
    trimmed.includes(' ')
  ) {
    return false;
  }

  try {
    const pk = new PublicKey(trimmed);
    // Ensure the public key is not default zero address
    if (pk.equals(PublicKey.default)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates whether a string is a genuine Solana transaction signature.
 */
export function isValidSolanaSignature(signature: string | null | undefined): boolean {
  if (!signature || typeof signature !== 'string') {
    return false;
  }

  const trimmed = signature.trim();
  const lower = trimmed.toLowerCase();

  if (
    lower.startsWith('sim_') ||
    lower.startsWith('sell_sig_') ||
    lower.startsWith('buy_sig_') ||
    lower.includes('undefined') ||
    lower.includes('null')
  ) {
    return false;
  }

  // Real Solana transaction signatures are base58 strings of length 86-90 (usually 88)
  return trimmed.length >= 64 && trimmed.length <= 90;
}

/**
 * Formats a token quantity cleanly with thousand-separators (commas)
 * and appropriate decimal precision without floating point anomalies or scientific notation.
 */
export function formatTokenQuantity(amount: number | string | bigint | null | undefined, maxDecimals: number = 6): string {
  if (amount === null || amount === undefined) {
    return '0';
  }

  // If already formatted with commas
  if (typeof amount === 'string' && amount.includes(',')) {
    const cleaned = amount.replace(/,/g, '').trim();
    if (!isNaN(Number(cleaned))) {
      return formatTokenQuantity(Number(cleaned), maxDecimals);
    }
  }

  const num = typeof amount === 'bigint' 
    ? Number(amount) 
    : typeof amount === 'string' 
      ? parseFloat(amount) 
      : amount;

  if (isNaN(num) || !isFinite(num)) {
    return '0';
  }

  // For zero or very small
  if (num === 0) return '0';

  // Determine decimal places needed
  let decimals = 2;
  if (num < 0.000001) {
    decimals = 8;
  } else if (num < 0.01) {
    decimals = 6;
  } else if (num < 1) {
    decimals = 4;
  } else if (num >= 1000 && Number.isInteger(num)) {
    decimals = 0;
  } else if (num >= 1000) {
    // If fractional part is 0, show 0 decimals
    decimals = (num % 1 === 0) ? 0 : Math.min(2, maxDecimals);
  }

  const parts = num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.min(decimals, maxDecimals)
  });

  return parts;
}

/**
 * Calculates exact token quantity from Investment Amount (SOL/USD) and Execution Price.
 * Token Quantity = Investment Amount ÷ Actual Market Execution Price
 * Respects real token decimals.
 */
export function calculateTokenQuantityFromFill(params: {
  investedAmount: number;
  executionPrice: number;
  tokenDecimals: number;
}): {
  tokenQuantity: string;
  numericAmount: number;
  rawUnits: string;
} {
  const { investedAmount, executionPrice, tokenDecimals } = params;

  if (executionPrice <= 0 || investedAmount <= 0) {
    return {
      tokenQuantity: '0',
      numericAmount: 0,
      rawUnits: '0'
    };
  }

  // Compute exact raw token fill
  const rawCalculated = investedAmount / executionPrice;
  const decimals = typeof tokenDecimals === 'number' && tokenDecimals >= 0 && tokenDecimals <= 18 ? tokenDecimals : 6;
  
  // Scale according to actual decimals
  const scale = Math.pow(10, decimals);
  const rawBigInt = BigInt(Math.floor(rawCalculated * scale));
  const numericAmount = Number(rawBigInt) / scale;
  const tokenQuantity = formatTokenQuantity(numericAmount, decimals);

  return {
    tokenQuantity,
    numericAmount,
    rawUnits: rawBigInt.toString()
  };
}

/**
 * Parses a formatted or raw token quantity string into a clean numeric float
 */
export function parseTokenQuantity(qtyStr: string | number): number {
  if (typeof qtyStr === 'number') return isNaN(qtyStr) ? 0 : qtyStr;
  if (!qtyStr || typeof qtyStr !== 'string') return 0;
  const cleaned = qtyStr.replace(/,/g, '').trim();
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

