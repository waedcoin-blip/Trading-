import React, { useState, useEffect } from 'react';
import { 
  Brain, 
  TrendingUp, 
  AlertTriangle, 
  CheckCircle2, 
  RefreshCw, 
  ShieldCheck, 
  Award, 
  Layers, 
  Search, 
  ChevronRight,
  Sparkles,
  BarChart3,
  UserCheck,
  Zap,
  Info
} from 'lucide-react';
import { 
  ServerState, 
  AILearningSummary, 
  LearnedPattern, 
  TraderIntelligence, 
  AIPerformanceMetrics 
} from '../types';

interface AILearningPageProps {
  state: ServerState;
  sendAction: (actionType: string, payload?: any) => Promise<any>;
}

export default function AILearningPage({ state, sendAction }: AILearningPageProps) {
  const [learningSummary, setLearningSummary] = useState<AILearningSummary | null>(state.aiLearningSummary || null);
  const [winningPatterns, setWinningPatterns] = useState<LearnedPattern[]>([]);
  const [losingPatterns, setLosingPatterns] = useState<LearnedPattern[]>([]);
  const [traders, setTraders] = useState<TraderIntelligence[]>([]);
  const [performance, setPerformance] = useState<AIPerformanceMetrics | null>(null);
  
  const [selectedMint, setSelectedMint] = useState<string>('');
  const [inspectResult, setInspectResult] = useState<any>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // Fetch AI Learning Data from API
  const fetchLearningData = async () => {
    try {
      const [summaryRes, patternsRes, tradersRes, perfRes] = await Promise.all([
        fetch('/api/ai/learning'),
        fetch('/api/ai/learning/patterns'),
        fetch('/api/ai/learning/traders'),
        fetch('/api/ai/learning/performance')
      ]);

      if (summaryRes.ok) {
        const sum = await summaryRes.json();
        setLearningSummary(sum);
      }
      if (patternsRes.ok) {
        const p = await patternsRes.json();
        setWinningPatterns(p.winningPatterns || []);
        setLosingPatterns(p.losingPatterns || []);
      }
      if (tradersRes.ok) {
        const t = await tradersRes.json();
        setTraders(t.traders || []);
      }
      if (perfRes.ok) {
        const perf = await perfRes.json();
        setPerformance(perf);
      }
    } catch (err) {
      console.error('[AI Learning UI] Failed to fetch learning data:', err);
    }
  };

  useEffect(() => {
    fetchLearningData();
    const interval = setInterval(fetchLearningData, 10000);
    return () => clearInterval(interval);
  }, []);

  // Sync if WebSocket state updates
  useEffect(() => {
    if (state.aiLearningSummary) {
      setLearningSummary(state.aiLearningSummary);
    }
  }, [state.aiLearningSummary]);

  // Handle Token Inspection
  const handleInspectToken = async (mint: string) => {
    if (!mint) return;
    setInspectLoading(true);
    setInspectError(null);
    try {
      const res = await fetch(`/api/ai/learning/score/${mint}`);
      if (res.ok) {
        const data = await res.json();
        setInspectResult(data);
      } else {
        const errData = await res.json().catch(() => ({}));
        setInspectError(errData.error || 'Token observation not found in current database.');
        setInspectResult(null);
      }
    } catch (err: any) {
      setInspectError(err?.message || 'Failed to inspect token');
      setInspectResult(null);
    } finally {
      setInspectLoading(false);
    }
  };

  // Handle Learning Engine Reset
  const handleResetLearning = async () => {
    setResetLoading(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/ai/learning/reset', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setStatusMessage({ text: `AI Learning Memory Reset Successfully (${data.recordsCleared || 0} records cleared)`, isError: false });
        await fetchLearningData();
      } else {
        setStatusMessage({ text: 'Failed to reset AI learning state.', isError: true });
      }
    } catch (err: any) {
      setStatusMessage({ text: err?.message || 'Reset failed.', isError: true });
    } finally {
      setResetLoading(false);
      setResetConfirming(false);
    }
  };

  const observations = state.observations || [];

  return (
    <div className="space-y-6 text-[#d1d5db] text-xs">
      
      {/* Header Banner */}
      <div className="bg-[#12161f] border border-[#1e2533] p-5 rounded-lg flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl text-blue-400">
            <Brain className="w-7 h-7" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white tracking-wide">PERSISTENT AI LEARNING ENGINE</h2>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                24/7 ACTIVE PERSISTENCE
              </span>
            </div>
            <p className="text-[#6b7280] text-xs mt-0.5">
              Continuously records trade outcomes, detects high-win market patterns, rates source traders, and refines AI token scoring.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={fetchLearningData}
            className="px-3 py-1.5 bg-[#1e2533] hover:bg-[#2b3548] text-[#d1d5db] hover:text-white rounded font-bold transition flex items-center gap-1.5 border border-[#2b3548]"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            REFRESH
          </button>
          
          <button
            onClick={() => setResetConfirming(true)}
            className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded font-bold transition flex items-center gap-1.5"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            RESET AI LEARNING
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className={`p-3 rounded border font-medium flex items-center justify-between ${
          statusMessage.isError ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
        }`}>
          <span>{statusMessage.text}</span>
          <button onClick={() => setStatusMessage(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}

      {/* Confirmation Modal */}
      {resetConfirming && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#12161f] border border-red-500/30 p-6 rounded-lg max-w-md w-full space-y-4">
            <div className="flex items-center gap-3 text-red-400">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="text-sm font-bold text-white">Reset AI Learning Engine?</h3>
            </div>
            <p className="text-[#9ca3af] text-xs leading-relaxed">
              This will erase all learned trade records, historical patterns, and trader intelligence scores. 
              The system will return to clean baseline Gemini + heuristic scoring mode.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setResetConfirming(false)}
                className="px-4 py-2 bg-[#1e2533] hover:bg-[#2b3548] text-white rounded font-bold"
              >
                Cancel
              </button>
              <button
                onClick={handleResetLearning}
                disabled={resetLoading}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded font-bold flex items-center gap-2"
              >
                {resetLoading ? 'Resetting...' : 'Confirm Reset'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Metric Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        {/* Total Learned Trades */}
        <div className="bg-[#12161f] border border-[#1e2533] p-4 rounded-lg flex items-center justify-between">
          <div>
            <span className="text-[#6b7280] font-semibold tracking-wider text-[10px] block uppercase">Learned Trade Records</span>
            <span className="text-xl font-extrabold text-white mt-1 block">
              {learningSummary?.totalLearningRecords ?? 0}
            </span>
            <span className="text-[10px] text-[#6b7280] mt-0.5 block">Persisted in db.json</span>
          </div>
          <div className="p-3 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20">
            <Layers className="w-5 h-5" />
          </div>
        </div>

        {/* AI Win Rate */}
        <div className="bg-[#12161f] border border-[#1e2533] p-4 rounded-lg flex items-center justify-between">
          <div>
            <span className="text-[#6b7280] font-semibold tracking-wider text-[10px] block uppercase">AI Model Win Rate</span>
            <span className={`text-xl font-extrabold mt-1 block ${
              (learningSummary?.overallWinRate ?? 0) >= 50 ? 'text-emerald-400' : 'text-amber-400'
            }`}>
              {learningSummary?.overallWinRate ?? 0}%
            </span>
            <span className="text-[10px] text-[#6b7280] mt-0.5 block">
              {learningSummary?.winningTradesCount ?? 0} W / {learningSummary?.losingTradesCount ?? 0} L
            </span>
          </div>
          <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
            <TrendingUp className="w-5 h-5" />
          </div>
        </div>

        {/* High Score Accuracy */}
        <div className="bg-[#12161f] border border-[#1e2533] p-4 rounded-lg flex items-center justify-between">
          <div>
            <span className="text-[#6b7280] font-semibold tracking-wider text-[10px] block uppercase">High Score Win Rate (&gt;75)</span>
            <span className="text-xl font-extrabold text-blue-400 mt-1 block">
              {performance?.highScoreWinRate ?? 0}%
            </span>
            <span className="text-[10px] text-[#6b7280] mt-0.5 block">
              Accuracy correlation metric
            </span>
          </div>
          <div className="p-3 bg-indigo-500/10 text-indigo-400 rounded-lg border border-indigo-500/20">
            <Award className="w-5 h-5" />
          </div>
        </div>

        {/* Active Intelligence */}
        <div className="bg-[#12161f] border border-[#1e2533] p-4 rounded-lg flex items-center justify-between">
          <div>
            <span className="text-[#6b7280] font-semibold tracking-wider text-[10px] block uppercase">Tracked Patterns &amp; Traders</span>
            <span className="text-xl font-extrabold text-white mt-1 block">
              {(winningPatterns.length + losingPatterns.length)} P / {traders.length} T
            </span>
            <span className="text-[10px] text-[#6b7280] mt-0.5 block">Discovered market signals</span>
          </div>
          <div className="p-3 bg-purple-500/10 text-purple-400 rounded-lg border border-purple-500/20">
            <Sparkles className="w-5 h-5" />
          </div>
        </div>

      </div>

      {/* Row 2: Pattern Intelligence & Trader Performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Winning Patterns */}
        <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#1e2533] pb-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <h3 className="font-bold text-white text-xs uppercase tracking-wide">Top Winning Market Patterns</h3>
            </div>
            <span className="text-[10px] text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
              Score Boost Signals
            </span>
          </div>

          {winningPatterns.length === 0 ? (
            <div className="py-8 text-center text-[#6b7280]">
              <Info className="w-6 h-6 mx-auto mb-2 opacity-40" />
              <p>No winning patterns recorded yet. Complete paper/mainnet trades to populate pattern intelligence.</p>
            </div>
          ) : (
            <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
              {winningPatterns.map((pat, idx) => (
                <div key={idx} className="bg-[#0c0f16] border border-[#1e2533] p-3 rounded-lg flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white">{pat.patternName}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-mono">
                        {pat.sampleCount} trades
                      </span>
                    </div>
                    <p className="text-[11px] text-[#9ca3af]">{pat.description}</p>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-xs font-bold text-emerald-400 block">{pat.winRate}% Win</span>
                    <span className="text-[10px] text-[#6b7280] block">Avg PnL: +{pat.avgPnLPercent}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Losing Patterns */}
        <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#1e2533] pb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <h3 className="font-bold text-white text-xs uppercase tracking-wide">Top Losing Risk Patterns</h3>
            </div>
            <span className="text-[10px] text-red-400 font-bold bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded">
              Score Penalty Signals
            </span>
          </div>

          {losingPatterns.length === 0 ? (
            <div className="py-8 text-center text-[#6b7280]">
              <Info className="w-6 h-6 mx-auto mb-2 opacity-40" />
              <p>No losing patterns detected yet.</p>
            </div>
          ) : (
            <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
              {losingPatterns.map((pat, idx) => (
                <div key={idx} className="bg-[#0c0f16] border border-[#1e2533] p-3 rounded-lg flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white">{pat.patternName}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 font-mono">
                        {pat.sampleCount} trades
                      </span>
                    </div>
                    <p className="text-[11px] text-[#9ca3af]">{pat.description}</p>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-xs font-bold text-red-400 block">{pat.winRate}% Win</span>
                    <span className="text-[10px] text-[#6b7280] block">Avg PnL: {pat.avgPnLPercent}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Row 3: Source Trader Intelligence Leaderboard */}
      <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-[#1e2533] pb-3">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-blue-400" />
            <h3 className="font-bold text-white text-xs uppercase tracking-wide">Source Trader Performance Intelligence</h3>
          </div>
          <span className="text-[10px] text-[#6b7280]">Ranked by Reliability Score &amp; Win Rate</span>
        </div>

        {traders.length === 0 ? (
          <div className="py-8 text-center text-[#6b7280]">
            <p>No source trader history recorded yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1e2533] text-[10px] text-[#6b7280] uppercase tracking-wider">
                  <th className="pb-2 font-bold">Trader Name / Address</th>
                  <th className="pb-2 font-bold text-center">Trades Copied</th>
                  <th className="pb-2 font-bold text-center">Win Rate %</th>
                  <th className="pb-2 font-bold text-right">Avg PnL %</th>
                  <th className="pb-2 font-bold text-center">Reliability Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e2533]/50">
                {traders.map((t) => (
                  <tr key={t.traderId} className="hover:bg-[#181f2c]/50 transition">
                    <td className="py-3 font-medium text-white flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 font-bold text-[10px]">
                        {t.traderName.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <span className="font-bold block text-white">{t.traderName}</span>
                        <span className="text-[10px] text-[#6b7280] font-mono">{t.traderId}</span>
                      </div>
                    </td>
                    <td className="py-3 text-center font-mono text-white">
                      {t.totalTradesCopied}
                    </td>
                    <td className="py-3 text-center font-bold">
                      <span className={t.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}>
                        {t.winRate}%
                      </span>
                    </td>
                    <td className="py-3 text-right font-mono font-bold">
                      <span className={t.avgPnLPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {t.avgPnLPercent >= 0 ? '+' : ''}{t.avgPnLPercent}%
                      </span>
                    </td>
                    <td className="py-3 text-center">
                      <div className="inline-flex items-center gap-1.5 bg-[#0c0f16] border border-[#1e2533] px-2.5 py-1 rounded-full font-bold">
                        <ShieldCheck className={`w-3.5 h-3.5 ${
                          t.reliabilityScore >= 70 ? 'text-emerald-400' : t.reliabilityScore >= 40 ? 'text-amber-400' : 'text-red-400'
                        }`} />
                        <span className="text-white font-mono">{t.reliabilityScore}/100</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Row 4: Real-Time Token AI Score Evaluator */}
      <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-[#1e2533] pb-3">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-blue-400" />
            <h3 className="font-bold text-white text-xs uppercase tracking-wide">Live Token AI Score Inspector</h3>
          </div>
          <span className="text-[10px] text-[#6b7280]">Inspect how Gemini + AI Learning Engine calculates final scores</span>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3">
          <select
            value={selectedMint}
            onChange={(e) => {
              setSelectedMint(e.target.value);
              if (e.target.value) handleInspectToken(e.target.value);
            }}
            className="flex-1 bg-[#0c0f16] border border-[#1e2533] rounded px-3 py-2 text-white font-mono focus:outline-none focus:border-blue-500 w-full"
          >
            <option value="">-- Select an observed token mint --</option>
            {observations.map((o) => (
              <option key={o.id} value={o.token_mint}>
                {o.token_name} ({o.token_symbol}) - {o.token_mint.slice(0, 8)}...
              </option>
            ))}
          </select>

          <input
            type="text"
            placeholder="Or enter mint address..."
            value={selectedMint}
            onChange={(e) => setSelectedMint(e.target.value)}
            className="flex-1 bg-[#0c0f16] border border-[#1e2533] rounded px-3 py-2 text-white font-mono focus:outline-none focus:border-blue-500 w-full"
          />

          <button
            onClick={() => handleInspectToken(selectedMint)}
            disabled={!selectedMint || inspectLoading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold transition flex items-center gap-1.5 shrink-0 disabled:opacity-50"
          >
            {inspectLoading ? 'Evaluating...' : 'Evaluate'}
          </button>
        </div>

        {inspectError && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded text-xs">
            {inspectError}
          </div>
        )}

        {inspectResult && (
          <div className="bg-[#0c0f16] border border-[#1e2533] p-4 rounded-lg space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1e2533] pb-3">
              <div>
                <span className="text-[#6b7280] text-[10px] block uppercase">Final Learned AI Score</span>
                <span className="text-3xl font-extrabold text-blue-400 font-mono">
                  {inspectResult.score} / 99
                </span>
              </div>

              {inspectResult.breakdown && (
                <div className="flex items-center gap-4 text-xs">
                  <div className="text-center">
                    <span className="text-[#6b7280] text-[10px] block">Base AI Score</span>
                    <span className="font-bold text-white font-mono">{inspectResult.breakdown.baseAIScore}</span>
                  </div>
                  <div className="text-center">
                    <span className="text-[#6b7280] text-[10px] block">Pattern Adj</span>
                    <span className={`font-bold font-mono ${inspectResult.breakdown.patternAdjustment >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {inspectResult.breakdown.patternAdjustment >= 0 ? '+' : ''}{inspectResult.breakdown.patternAdjustment}
                    </span>
                  </div>
                  <div className="text-center">
                    <span className="text-[#6b7280] text-[10px] block">Trader Boost</span>
                    <span className={`font-bold font-mono ${inspectResult.breakdown.traderPerformanceAdjustment >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {inspectResult.breakdown.traderPerformanceAdjustment >= 0 ? '+' : ''}{inspectResult.breakdown.traderPerformanceAdjustment}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Signals */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <span className="text-emerald-400 font-bold text-[10px] uppercase block mb-1">Positive Signals</span>
                <ul className="space-y-1">
                  {(inspectResult.signals?.positive || []).map((sig: string, i: number) => (
                    <li key={i} className="text-emerald-300 flex items-center gap-1.5 text-xs">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>{sig}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <span className="text-red-400 font-bold text-[10px] uppercase block mb-1">Key Risks</span>
                <ul className="space-y-1">
                  {(inspectResult.signals?.risks || []).map((risk: string, i: number) => (
                    <li key={i} className="text-red-300 flex items-center gap-1.5 text-xs">
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      <span>{risk}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

          </div>
        )}
      </div>

    </div>
  );
}
