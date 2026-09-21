import { GoogleGenAI, Type } from "@google/genai";
import { Trade, TokenObservation, AISignals } from "../types";
import { aiLearningEngine } from "./aiLearningEngine";

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
 * Calculates a highly accurate Learned AI Score, Positive Signals, and Risks for a token
 */
export async function scoreToken(
  token: Omit<TokenObservation, 'id' | 'timestamp'>,
  historicalTrades: Trade[]
): Promise<{ score: number; signals: AISignals; breakdown?: any; confidence?: number }> {
  let baseResult = { score: 50, signals: { positive: [] as string[], risks: [] as string[] } };

  // If in quota cooldown period, immediately use heuristic engine without API calls
  if (Date.now() < quotaCooldownUntil) {
    baseResult = calculateHeuristicScore(token, historicalTrades);
  } else {
    const ai = getAI();
    if (!ai) {
      baseResult = calculateHeuristicScore(token, historicalTrades);
    } else {
      const candidateModels = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.1-flash-lite"];
      const simplifiedTrades = historicalTrades.map(t => ({
        pnlPercent: t.pnl_percent,
        reason: t.sell_reason,
        tokenName: t.token_name
      })).slice(-10);

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
        2. Up to 4 Positive Signals.
        3. Up to 3 Key Risks.

        Return your analysis strictly as JSON matching this schema:
        {
          "score": number, // between 10 and 99
          "positive": string[],
          "risks": string[]
        }
      `;

      let modelEvaluated = false;
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
                    items: { type: Type.STRING }
                  },
                  risks: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  }
                },
                required: ["score", "positive", "risks"]
              }
            }
          });

          const text = response.text?.trim();
          if (text) {
            const parsed = JSON.parse(text);
            baseResult = {
              score: Math.max(10, Math.min(99, Number(parsed.score || 50))),
              signals: {
                positive: Array.isArray(parsed.positive) ? parsed.positive.slice(0, 4) : [],
                risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3) : []
              }
            };
            modelEvaluated = true;
            break;
          }
        } catch (err: any) {
          const errorMsg = err?.message || String(err);
          const isQuotaExceeded = errorMsg.includes('429') || 
                                  errorMsg.includes('quota') || 
                                  errorMsg.includes('RESOURCE_EXHAUSTED') || 
                                  errorMsg.includes('exceeded your current quota');
          
          if (isQuotaExceeded) {
            quotaCooldownUntil = Date.now() + 60000;
            console.log('[AI Engine] API quota limit reached. Seamlessly engaging local heuristic scoring engine.');
            break;
          } else {
            console.log(`[AI Engine] Model fallback engaged (${model}).`);
          }
        }
      }

      if (!modelEvaluated) {
        baseResult = calculateHeuristicScore(token, historicalTrades);
      }
    }
  }

  // Pass through AI Learning Engine for pattern adjustment, trader performance, and explainable breakdown
  const learnedEval = aiLearningEngine.evaluateLearnedScore(token, baseResult.score, baseResult.signals);

  return {
    score: learnedEval.finalScore,
    signals: learnedEval.signals,
    breakdown: learnedEval.breakdown,
    confidence: learnedEval.confidence
  };
}
