import { GoogleGenAI, Type } from "@google/genai";
import { Trade, TokenObservation, AISignals } from "../types";

let aiClient: GoogleGenAI | null = null;
let quotaCooldownUntil = 0;

function getAI(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY" && key.trim() !== "") {
      try {
        aiClient = new GoogleGenAI({
          apiKey: key,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            }
          }
        });
      } catch (err) {
        console.error("Failed to initialize Gemini AI client", err);
      }
    }
  }
  return aiClient;
}

/**
 * Heuristics-based fallback scorer when Gemini API key is missing or quota is exhausted
 */
export function calculateHeuristicScore(token: Omit<TokenObservation, 'id' | 'timestamp'>, historicalTrades: Trade[]): { score: number; signals: AISignals } {
  let score = 50; // Starting baseline
  const positive: string[] = [];
  const risks: string[] = [];

  // Analyze market cap
  if (token.market_cap !== 'UNKNOWN') {
    if (token.market_cap > 50000) {
      score += 15;
      positive.push('Strong market cap support (> $50k)');
    } else if (token.market_cap > 15000) {
      score += 5;
      positive.push('Healthy mid-range market cap');
    } else {
      score -= 10;
      risks.push('Low market cap, high volatility risk');
    }
  }

  // Analyze liquidity
  if (token.liquidity !== 'UNKNOWN') {
    if (token.liquidity > 20000) {
      score += 15;
      positive.push('Excellent liquidity pool depth');
    } else if (token.liquidity > 8000) {
      score += 5;
      positive.push('Adequate liquidity support');
    } else {
      score -= 15;
      risks.push('Thin liquidity pool, high slippage risk');
    }
  }

  // Analyze developer holding
  if (token.developer_holding_percent !== 'UNKNOWN') {
    if (token.developer_holding_percent < 1.5) {
      score += 10;
      positive.push('Developer holding is extremely low (< 1.5%)');
    } else if (token.developer_holding_percent < 3) {
      score += 5;
      positive.push('Low developer concentration');
    } else {
      score -= 10;
      risks.push('Dev holding > 3%, potential sell pressure');
    }
  }

  // Analyze 24h volume
  if (token.volume_24h !== 'UNKNOWN') {
    if (token.volume_24h > 100000) {
      score += 10;
      positive.push('High 24h trading volume');
    } else if (token.volume_24h > 20000) {
      score += 5;
    } else {
      score -= 5;
      risks.push('Low 24h activity, watch out for stagnancy');
    }
  }

  // Analyze rolling 10s buyer velocity
  if (token.buyers_10s !== 'UNKNOWN') {
    if (token.buyers_10s > 30) {
      score += 15;
      positive.push('High velocity: Hyperactive short-term momentum');
    } else if (token.buyers_10s > 15) {
      score += 8;
      positive.push('Steady short-term buyer influx');
    } else {
      score -= 5;
      risks.push('Slowing buyer momentum');
    }
  }

  // Incorporate trade history learnings
  if (historicalTrades.length > 0) {
    const paperTrades = historicalTrades.filter(t => t.mode === 'PAPER');
    if (paperTrades.length > 0) {
      const winningTrades = paperTrades.filter(t => t.pnl_sol > 0);
      const winRate = winningTrades.length / paperTrades.length;
      if (winRate > 0.6) {
        score += 5;
        positive.push('Historical copying win rate is strong');
      } else if (winRate < 0.4) {
        score -= 5;
        risks.push('High failure rate in current market regime');
      }
    }
  }

  // Bounds checking
  score = Math.max(10, Math.min(99, score));

  return {
    score,
    signals: {
      positive: positive.slice(0, 4),
      risks: risks.slice(0, 3)
    }
  };
}

/**
 * Calculates a highly accurate AI Score, Positive Signals, and Risks for a token
 */
export async function scoreToken(
  token: Omit<TokenObservation, 'id' | 'timestamp'>,
  historicalTrades: Trade[]
): Promise<{ score: number; signals: AISignals }> {
  // If in quota cooldown period, immediately use heuristic engine without API calls
  if (Date.now() < quotaCooldownUntil) {
    return calculateHeuristicScore(token, historicalTrades);
  }

  const ai = getAI();
  if (!ai) {
    return calculateHeuristicScore(token, historicalTrades);
  }

  const candidateModels = ["gemini-3.8-flash", "gemini-3.1-flash-lite"];

  const simplifiedTrades = historicalTrades.map(t => ({
    pnlPercent: t.pnl_percent,
    reason: t.sell_reason,
    tokenName: t.token_name
  })).slice(-10); // Analyze last 10 completed trades

  const prompt = `
    You are the AI model for the "Ultra Trading Bot" on Solana.
    Evaluate the token opportunity with the following parameters:
    - Token Name: ${token.token_name} (${token.token_symbol})
    - Mint: ${token.token_mint}
    - Market Cap: ${token.market_cap === 'UNKNOWN' ? 'Unknown' : '$' + token.market_cap}
    - Liquidity: ${token.liquidity === 'UNKNOWN' ? 'Unknown' : '$' + token.liquidity}
    - 24h Volume: ${token.volume_24h === 'UNKNOWN' ? 'Unknown' : '$' + token.volume_24h}
    - Dev Holding %: ${token.developer_holding_percent === 'UNKNOWN' ? 'Unknown' : token.developer_holding_percent + '%'}
    - Unique Buyers in Rolling 10s: ${token.buyers_10s === 'UNKNOWN' ? 'Unknown' : token.buyers_10s}
    - Price (SOL): ${token.price === 'UNKNOWN' ? 'Unknown' : token.price}
    
    Recent trades analyzed for learning:
    ${JSON.stringify(simplifiedTrades, null, 2)}

    Analyze these metrics and assign:
    1. A total scoring from 10 to 99 representing the quality of this trade setup.
    2. Up to 4 Positive Signals (highly concise, professional, e.g. "Dev holds only 1.2%").
    3. Up to 3 Key Risks (concise, professional, e.g. "Liquidity is thin relative to volume").

    Ensure the scoring cannot override the fact that the token is eligible under filters (it has passed).
    Return your analysis strictly as JSON matching this schema:
    {
      "score": number, // between 10 and 99
      "positive": string[], // max 4 items
      "risks": string[] // max 3 items
    }
  `;

  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              score: { type: Type.INTEGER, description: "Quality score from 10 to 99" },
              positive: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Concise positive indicators"
              },
              risks: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Concise risk indicators"
              }
            },
            required: ["score", "positive", "risks"]
          }
        }
      });

      const text = response.text?.trim();
      if (text) {
        const parsed = JSON.parse(text);
        return {
          score: Math.max(10, Math.min(99, Number(parsed.score || 50))),
          signals: {
            positive: Array.isArray(parsed.positive) ? parsed.positive.slice(0, 4) : [],
            risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3) : []
          }
        };
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      const isQuotaExceeded = errorMsg.includes('429') || 
                              errorMsg.includes('quota') || 
                              errorMsg.includes('RESOURCE_EXHAUSTED') || 
                              errorMsg.includes('exceeded your current quota');
      
      if (isQuotaExceeded) {
        quotaCooldownUntil = Date.now() + 60000; // 60s cooldown
        console.log('[AI Engine] API quota limit reached. Seamlessly engaging local heuristic scoring engine.');
        break; // Stop iterating on exhausted key
      } else {
        console.log(`[AI Engine] Model ${model} unavailable (${errorMsg.slice(0, 60)}). Falling back...`);
      }
    }
  }

  // Gracefully fallback to high-precision heuristic analysis
  return calculateHeuristicScore(token, historicalTrades);
}
