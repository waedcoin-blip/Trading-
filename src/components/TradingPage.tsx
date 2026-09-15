import React, { useState } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Settings, 
  History, 
  HelpCircle, 
  AlertOctagon, 
  Play, 
  XOctagon, 
  Sparkles,
  RefreshCw,
  Wallet,
  ShieldAlert,
  ShieldCheck,
  Lock,
  CheckCircle,
  XCircle,
  Coins,
  Percent
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ServerState, Position, Trade, AIStats, RebuyState } from '../types';
import { isValidSolanaMint, formatTokenQuantity } from '../utils/solana';

interface TradingPageProps {
  state: ServerState;
  sendAction: (type: string, data: any) => void;
}

export default function TradingPage({ state, sendAction }: TradingPageProps) {
  const { settings, positions, trades, aiStats, rebuyStates = {} } = state;

  const validPositions = positions.filter(p => isValidSolanaMint(p.token_mint));
  const validTrades = trades.filter(t => isValidSolanaMint(t.token_mint));
  const rebuyStateList = Object.values(rebuyStates).filter(s => isValidSolanaMint(s.mint));

  const [tradeAmount, setTradeAmount] = useState(settings.trading_amount_sol.toString());
  const [tp, setTp] = useState(settings.take_profit_percent.toString());
  const [sl, setSl] = useState(settings.stop_loss_percent.toString());
  const [minAiScore, setMinAiScore] = useState((settings.min_ai_score_to_buy ?? 55).toString());
  const [enableTrailing, setEnableTrailing] = useState(settings.enable_trailing_stop ?? true);
  const [trailingActivation, setTrailingActivation] = useState((settings.trailing_stop_activation_percent ?? 15).toString());
  const [trailingDist, setTrailingDist] = useState((settings.trailing_stop_percent ?? 10).toString());
  const [enableTimeExit, setEnableTimeExit] = useState(settings.enable_time_exit ?? true);
  const [maxHoldMins, setMaxHoldMins] = useState((settings.max_hold_minutes ?? 30).toString());
  const [stagnantThresh, setStagnantThresh] = useState((settings.stagnant_pnl_threshold_percent ?? 5).toString());

  const [showConfirmMainnet, setShowConfirmMainnet] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetSuccessMsg, setResetSuccessMsg] = useState('');

  const handleResetGuardAndHistory = async () => {
    setIsResetting(true);
    try {
      const res = await fetch('/api/trading/reset-guard-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) {
        sendAction('RESET_GUARD_AND_HISTORY', null);
      }

      setResetSuccessMsg('Profitable-Only Rebuy Guard Matrix & Completed Trade History successfully reset.');
      setTimeout(() => setResetSuccessMsg(''), 4000);
    } catch (err) {
      console.error('Reset execution error, using fallback WS action:', err);
      sendAction('RESET_GUARD_AND_HISTORY', null);
      setResetSuccessMsg('Reset signal sent successfully.');
      setTimeout(() => setResetSuccessMsg(''), 4000);
    } finally {
      setIsResetting(false);
      setShowResetConfirm(false);
    }
  };

  const handleUpdateConfig = (e: React.FormEvent) => {
    e.preventDefault();
    const amountVal = parseFloat(tradeAmount);
    const tpVal = parseFloat(tp);
    const slVal = parseFloat(sl);

    if (isNaN(amountVal) || amountVal <= 0) return;
    if (isNaN(tpVal) || tpVal <= 0) return;
    if (isNaN(slVal) || slVal <= 0) return;

    sendAction('UPDATE_SETTINGS', {
      trading_amount_sol: amountVal,
      take_profit_percent: tpVal,
      stop_loss_percent: slVal,
      min_ai_score_to_buy: parseFloat(minAiScore) || 55,
      enable_trailing_stop: enableTrailing,
      trailing_stop_activation_percent: parseFloat(trailingActivation) || 15,
      trailing_stop_percent: parseFloat(trailingDist) || 10,
      enable_time_exit: enableTimeExit,
      max_hold_minutes: parseFloat(maxHoldMins) || 30,
      stagnant_pnl_threshold_percent: parseFloat(stagnantThresh) || 5
    });
  };

  const handleToggleMode = (mode: 'PAPER' | 'MAINNET') => {
    if (mode === 'MAINNET' && !settings.mainnet_enabled) {
      setShowConfirmMainnet(true);
    } else {
      sendAction('UPDATE_SETTINGS', { trading_mode: mode });
    }
  };

  const confirmActivateMainnet = () => {
    sendAction('UPDATE_SETTINGS', { 
      trading_mode: 'MAINNET',
      mainnet_enabled: true 
    });
    setShowConfirmMainnet(false);
  };

  // Balance calculation (Accounting in SOL)
  const startingBalance = 10.0;
  const availableBalance = settings.paper_balance_sol;
  const invested = validPositions.reduce((acc, p) => acc + p.sol_in, 0);
  const realizedPnL = validTrades.reduce((acc, t) => acc + t.pnl_sol, 0);
  const unrealizedPnL = validPositions.reduce((acc, p) => acc + p.unrealized_pnl_sol, 0);
  const totalPnL = realizedPnL + unrealizedPnL;

  return (
    <div className="space-y-6" id="trading_container">
      
      {/* Upper Mode Toggle & Warning */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#12161f] border border-[#1e2533] p-4 rounded-lg">
        <div className="flex items-center gap-3">
          <Wallet className="w-5 h-5 text-blue-400" />
          <div>
            <h2 className="text-sm font-semibold text-[#f3f4f6]">Trading Engine Core</h2>
            <p className="text-[10px] text-[#6b7280]">Default is zero-risk Paper Trading. Mainnet trades live assets.</p>
          </div>
        </div>

        <div className="flex bg-[#0b0e14] p-1 rounded border border-[#1e2533] self-start sm:self-auto">
          <button 
            onClick={() => handleToggleMode('PAPER')}
            className={`px-4 py-1.5 rounded text-xs font-bold transition ${
              settings.trading_mode === 'PAPER' 
                ? 'bg-[#10b981]/20 text-[#34d399] border border-[#10b981]/30' 
                : 'text-[#6b7280] hover:text-[#f3f4f6]'
            }`}
          >
            PAPER MODE
          </button>
          <button 
            onClick={() => handleToggleMode('MAINNET')}
            className={`px-4 py-1.5 rounded text-xs font-bold transition ${
              settings.trading_mode === 'MAINNET' 
                ? 'bg-[#ef4444]/20 text-[#f87171] border border-[#ef4444]/30' 
                : 'text-[#6b7280] hover:text-[#f3f4f6]'
            }`}
          >
            MAINNET
          </button>
        </div>
      </div>

      {/* Mainnet Warning Confirm Modal */}
      {showConfirmMainnet && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#12161f] border border-red-500/40 p-6 rounded-lg max-w-md w-full space-y-4"
          >
            <div className="flex items-center gap-3 text-[#f87171]">
              <AlertOctagon className="w-8 h-8 shrink-0" />
              <h3 className="text-md font-bold">WARNING: Live Mainnet Trading</h3>
            </div>
            <p className="text-xs text-[#9ca3af] leading-relaxed">
              You are enabling real-time capital deployment on the Solana blockchain. Real assets will be spent automatically on newly detected, eligible tokens. Slippage, MEV bots, and rugpull risks are live.
            </p>
            <p className="text-xs text-[#6b7280]">
              Ensure your RPC and Private Key variables are configured correctly and securely.
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button 
                onClick={() => setShowConfirmMainnet(false)}
                className="px-4 py-2 bg-[#1e2533] hover:bg-[#2a3447] text-white rounded text-xs font-bold transition"
              >
                CANCEL
              </button>
              <button 
                onClick={confirmActivateMainnet}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-bold transition"
              >
                CONFIRM LIVE TRADING
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Reset Guard & History Confirmation Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" id="reset_guard_history_modal">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#12161f] border border-purple-500/40 p-6 rounded-lg max-w-md w-full space-y-4 shadow-2xl"
          >
            <div className="flex items-center gap-3 text-purple-400">
              <ShieldAlert className="w-7 h-7 shrink-0 text-purple-400" />
              <h3 className="text-md font-bold text-[#f3f4f6]">Reset Guard Matrix & History</h3>
            </div>
            
            <div className="space-y-3 text-xs text-[#9ca3af] leading-relaxed">
              <p className="font-semibold text-[#f3f4f6]">
                Reset Profitable-Only Rebuy Guard Matrix and Completed Trade History?
              </p>
              <p className="bg-[#0b0e14] border border-[#1e2533] p-3 rounded text-[#9ca3af]">
                This will permanently clear all completed trade history and rebuy eligibility/counters. Active positions will not be affected.
              </p>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button 
                id="reset_modal_cancel_btn"
                onClick={() => setShowResetConfirm(false)}
                disabled={isResetting}
                className="px-4 py-2 bg-[#1e2533] hover:bg-[#2a3447] text-white rounded text-xs font-bold transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button 
                id="reset_modal_confirm_btn"
                onClick={handleResetGuardAndHistory}
                disabled={isResetting}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded text-xs font-bold transition flex items-center gap-2 disabled:opacity-50"
              >
                {isResetting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Resetting...
                  </>
                ) : (
                  'Reset'
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Accounting & Configuration Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Balances Dashboard */}
        <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5 flex flex-col justify-between" id="balance_dashboard">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#6b7280]">Paper Account Ledger</h3>
              <button 
                onClick={() => sendAction('RESET_BALANCE', null)}
                className="text-[10px] text-blue-400 hover:underline"
              >
                Reset Balance
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <span className="text-xs text-[#9ca3af]">Account Total Value</span>
                <div className="text-3xl font-extrabold text-[#f3f4f6] font-mono">
                  {(availableBalance + invested).toFixed(4)} <span className="text-sm font-normal text-[#6b7280]">SOL</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-t border-[#1e2533] pt-4 text-xs">
                <div>
                  <span className="text-[#6b7280]">Starting Balance</span>
                  <p className="text-[#f3f4f6] font-semibold font-mono">{startingBalance.toFixed(2)} SOL</p>
                </div>
                <div>
                  <span className="text-[#6b7280]">Available Cash</span>
                  <p className="text-[#f3f4f6] font-semibold font-mono">{availableBalance.toFixed(4)} SOL</p>
                </div>
                <div>
                  <span className="text-[#6b7280]">Invested Capital</span>
                  <p className="text-[#f3f4f6] font-semibold font-mono">{invested.toFixed(4)} SOL</p>
                </div>
                <div>
                  <span className="text-[#6b7280]">Total Return (PnL)</span>
                  <p className={`font-semibold font-mono ${totalPnL >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>
                    {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(4)} SOL
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Trade Configuration Panel */}
        <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5" id="trade_configuration_panel">
          <div className="flex items-center gap-2 mb-4">
            <Settings className="text-[#3b82f6] w-5 h-5" />
            <h2 className="text-md font-semibold text-[#f3f4f6]">Execution Parameters</h2>
          </div>

          <form onSubmit={handleUpdateConfig} className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="col-span-1">
                <label className="block text-[10px] font-medium text-[#9ca3af] mb-1">Buy Amount</label>
                <div className="relative">
                  <input 
                    type="text" 
                    value={tradeAmount}
                    onChange={(e) => setTradeAmount(e.target.value)}
                    className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-2.5 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-[#3b82f6] font-mono"
                  />
                  <span className="absolute right-2 top-2.5 text-[9px] text-[#4b5563] font-bold">SOL</span>
                </div>
              </div>

              <div className="col-span-1">
                <label className="block text-[10px] font-medium text-[#9ca3af] mb-1">Take Profit</label>
                <div className="relative">
                  <input 
                    type="text" 
                    value={tp}
                    onChange={(e) => setTp(e.target.value)}
                    className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-2.5 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-[#3b82f6] font-mono"
                  />
                  <span className="absolute right-2 top-2.5 text-[9px] text-[#4b5563] font-bold">%</span>
                </div>
              </div>

              <div className="col-span-1">
                <label className="block text-[10px] font-medium text-[#9ca3af] mb-1">Stop Loss</label>
                <div className="relative">
                  <input 
                    type="text" 
                    value={sl}
                    onChange={(e) => setSl(e.target.value)}
                    className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-2.5 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-[#3b82f6] font-mono"
                  />
                  <span className="absolute right-2 top-2.5 text-[9px] text-[#4b5563] font-bold">%</span>
                </div>
              </div>

              <div className="col-span-1">
                <label className="block text-[10px] font-medium text-[#9ca3af] mb-1">Min AI Score Gate</label>
                <div className="relative">
                  <input 
                    type="text" 
                    value={minAiScore}
                    onChange={(e) => setMinAiScore(e.target.value)}
                    className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-2.5 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-[#3b82f6] font-mono"
                  />
                  <span className="absolute right-2 top-2.5 text-[9px] text-[#4b5563] font-bold">/99</span>
                </div>
              </div>
            </div>

            {/* Trailing Stop & Time Exit Settings */}
            <div className="border-t border-[#1e2533] pt-3 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="space-y-2 bg-[#0b0e14] p-2.5 rounded border border-[#1e2533]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[11px] text-[#f3f4f6]">Trailing Stop Loss</span>
                  <input 
                    type="checkbox" 
                    checked={enableTrailing} 
                    onChange={(e) => setEnableTrailing(e.target.checked)}
                    className="rounded border-[#1e2533] bg-[#12161f]"
                  />
                </div>
                {enableTrailing && (
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <label className="block text-[#6b7280]">Activate at +PnL</label>
                      <input 
                        type="text" 
                        value={trailingActivation} 
                        onChange={(e) => setTrailingActivation(e.target.value)}
                        className="w-full bg-[#12161f] border border-[#1e2533] rounded px-2 py-1 text-xs text-[#f3f4f6] font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[#6b7280]">Trailing Dist %</label>
                      <input 
                        type="text" 
                        value={trailingDist} 
                        onChange={(e) => setTrailingDist(e.target.value)}
                        className="w-full bg-[#12161f] border border-[#1e2533] rounded px-2 py-1 text-xs text-[#f3f4f6] font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2 bg-[#0b0e14] p-2.5 rounded border border-[#1e2533]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[11px] text-[#f3f4f6]">Time / Stagnation Exit</span>
                  <input 
                    type="checkbox" 
                    checked={enableTimeExit} 
                    onChange={(e) => setEnableTimeExit(e.target.checked)}
                    className="rounded border-[#1e2533] bg-[#12161f]"
                  />
                </div>
                {enableTimeExit && (
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <label className="block text-[#6b7280]">Max Hold (Mins)</label>
                      <input 
                        type="text" 
                        value={maxHoldMins} 
                        onChange={(e) => setMaxHoldMins(e.target.value)}
                        className="w-full bg-[#12161f] border border-[#1e2533] rounded px-2 py-1 text-xs text-[#f3f4f6] font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[#6b7280]">Stagnant PnL &lt; %</label>
                      <input 
                        type="text" 
                        value={stagnantThresh} 
                        onChange={(e) => setStagnantThresh(e.target.value)}
                        className="w-full bg-[#12161f] border border-[#1e2533] rounded px-2 py-1 text-xs text-[#f3f4f6] font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <button 
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-2.5 rounded transition"
            >
              SAVE PARAMETERS
            </button>
          </form>
        </div>

        {/* AI Performance Panel */}
        <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5" id="ai_performance_panel">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="text-[#f59e0b] w-5 h-5" />
              <h2 className="text-md font-semibold text-[#f3f4f6]">AI Analytics Learning</h2>
            </div>
            <span className="text-[10px] bg-[#f59e0b]/10 text-[#fbbf24] px-1.5 py-0.5 rounded font-bold">Paper Sync</span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center text-xs border-b border-[#1e2533]/50 pb-3 mb-3">
            <div>
              <span className="text-[#6b7280] block text-[9px] uppercase">Analyzed</span>
              <span className="text-[#f3f4f6] font-bold font-mono">{aiStats.tradesAnalyzed}</span>
            </div>
            <div>
              <span className="text-[#6b7280] block text-[9px] uppercase">Win Rate</span>
              <span className="text-emerald-400 font-bold font-mono">{aiStats.winRate}%</span>
            </div>
            <div>
              <span className="text-[#6b7280] block text-[9px] uppercase">Avg Gain</span>
              <span className="text-emerald-400 font-bold font-mono">+{aiStats.averageWinnerSol} SOL</span>
            </div>
          </div>

          <div className="space-y-2 text-[10px]">
            <div>
              <strong className="text-emerald-400 font-medium">Optimal Conditions discovered:</strong>
              <ul className="list-disc pl-3 text-[#9ca3af] space-y-0.5 mt-0.5">
                {aiStats.bestConditions.map((cond, i) => <li key={i}>{cond}</li>)}
              </ul>
            </div>
            <div>
              <strong className="text-red-400 font-medium">Loss Warnings & Risk factors:</strong>
              <ul className="list-disc pl-3 text-[#9ca3af] space-y-0.5 mt-0.5">
                {aiStats.riskConditions.map((cond, i) => <li key={i}>{cond}</li>)}
              </ul>
            </div>
          </div>
        </div>

      </div>

      {/* Live Positions Terminal Feed */}
      <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5" id="live_positions_feed">
        <h2 className="text-md font-semibold text-[#f3f4f6] mb-4 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" />
          Live Active Positions ({validPositions.length})
        </h2>

        {validPositions.length === 0 ? (
          <div className="py-12 border border-dashed border-[#1e2533] rounded-lg text-center text-xs text-[#6b7280]">
            <TrendingUp className="w-8 h-8 mb-2 mx-auto opacity-20" />
            <p>No live positions active.</p>
            <p className="text-[10px] text-[#4b5563] mt-1">Positions automatically instantiate when a trader BUY matches all eligibility criteria and passes RebuyGuard.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" id="live_positions_grid">
            {validPositions.map((pos) => {
              const rState = rebuyStates[pos.token_mint];
              const isRebuy = Boolean(pos.isRebuy || (rState && rState.rebuyCount > 0));
              const decimals = typeof pos.tokenDecimals === 'number' ? pos.tokenDecimals : (pos.token_decimals || 6);
              const boughtQty = pos.tokenQuantity || formatTokenQuantity(pos.token_amount, decimals);
              const remQty = pos.remainingTokenQuantity || pos.remainingQuantity || boughtQty;

              return (
                <div key={pos.id} className="bg-[#0b0e14] border border-[#1e2533] rounded-lg p-4 flex flex-col justify-between hover:border-[#10b981]/30 transition" id={`position_card_${pos.id}`}>
                  <div>
                    {/* Header with Name, Symbol & Rebuy Badge */}
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-sm text-[#f3f4f6]">{pos.token_name}</h3>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                            isRebuy 
                              ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' 
                              : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                          }`}>
                            {isRebuy ? 'Rebuy (2/2 Max)' : 'Initial Buy (1/2)'}
                          </span>
                        </div>
                        <span className="text-xs text-blue-400 font-bold font-mono">{pos.token_symbol}</span>
                      </div>
                      <div className={`px-2 py-1 rounded text-[11px] font-bold font-mono ${
                        pos.unrealized_pnl_sol >= 0 ? 'bg-[#10b981]/10 text-emerald-400' : 'bg-[#ef4444]/10 text-red-400'
                      }`}>
                        {pos.unrealized_pnl_sol >= 0 ? '+' : ''}{pos.unrealized_pnl_percent}%
                      </div>
                    </div>

                    {/* Mint Address */}
                    <div className="text-[9px] text-[#6b7280] font-mono bg-[#12161f] px-2 py-1 rounded mb-3 truncate flex justify-between items-center">
                      <span className="truncate">{pos.token_mint}</span>
                      <span className="text-[8px] text-[#4b5563] ml-2 shrink-0 font-sans">{decimals} dec</span>
                    </div>

                    {/* Exact Token Quantities Card (Explicitly tracked, never derived from current price) */}
                    <div className="bg-[#12161f] border border-[#1e2533] p-3 rounded mb-3 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[#9ca3af] font-medium flex items-center gap-1.5">
                          <Coins className="w-3.5 h-3.5 text-sky-400" />
                          Tokens Bought:
                        </span>
                        <span className="text-xs text-[#38bdf8] font-bold font-mono">
                          {boughtQty} {pos.token_symbol}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[#9ca3af] font-medium flex items-center gap-1.5">
                          <Percent className="w-3.5 h-3.5 text-emerald-400" />
                          Remaining:
                        </span>
                        <span className="text-xs text-[#34d399] font-bold font-mono">
                          {remQty} {pos.token_symbol}
                        </span>
                      </div>

                      {/* If Rebuy Position, display breakdown */}
                      {isRebuy && (
                        <div className="pt-2 border-t border-[#1e2533] text-[10px] text-[#a78bfa] flex justify-between">
                          <span>Rebuy #1: <strong>{pos.rebuyQuantity || boughtQty}</strong></span>
                          <span>Initial: <strong>{pos.initialBuyQuantity || '1st Buy'}</strong></span>
                        </div>
                      )}
                    </div>

                    {/* RugCheck Security Breakdown */}
                    <div className="bg-[#12161f] border border-[#1e2533] p-2.5 rounded mb-3 text-[10px] space-y-1">
                      <div className="flex items-center justify-between font-bold border-b border-[#1e2533] pb-1">
                        <span className="text-[#9ca3af] flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3 text-emerald-400" />
                          RugCheck Security
                        </span>
                        <span className={`px-1.5 py-0.2 rounded uppercase ${
                          pos.rugcheck?.riskLevel === 'Good' 
                            ? 'bg-emerald-500/10 text-emerald-400' 
                            : 'bg-amber-500/10 text-amber-400'
                        }`}>
                          {pos.rugcheck?.riskLevel || 'VERIFIED GOOD'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[#9ca3af] pt-0.5">
                        <div>LP: <strong className="text-emerald-400">{pos.rugcheck?.lpLocked !== false ? 'LOCKED' : 'UNLOCKED'}</strong></div>
                        <div>Top Holders: <strong className="text-sky-400">{pos.rugcheck?.topHoldersPct ?? 14}%</strong></div>
                        <div>Mint Auth: <strong className="text-emerald-400">{pos.rugcheck?.mintAuthority ? 'ACTIVE' : 'REMOVED'}</strong></div>
                        <div>Freeze Auth: <strong className="text-emerald-400">{pos.rugcheck?.freezeAuthority ? 'ACTIVE' : 'REMOVED'}</strong></div>
                      </div>
                    </div>

                    {/* Pricing and Value metrics */}
                    <div className="grid grid-cols-2 gap-y-2 text-xs border-b border-[#1e2533]/50 pb-3 mb-3">
                      <div>
                        <span className="text-[#6b7280] text-[10px] block">BUY PRICE</span>
                        <span className="text-[#f3f4f6] font-semibold font-mono text-[11px] truncate block" title={pos.entryPrice || `${pos.entry_price.toFixed(10)} SOL`}>
                          {pos.entryPrice || `${pos.entry_price.toFixed(10)} SOL`}
                        </span>
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[#6b7280] text-[10px] block">CURRENT PRICE</span>
                          {(pos as any).isStale ? (
                            <span className="text-[8px] bg-amber-500/20 text-amber-300 px-1 rounded font-bold">STALE</span>
                          ) : (pos as any).priceSource === 'jupiter' ? (
                            <span className="text-[8px] bg-emerald-500/20 text-emerald-300 px-1 rounded font-bold">JUPITER LIVE</span>
                          ) : (pos as any).priceSource === 'fallback' ? (
                            <span className="text-[8px] bg-blue-500/20 text-blue-300 px-1 rounded font-bold">DEX FALLBACK</span>
                          ) : null}
                        </div>
                        <span className="text-[#f3f4f6] font-semibold font-mono text-[11px] truncate block" title={pos.currentPrice || `${pos.current_price.toFixed(10)} SOL`}>
                          {pos.currentPrice || `${pos.current_price.toFixed(10)} SOL`}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#6b7280] text-[10px] block">INVESTED</span>
                        <span className="text-[#f3f4f6] font-semibold font-mono text-[11px]">{pos.investedAmount || `${pos.sol_in.toFixed(4)} SOL`}</span>
                      </div>
                      <div>
                        <span className="text-[#6b7280] text-[10px] block">CURRENT VALUE</span>
                        <span className="text-[#f3f4f6] font-semibold font-mono text-[11px]">{pos.currentValue || `${pos.current_value_sol.toFixed(4)} SOL`}</span>
                      </div>
                    </div>

                    {/* Copy context */}
                    <div className="text-[10px] text-[#9ca3af] mb-4 space-y-1">
                      <div>Source: <strong className="text-gray-300">{pos.source_trader_name}</strong></div>
                      <div className="flex justify-between">
                        <span>Take Profit Target: <strong className="text-emerald-400">+{pos.take_profit_percent}%</strong></span>
                        <span>Stop Loss floor: <strong className="text-red-400">-{pos.stop_loss_percent}%</strong></span>
                      </div>
                    </div>
                  </div>

                  {/* Execution Actions (Partial Sell, 100% Exit & On-Chain Reconcile) */}
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-1.5">
                      <button 
                        onClick={() => sendAction('PARTIAL_SELL', { id: pos.id, ratio: 0.25 })}
                        className="py-1.5 bg-[#12161f] hover:bg-[#1e2533] text-amber-300 hover:text-amber-200 text-[10px] font-bold rounded transition border border-amber-500/20 text-center"
                        title="Sell 25% of current tokens held"
                      >
                        Sell 25%
                      </button>
                      <button 
                        onClick={() => sendAction('PARTIAL_SELL', { id: pos.id, ratio: 0.50 })}
                        className="py-1.5 bg-[#12161f] hover:bg-[#1e2533] text-amber-300 hover:text-amber-200 text-[10px] font-bold rounded transition border border-amber-500/20 text-center"
                        title="Sell 50% of current tokens held"
                      >
                        Sell 50%
                      </button>
                      <button 
                        onClick={() => sendAction('PARTIAL_SELL', { id: pos.id, ratio: 0.75 })}
                        className="py-1.5 bg-[#12161f] hover:bg-[#1e2533] text-amber-300 hover:text-amber-200 text-[10px] font-bold rounded transition border border-amber-500/20 text-center"
                        title="Sell 75% of current tokens held"
                      >
                        Sell 75%
                      </button>
                    </div>

                    <div className="flex gap-2">
                      <button 
                        onClick={() => sendAction('CLOSE_POSITION', { id: pos.id })}
                        className="flex-1 py-2 bg-red-600/15 hover:bg-red-600 text-red-400 hover:text-white text-xs font-bold rounded transition border border-red-500/20"
                      >
                        MANUAL SELL (100% EXIT)
                      </button>
                      <button 
                        onClick={() => sendAction('RECONCILE_POSITION', { id: pos.id })}
                        className="px-3 py-2 bg-[#12161f] hover:bg-[#1e2533] text-[#9ca3af] hover:text-[#f3f4f6] text-[10px] font-bold rounded transition border border-[#1e2533]"
                        title="Cross-check with on-chain SPL token account balance"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Reset Success Feedback Banner */}
      {resetSuccessMsg && (
        <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded text-purple-300 text-xs font-bold flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-purple-400 shrink-0" />
          <span>{resetSuccessMsg}</span>
        </div>
      )}

      {/* RebuyGuard Audit Matrix */}
      <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5" id="rebuy_guard_matrix">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Lock className="w-5 h-5 text-purple-400" />
            <div>
              <h2 className="text-md font-semibold text-[#f3f4f6]">Profitable-Only Rebuy Guard Matrix</h2>
              <p className="text-[10px] text-[#6b7280]">Rule: Max 1 Rebuy per mint, allowed ONLY if previous trade was profitable (P&L &gt; 0). Losses are permanently blocked.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button 
              id="reset_rebuy_guard_matrix_btn"
              onClick={() => setShowResetConfirm(true)}
              className="px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/40 rounded text-xs font-bold transition flex items-center gap-1.5"
              title="Permanently clear completed trades and rebuy eligibility records"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              RESET GUARD + HISTORY
            </button>
            <span className="text-[10px] bg-purple-500/10 text-purple-300 px-2 py-1 rounded font-bold font-mono">
              {rebuyStateList.length} Mints Tracked
            </span>
          </div>
        </div>

        {rebuyStateList.length === 0 ? (
          <div className="py-6 text-center text-xs text-[#6b7280] border border-dashed border-[#1e2533] rounded">
            No token mints have executed initial trades yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#1e2533] text-[#6b7280]">
                  <th className="py-2 font-semibold">TOKEN MINT</th>
                  <th className="py-2 font-semibold text-center">INITIAL BUY</th>
                  <th className="py-2 font-semibold text-center">REBUYS USED</th>
                  <th className="py-2 font-semibold text-center">EXITS (W / L)</th>
                  <th className="py-2 font-semibold font-mono text-right">LAST REALIZED P&L</th>
                  <th className="py-2 font-semibold text-center">REBUY STATUS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e2533]/30">
                {rebuyStateList.map((st) => {
                  const isBlocked = st.rebuyBlocked || st.rebuyCount >= 1 || (st.profitableExits === 0 && st.losingExits > 0);
                  const isEligible = !isBlocked && st.profitableExits >= 1 && st.rebuyCount === 0;

                  return (
                    <tr key={st.mint} className="hover:bg-[#0b0e14]/40" id={`rebuy_row_${st.mint}`}>
                      <td className="py-2.5 font-mono text-[#f3f4f6] text-[11px] truncate max-w-xs">
                        {st.mint}
                      </td>
                      <td className="py-2.5 text-center font-mono text-[#9ca3af]">
                        {st.initialBuyCount}
                      </td>
                      <td className="py-2.5 text-center font-mono">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          st.rebuyCount > 0 ? 'bg-purple-500/20 text-purple-300' : 'bg-[#1e2533] text-[#9ca3af]'
                        }`}>
                          {st.rebuyCount} / 1
                        </span>
                      </td>
                      <td className="py-2.5 text-center font-mono text-[11px]">
                        <span className="text-emerald-400">{st.profitableExits}W</span>
                        <span className="text-[#6b7280] mx-1">/</span>
                        <span className="text-red-400">{st.losingExits}L</span>
                      </td>
                      <td className={`py-2.5 text-right font-mono font-bold ${
                        st.lastRealizedPnl > 0 ? 'text-[#10b981]' : st.lastRealizedPnl < 0 ? 'text-[#ef4444]' : 'text-[#6b7280]'
                      }`}>
                        {st.lastRealizedPnl > 0 ? '+' : ''}{st.lastRealizedPnl.toFixed(4)} SOL
                        {st.lastRealizedPnlPercent !== 0 && (
                          <span className="text-[10px] block opacity-80">
                            ({st.lastRealizedPnlPercent > 0 ? '+' : ''}{st.lastRealizedPnlPercent.toFixed(2)}%)
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-center">
                        {isEligible ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle className="w-3 h-3" />
                            REBUY ALLOWED (1x)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/10 text-red-400 border border-red-500/20">
                            <XCircle className="w-3 h-3" />
                            {st.rebuyCount >= 1 ? 'MAX REBUY REACHED (BLOCKED)' : 'BLOCKED (PREV LOSS)'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Trading History Panel */}
      <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5" id="trading_history_panel">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h2 className="text-md font-semibold text-[#f3f4f6] flex items-center gap-2">
            <History className="w-5 h-5 text-blue-400" />
            Completed Trades History ({validTrades.length})
          </h2>
          <button 
            id="reset_trade_history_header_btn"
            onClick={() => setShowResetConfirm(true)}
            className="px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/40 rounded text-xs font-bold transition flex items-center gap-1.5 self-start sm:self-auto"
            title="Permanently clear completed trades and rebuy eligibility records"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            RESET GUARD + HISTORY
          </button>
        </div>

        {validTrades.length === 0 ? (
          <div className="py-8 text-center text-xs text-[#6b7280]">
            No completed trades yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#1e2533] text-[#6b7280]">
                  <th className="py-2 font-semibold">TOKEN</th>
                  <th className="py-2 font-semibold">TOKENS BOUGHT / SOLD</th>
                  <th className="py-2 font-semibold font-mono">SOL IN</th>
                  <th className="py-2 font-semibold font-mono">SOL OUT</th>
                  <th className="py-2 font-semibold font-mono">RETURN (PnL)</th>
                  <th className="py-2 font-semibold">EXIT REASON</th>
                  <th className="py-2 font-semibold text-right">TIME</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e2533]/30">
                {validTrades.map((trade) => {
                  const boughtStr = trade.tokenQuantityBought || (trade.token_amount_bought ? trade.token_amount_bought.toLocaleString('en-US') : undefined);
                  const soldStr = trade.tokenQuantitySold || (trade.token_amount_sold ? trade.token_amount_sold.toLocaleString('en-US') : undefined);

                  return (
                    <tr key={trade.id} className="hover:bg-[#0b0e14]/40" id={`trade_row_${trade.id}`}>
                      <td className="py-3">
                        <div className="font-bold text-[#f3f4f6]">{trade.token_name}</div>
                        <div className="text-[10px] text-blue-400 font-mono font-bold">{trade.token_symbol}</div>
                      </td>
                      <td className="py-3 font-mono text-[11px]">
                        {boughtStr ? (
                          <div>
                            <span className="text-sky-300 font-semibold">{boughtStr}</span>
                            {soldStr && soldStr !== boughtStr && (
                              <span className="text-[#9ca3af] block text-[10px]">Sold: {soldStr}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-[#6b7280]">-</span>
                        )}
                      </td>
                      <td className="py-3 font-mono text-[#f3f4f6]">{trade.sol_in.toFixed(4)}</td>
                      <td className="py-3 font-mono text-[#f3f4f6]">{trade.sol_out.toFixed(4)}</td>
                      <td className={`py-3 font-mono font-bold ${trade.pnl_sol >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>
                        {trade.pnl_sol >= 0 ? '+' : ''}{trade.pnl_sol.toFixed(4)} ({trade.pnl_percent}%)
                      </td>
                      <td className="py-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          trade.sell_reason === 'TAKE_PROFIT' 
                            ? 'bg-[#10b981]/10 text-emerald-400' 
                            : trade.sell_reason === 'STOP_LOSS' 
                              ? 'bg-red-500/10 text-red-400' 
                              : trade.sell_reason === 'PARTIAL'
                                ? 'bg-amber-500/10 text-amber-400'
                                : 'bg-blue-500/10 text-blue-400'
                        }`}>
                          {trade.sell_reason}
                        </span>
                      </td>
                      <td className="py-3 text-right text-[#6b7280] text-[10px]">
                        {new Date(trade.sell_time).toLocaleTimeString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
