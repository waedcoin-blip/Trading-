import { RugCheckResult, RugCheckRisk, Settings } from '../types.js';
import { isValidSolanaMint } from '../utils/solana.js';

interface CacheEntry {
  result: RugCheckResult;
  timestamp: number;
}

// 10-minute cache TTL to prevent rate limits and optimize latency
const CACHE_TTL_MS = 10 * 60 * 1000;
const rugcheckCache = new Map<string, CacheEntry>();

/**
 * Fetches and analyzes security report from RugCheck API
 */
export async function getRugCheckReport(mint: string): Promise<RugCheckResult> {
  if (!isValidSolanaMint(mint)) {
    return {
      score: 9999,
      riskLevel: 'Danger',
      mintAuthority: 'INVALID_MINT',
      freezeAuthority: 'INVALID_MINT',
      lpLocked: false,
      lpLockedPct: 0,
      topHoldersPct: 100,
      risks: [{ name: 'Invalid Solana Mint', description: 'Address is not a valid Solana public key', score: 1000, level: 'danger' }],
      status: 'FAILED',
      rejectionReason: 'Invalid Solana Mint Address',
      checkedAt: new Date().toISOString()
    };
  }

  // Check in-memory cache
  const cached = rugcheckCache.get(mint);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.result;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000); // 7s timeout

    let rawData: any = null;
    
    // Try summary endpoint first
    try {
      const summaryRes = await fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report/summary`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'UltraTradingBot/1.0'
        }
      });
      if (summaryRes.ok) {
        rawData = await summaryRes.json();
      }
    } catch {
      // Fallback to full report if summary fails
    }

    if (!rawData) {
      try {
        const fullRes = await fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`, {
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'UltraTradingBot/1.0'
          }
        });
        if (fullRes.ok) {
          rawData = await fullRes.json();
        }
      } catch {
        // Handled below
      }
    }

    clearTimeout(timeoutId);

    if (!rawData) {
      console.warn(`[RugCheck] API unavailable for token: ${mint}`);
      const fallbackResult: RugCheckResult = {
        score: 9999,
        riskLevel: 'Unknown',
        mintAuthority: 'UNKNOWN',
        freezeAuthority: 'UNKNOWN',
        lpLocked: false,
        lpLockedPct: 0,
        topHoldersPct: 100,
        risks: [{ name: 'RugCheck Unavailable', description: 'Failed to retrieve on-chain security report', score: 1000, level: 'danger' }],
        status: 'UNAVAILABLE',
        rejectionReason: 'RUGCHECK_UNAVAILABLE',
        checkedAt: new Date().toISOString()
      };
      return fallbackResult;
    }

    // Parse RugCheck Response
    const score = typeof rawData.score === 'number' ? rawData.score : (rawData.rugged ? 1000 : 0);
    
    // Extract Risk Level (Good / Warn / Danger)
    let riskLevel = 'Danger';
    if (rawData.riskLevel) {
      riskLevel = String(rawData.riskLevel);
    } else if (rawData.status) {
      riskLevel = String(rawData.status);
    } else if (score < 500 && !rawData.rugged) {
      riskLevel = 'Good';
    } else if (score < 1500) {
      riskLevel = 'Warn';
    }

    // Normalize risk level casing (e.g. 'good' -> 'Good')
    if (riskLevel.toLowerCase() === 'good') riskLevel = 'Good';
    else if (riskLevel.toLowerCase() === 'warn' || riskLevel.toLowerCase() === 'warning') riskLevel = 'Warn';
    else riskLevel = 'Danger';

    // Authorities
    let mintAuthority: string | null = null;
    if (rawData.tokenMeta?.mintAuthority !== undefined) {
      mintAuthority = rawData.tokenMeta.mintAuthority;
    } else if (rawData.mintAuthority !== undefined) {
      mintAuthority = rawData.mintAuthority;
    } else if (rawData.token?.mintAuthority !== undefined) {
      mintAuthority = rawData.token.mintAuthority;
    }

    let freezeAuthority: string | null = null;
    if (rawData.tokenMeta?.freezeAuthority !== undefined) {
      freezeAuthority = rawData.tokenMeta.freezeAuthority;
    } else if (rawData.freezeAuthority !== undefined) {
      freezeAuthority = rawData.freezeAuthority;
    } else if (rawData.token?.freezeAuthority !== undefined) {
      freezeAuthority = rawData.token.freezeAuthority;
    }

    // Parse LP Locked status
    let lpLocked = false;
    let lpLockedPct = 0;
    
    if (rawData.markets && Array.isArray(rawData.markets) && rawData.markets.length > 0) {
      const primaryMarket = rawData.markets[0];
      if (primaryMarket.lp) {
        lpLockedPct = Number(primaryMarket.lp.lpLockedPct || primaryMarket.lp.lpBurnedPct || 0);
        lpLocked = primaryMarket.lp.lpLocked === true || primaryMarket.lp.lpBurned === true || lpLockedPct >= 95;
      }
    } else if (rawData.totalLpLockedPct !== undefined) {
      lpLockedPct = Number(rawData.totalLpLockedPct);
      lpLocked = lpLockedPct >= 95;
    } else if (rawData.lpLocked !== undefined) {
      lpLocked = Boolean(rawData.lpLocked);
      lpLockedPct = lpLocked ? 100 : 0;
    } else {
      // Check if unlocked LP risk exists
      const risksList = Array.isArray(rawData.risks) ? rawData.risks : [];
      const hasUnlockedRisk = risksList.some((r: any) => 
        (r.name && r.name.toLowerCase().includes('unlocked')) ||
        (r.description && r.description.toLowerCase().includes('unlocked liquidity'))
      );
      lpLocked = !hasUnlockedRisk;
      lpLockedPct = lpLocked ? 100 : 0;
    }

    // Parse Top Holders concentration
    let topHoldersPct = 0;
    if (Array.isArray(rawData.topHolders)) {
      // Sum top 5 non-pool holders
      const nonPoolHolders = rawData.topHolders
        .filter((h: any) => !h.isLp && !h.isRaydium && !h.isBurned && !h.isProgram)
        .slice(0, 5);
      topHoldersPct = nonPoolHolders.reduce((sum: number, h: any) => sum + (Number(h.pct) || 0), 0);
    } else if (typeof rawData.topHoldersPct === 'number') {
      topHoldersPct = rawData.topHoldersPct;
    } else if (typeof rawData.holderConcentration === 'number') {
      topHoldersPct = rawData.holderConcentration;
    }

    // Parse Risks Array
    const risks: RugCheckRisk[] = (Array.isArray(rawData.risks) ? rawData.risks : []).map((r: any) => ({
      name: String(r.name || 'Risk Indicator'),
      value: r.value,
      description: String(r.description || ''),
      score: Number(r.score || 0),
      level: String(r.level || (r.score > 200 ? 'danger' : r.score > 50 ? 'warn' : 'info'))
    }));

    const result: RugCheckResult = {
      score,
      riskLevel,
      mintAuthority: mintAuthority || null,
      freezeAuthority: freezeAuthority || null,
      lpLocked,
      lpLockedPct: Math.round(lpLockedPct),
      topHoldersPct: Math.round(topHoldersPct * 10) / 10,
      risks,
      status: 'PASSED',
      checkedAt: new Date().toISOString()
    };

    // Cache the result
    rugcheckCache.set(mint, {
      result,
      timestamp: Date.now()
    });

    return result;
  } catch (err: any) {
    console.error(`[RugCheck] Error fetching security report for ${mint}:`, err?.message || err);
    return {
      score: 9999,
      riskLevel: 'Unknown',
      mintAuthority: 'UNKNOWN',
      freezeAuthority: 'UNKNOWN',
      lpLocked: false,
      lpLockedPct: 0,
      topHoldersPct: 100,
      risks: [{ name: 'RugCheck Error', description: 'Network error contacting RugCheck verification API', score: 1000, level: 'danger' }],
      status: 'UNAVAILABLE',
      rejectionReason: 'RUGCHECK_UNAVAILABLE',
      checkedAt: new Date().toISOString()
    };
  }
}

/**
 * Validates a token against User Criteria and RugCheck Security Requirements
 */
export function validateRugCheck(
  rug: RugCheckResult,
  settings: Partial<Settings>
): { passed: boolean; reason?: string } {
  // 1. Mandatory API availability check
  if (rug.status === 'UNAVAILABLE' || rug.status === 'FAILED') {
    return {
      passed: false,
      reason: `RUGCHECK_UNAVAILABLE: ${rug.rejectionReason || 'Security verification failed or API unavailable'}`
    };
  }

  const requiredStatus = settings.requiredRugStatus || ['Good'];
  const maxHolders = typeof settings.maxHolderConcentration === 'number' ? settings.maxHolderConcentration : 20;
  const requireLp = settings.requireLpLocked !== false;
  const requireNoMintAuth = settings.requireMintAuthorityRemoved !== false;
  const requireNoFreezeAuth = settings.requireFreezeAuthorityRemoved !== false;
  const maxScore = typeof settings.maxRiskScore === 'number' ? settings.maxRiskScore : 300;

  // 2. Risk Level Check (Must be 'Good')
  if (!requiredStatus.map(s => s.toLowerCase()).includes(rug.riskLevel.toLowerCase())) {
    return {
      passed: false,
      reason: `RugCheck risk level is '${rug.riskLevel}' (Requires: ${requiredStatus.join(', ')})`
    };
  }

  // 3. Authority Filters
  if (requireNoMintAuth && rug.mintAuthority !== null) {
    return {
      passed: false,
      reason: `Mint authority is ACTIVE (${rug.mintAuthority.slice(0, 8)}...). Must be revoked/null.`
    };
  }

  if (requireNoFreezeAuth && rug.freezeAuthority !== null) {
    return {
      passed: false,
      reason: `Freeze authority is ACTIVE (${rug.freezeAuthority.slice(0, 8)}...). Must be revoked/null.`
    };
  }

  // 4. LP Locked Filter
  if (requireLp && !rug.lpLocked) {
    return {
      passed: false,
      reason: `Liquidity Pool is UNLOCKED (${rug.lpLockedPct}% locked). 95%+ lock required.`
    };
  }

  // 5. Holder Concentration Filter
  if (rug.topHoldersPct > maxHolders) {
    return {
      passed: false,
      reason: `Top holders concentration (${rug.topHoldersPct}%) exceeds maximum limit (${maxHolders}%)`
    };
  }

  // 6. Max Risk Score Check
  if (rug.score > maxScore) {
    return {
      passed: false,
      reason: `RugCheck risk score (${rug.score}) exceeds maximum allowed (${maxScore})`
    };
  }

  // 7. Critical Risks Inspection
  const criticalRisk = rug.risks.find(r => 
    r.level === 'danger' || 
    r.level === 'critical' || 
    r.name.toLowerCase().includes('honeypot') ||
    r.name.toLowerCase().includes('freeze authority') ||
    r.name.toLowerCase().includes('mint authority') ||
    r.name.toLowerCase().includes('unlocked')
  );

  if (criticalRisk) {
    return {
      passed: false,
      reason: `Critical security risk detected: ${criticalRisk.name} (${criticalRisk.description || 'Danger level'})`
    };
  }

  return { passed: true };
}
