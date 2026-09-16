import React, { useState } from 'react';
import { 
  Plus, 
  Trash2, 
  ShieldCheck, 
  Activity, 
  AlertTriangle, 
  CheckCircle2, 
  Zap, 
  UserPlus, 
  X,
  RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ServerState, TraderWallet, TokenObservation } from '../types';
import { isValidSolanaMint } from '../utils/solana';

interface WatchlistPageProps {
  state: ServerState;
  sendAction: (type: string, data: any) => void;
}

export default function WatchlistPage({ state, sendAction }: WatchlistPageProps) {
  const { traders, observations, discoveryFeed } = state;
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number>(120);

  // Filter observations to guarantee only genuine Solana mints are ever rendered
  const validObservations = observations.filter(obs => isValidSolanaMint(obs.token_mint));

  // Ticking countdown timer for 2-minute rolling discovery refresh
  React.useEffect(() => {
    const targetTime = discoveryFeed?.nextRefreshAt || (Date.now() + 120000);
    
    const updateTimer = () => {
      const remaining = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };

    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [discoveryFeed?.nextRefreshAt, discoveryFeed?.timestamp]);

  const formatCountdown = (totalSec: number) => {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const formatTime = (ts?: number | string) => {
    if (!ts) return 'Just now';
    const date = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const handleManualRefresh = async () => {
    if (isManualRefreshing) return;
    setIsManualRefreshing(true);
    try {
      await fetch('/api/discovery/refresh', { method: 'POST' });
    } catch (err) {
      console.error('Manual refresh failed:', err);
    } finally {
      setIsManualRefreshing(false);
    }
  };

  const handleAddTrader = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Trader name is required');
      return;
    }

    if (!address.trim()) {
      setError('Solana wallet address is required');
      return;
    }

    // Strict Solana PublicKey validation
    if (!isValidSolanaMint(address.trim())) {
      setError('Invalid Solana wallet address. Please provide a valid Base58 public key.');
      return;
    }

    sendAction('ADD_TRADER', { name: name.trim(), wallet_address: address.trim() });
    setName('');
    setAddress('');
  };

  return (
    <div className="space-y-6" id="watchlist_container">
      {/* Upper Grid: Add Trader and Status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Add Trader Panel */}
        <div className="lg:col-span-1 bg-[#12161f] border border-[#1e2533] rounded-lg p-5" id="add_trader_panel">
          <div className="flex items-center gap-2 mb-4">
            <UserPlus className="text-[#3b82f6] w-5 h-5" />
            <h2 className="text-md font-semibold text-[#f3f4f6]">Add Monitor Wallet</h2>
          </div>

          <form onSubmit={handleAddTrader} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#9ca3af] mb-1">Trader Name</label>
              <input 
                type="text" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Whale Trader 1"
                className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-3 py-2 text-sm text-[#f3f4f6] focus:outline-none focus:border-[#3b82f6] placeholder-[#4b5563]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#9ca3af] mb-1">Solana Wallet Address</label>
              <input 
                type="text" 
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Real Solana Base58 Address"
                className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-3 py-2 text-sm text-[#f3f4f6] focus:outline-none focus:border-[#3b82f6] placeholder-[#4b5563] font-mono text-xs"
              />
            </div>

            {error && (
              <div className="text-xs bg-[#ef4444]/10 border border-[#ef4444]/20 text-[#f87171] p-2 rounded flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button 
              type="submit"
              className="w-full bg-[#3b82f6] hover:bg-[#2563eb] text-white text-xs font-semibold py-2.5 px-4 rounded transition flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              ADD TRADER
            </button>
          </form>
        </div>

        {/* Monitored Traders List */}
        <div className="lg:col-span-2 bg-[#12161f] border border-[#1e2533] rounded-lg p-5 flex flex-col" id="traders_list_panel">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="text-[#10b981] w-5 h-5 animate-pulse" />
              <h2 className="text-md font-semibold text-[#f3f4f6]">Monitored Wallets ({traders.length})</h2>
            </div>
          </div>

          <div className="flex-1 overflow-x-auto min-h-[200px] max-h-[300px]">
            {traders.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-xs text-[#6b7280]">
                <Activity className="w-8 h-8 mb-2 opacity-20" />
                <p>No wallets currently under monitoring.</p>
                <p className="text-[10px] text-[#4b5563]">Add a real Solana wallet address to listen for on-chain buy transactions.</p>
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#1e2533] text-[#6b7280]">
                    <th className="py-2 font-medium">TRADER INFO</th>
                    <th className="py-2 font-medium">MONITOR STATUS</th>
                    <th className="py-2 font-medium">ACTIVITY STATS</th>
                    <th className="py-2 font-medium text-right">ACTIONS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e2533]/50">
                  {traders.map((trader) => {
                    const detectedBuys = state.trades.filter(t => t.source_trader_id === trader.id).length;
                    const winningCopy = state.trades.filter(t => t.source_trader_id === trader.id && t.pnl_sol > 0).length;
                    const winRate = detectedBuys > 0 ? Math.round((winningCopy / detectedBuys) * 100) : 0;

                    return (
                      <tr key={trader.id} className="hover:bg-[#0b0e14]/40" id={`trader_row_${trader.id}`}>
                        <td className="py-3 pr-2">
                          <div className="font-semibold text-[#f3f4f6]">{trader.name}</div>
                          <div className="text-[10px] text-[#6b7280] font-mono break-all">{trader.wallet_address}</div>
                        </td>
                        <td className="py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            trader.enabled 
                              ? 'bg-[#10b981]/10 text-[#10b981]' 
                              : 'bg-[#6b7280]/10 text-[#6b7280]'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${trader.enabled ? 'bg-[#10b981] animate-pulse' : 'bg-[#6b7280]'}`}></span>
                            {trader.enabled ? 'MONITORING' : 'DISABLED'}
                          </span>
                        </td>
                        <td className="py-3 text-[#f3f4f6]">
                          <div className="grid grid-cols-2 gap-x-3 text-[11px]">
                            <div>Detected Buys: <span className="font-semibold text-blue-400">{detectedBuys}</span></div>
                            <div>Win Rate: <span className="font-semibold text-emerald-400">{winRate}%</span></div>
                          </div>
                        </td>
                        <td className="py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <button 
                              onClick={() => sendAction('TOGGLE_TRADER', { id: trader.id, enabled: !trader.enabled })}
                              className={`px-2 py-1 rounded text-[10px] font-semibold border cursor-pointer ${
                                trader.enabled 
                                  ? 'border-[#ef4444]/20 hover:bg-[#ef4444]/10 text-[#f87171]' 
                                  : 'border-[#10b981]/20 hover:bg-[#10b981]/10 text-[#34d399]'
                              }`}
                            >
                              {trader.enabled ? 'DISABLE' : 'ENABLE'}
                            </button>
                            <button 
                              onClick={() => sendAction('DELETE_TRADER', { id: trader.id })}
                              className="p-1 text-[#6b7280] hover:text-[#f87171] rounded hover:bg-[#ef4444]/10 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Eligible Token Discovery Feed */}
      <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5" id="discovery_feed_panel">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 border-b border-[#1e2533] pb-3">
          <div className="flex items-center gap-2">
            <Zap className="text-[#f59e0b] w-5 h-5 shrink-0" />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-md font-semibold text-[#f3f4f6]">Real-Time Token Discovery & Filter Feed</h2>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  LIVE (2m Rolling)
                </span>
              </div>
              <p className="text-[11px] text-[#6b7280]">Authoritative 120-second discovery feed — automatically purges & replaces every 2 minutes</p>
            </div>
          </div>

          <div className="flex items-center gap-3 self-end sm:self-auto">
            {/* Status & Timer details */}
            <div className="text-right text-[11px] font-mono">
              <div className="text-[#9ca3af]">
                Last updated: <span className="text-[#f3f4f6] font-semibold">{formatTime(discoveryFeed?.timestamp)}</span>
              </div>
              <div className="text-[#6b7280]">
                Next refresh: <span className="text-amber-400 font-bold">{formatCountdown(secondsLeft)}</span>
              </div>
            </div>

            {/* Manual Trigger Button */}
            <button
              onClick={handleManualRefresh}
              disabled={isManualRefreshing || discoveryFeed?.status === 'REFRESHING'}
              className="p-2 bg-[#1e2533] hover:bg-[#2a3447] text-[#d1d5db] hover:text-white rounded text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50"
              title="Force immediate 2-minute discovery refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isManualRefreshing || discoveryFeed?.status === 'REFRESHING' ? 'animate-spin text-amber-400' : ''}`} />
              <span className="hidden md:inline">Refresh</span>
            </button>
          </div>
        </div>

        {/* Refreshing Status Banner */}
        {discoveryFeed?.status === 'REFRESHING' && (
          <div className="mb-4 bg-amber-500/10 border border-amber-500/20 rounded-md p-2.5 text-xs text-amber-300 flex items-center justify-between animate-pulse">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
              <span>Scanning Solana cluster & DexScreener DEX streams... Purging old feed and evaluating fresh candidates.</span>
            </div>
          </div>
        )}

        {/* Error Status Banner */}
        {discoveryFeed?.status === 'FAILED' && discoveryFeed.error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-md p-2.5 text-xs text-red-400 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>Discovery refresh warning: {discoveryFeed.error}. Retrying on next 120s cycle.</span>
            </div>
          </div>
        )}

        {validObservations.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center text-xs text-[#6b7280]">
            <RefreshCw className="w-8 h-8 mb-2 opacity-20 animate-spin" />
            <p className="font-medium text-[#d1d5db]">No tokens currently discovered in this 2-minute window.</p>
            <p className="text-[10px] text-[#4b5563] mt-1">Discovery feed updates every 120 seconds. Next automated scan in {formatCountdown(secondsLeft)}.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" id="observations_grid">
            <AnimatePresence mode="popLayout">
              {validObservations.map((obs) => {
                const isWaitingData = obs.token_name === 'WAITING FOR MARKET DATA';

                return (
                  <motion.div 
                    layout
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    key={obs.id}
                    className={`border rounded-lg p-4 bg-[#0b0e14] transition-all flex flex-col justify-between ${
                      obs.status === 'ELIGIBLE' 
                        ? 'border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.05)]' 
                        : 'border-[#1e2533]'
                    }`}
                    id={`obs_card_${obs.id}`}
                  >
                    <div>
                      {/* Header: Name, Symbol & Status */}
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h3 className="font-bold text-sm text-[#f3f4f6]">
                            {isWaitingData ? 'TOKEN DATA UNAVAILABLE' : obs.token_name}
                          </h3>
                          <div className="text-xs text-blue-400 font-mono font-bold">
                            {isWaitingData ? 'STATUS: WAITING FOR MARKET DATA' : obs.token_symbol}
                          </div>
                        </div>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          obs.status === 'ELIGIBLE' 
                            ? 'bg-[#10b981]/10 text-[#34d399]' 
                            : obs.status === 'WAIT' 
                              ? 'bg-[#f59e0b]/10 text-[#fbbf24]' 
                              : 'bg-[#ef4444]/10 text-[#f87171]'
                        }`}>
                          {obs.status}
                        </span>
                      </div>

                      {/* Real Solana Mint Address */}
                      <div className="text-[9px] text-[#6b7280] font-mono mb-3 bg-[#12161f] p-1.5 rounded truncate select-all">
                        Mint: {obs.token_mint}
                      </div>

                      {/* Quick Specs */}
                      <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-xs mb-3 border-b border-[#1e2533]/50 pb-3">
                        <div>
                          <span className="text-[#6b7280] block text-[10px]">MARKET CAP</span>
                          <span className="text-[#f3f4f6] font-semibold">
                            {obs.market_cap === 'UNKNOWN' ? 'UNAVAILABLE' : `$${obs.market_cap.toLocaleString()}`}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#6b7280] block text-[10px]">LIQUIDITY</span>
                          <span className="text-[#f3f4f6] font-semibold">
                            {obs.liquidity === 'UNKNOWN' ? 'UNAVAILABLE' : `$${obs.liquidity.toLocaleString()}`}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#6b7280] block text-[10px]">DEV HOLDING</span>
                          <span className="text-[#f3f4f6] font-semibold">
                            {obs.developer_holding_percent === 'UNKNOWN' ? 'UNAVAILABLE' : `${obs.developer_holding_percent}%`}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#6b7280] block text-[10px]">BUY TX / 10s</span>
                          <span className="text-[#f3f4f6] font-semibold">
                            {obs.buyers_10s === 'UNKNOWN' ? 'UNAVAILABLE' : `${obs.buyers_10s}`}
                          </span>
                        </div>
                      </div>

                      {/* RugCheck Security Breakdown */}
                      {obs.rugcheck && (
                        <div className="bg-[#12161f] border border-[#1e2533] p-2.5 rounded mb-3 text-[10px] space-y-1">
                          <div className="flex items-center justify-between font-bold border-b border-[#1e2533] pb-1">
                            <span className="text-[#9ca3af] flex items-center gap-1">
                              <ShieldCheck className={`w-3.5 h-3.5 ${obs.rugcheck_passed ? 'text-emerald-400' : 'text-red-400'}`} />
                              RugCheck Security
                            </span>
                            <span className={`px-1.5 py-0.2 rounded uppercase font-bold ${
                              obs.rugcheck.riskLevel === 'Good' && obs.rugcheck_passed !== false
                                ? 'bg-emerald-500/10 text-emerald-400' 
                                : 'bg-red-500/10 text-red-400'
                            }`}>
                              {obs.rugcheck_passed !== false ? `PASSED (${obs.rugcheck.riskLevel})` : `FAILED (${obs.rugcheck.riskLevel})`}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[#9ca3af] pt-0.5">
                            <div>LP: <strong className={obs.rugcheck.lpLocked ? 'text-emerald-400' : 'text-red-400'}>{obs.rugcheck.lpLocked ? 'LOCKED' : 'UNLOCKED'}</strong></div>
                            <div>Top Holders: <strong className={obs.rugcheck.topHoldersPct <= 20 ? 'text-sky-400' : 'text-red-400'}>{obs.rugcheck.topHoldersPct}%</strong></div>
                            <div>Mint Auth: <strong className={obs.rugcheck.mintAuthority ? 'text-red-400' : 'text-emerald-400'}>{obs.rugcheck.mintAuthority ? 'ACTIVE' : 'REMOVED'}</strong></div>
                            <div>Freeze Auth: <strong className={obs.rugcheck.freezeAuthority ? 'text-red-400' : 'text-emerald-400'}>{obs.rugcheck.freezeAuthority ? 'ACTIVE' : 'REMOVED'}</strong></div>
                          </div>
                          {obs.rugcheck.score !== undefined && (
                            <div className="text-[9px] text-[#6b7280] pt-0.5 flex justify-between border-t border-[#1e2533]/40">
                              <span>Risk Score: <strong className="text-[#d1d5db]">{obs.rugcheck.score}</strong></span>
                              <span>LP Locked: <strong className="text-[#d1d5db]">{obs.rugcheck.lpLockedPct}%</strong></span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* AI Scoring Indicator */}
                      {obs.ai_score !== undefined && (
                        <div className="space-y-1.5 mb-3">
                          <div className="flex justify-between items-center text-xs">
                            <span className="text-[#6b7280] text-[10px]">AI COGNITIVE SCORE</span>
                            <span className={`font-bold ${
                              obs.ai_score >= 80 
                                ? 'text-[#10b981]' 
                                : obs.ai_score >= 50 
                                  ? 'text-[#f59e0b]' 
                                  : 'text-[#ef4444]'
                            }`}>{obs.ai_score}/100</span>
                          </div>
                          <div className="w-full bg-[#1e2533] h-1.5 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${
                                obs.ai_score >= 80 
                                  ? 'bg-[#10b981]' 
                                  : obs.ai_score >= 50 
                                    ? 'bg-[#f59e0b]' 
                                    : 'bg-[#ef4444]'
                              }`}
                              style={{ width: `${obs.ai_score}%` }}
                            />
                          </div>

                          {/* Signals */}
                          {obs.ai_signals && (
                            <div className="text-[10px] space-y-1 mt-2">
                              {obs.ai_signals.positive.map((sig, i) => (
                                <div key={i} className="text-[#a7f3d0] flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3 text-[#10b981]" />
                                  <span>{sig}</span>
                                </div>
                              ))}
                              {obs.ai_signals.risks.map((risk, i) => (
                                <div key={i} className="text-[#fca5a5] flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3 text-[#ef4444]" />
                                  <span>{risk}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Card Footer */}
                    <div className="text-[10px] flex items-center justify-between text-[#6b7280] bg-[#12161f]/40 p-2 rounded border border-[#1e2533]/30 mt-2">
                      <span>Trader: <strong className="text-[#d1d5db]">{obs.source_trader_name}</strong></span>
                      {obs.status === 'REJECT' && obs.rejection_reason && (
                        <span className="text-red-400 font-medium truncate max-w-[150px]" title={obs.rejection_reason}>
                          {obs.rejection_reason}
                        </span>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
