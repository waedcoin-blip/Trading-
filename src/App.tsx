import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Settings as SettingsIcon, 
  TrendingUp, 
  Eye, 
  HelpCircle, 
  AlertCircle,
  Cpu,
  Terminal,
  Zap,
  LayoutDashboard,
  Brain
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ServerState, Settings, ConnectionStatus, AIStats } from './types';
import WatchlistPage from './components/WatchlistPage';
import TradingPage from './components/TradingPage';
import SettingsPage from './components/SettingsPage';
import AILearningPage from './components/AILearningPage';
import { UserAuthButton } from './components/UserAuthButton.tsx';

export default function App() {
  const [activeTab, setActiveTab] = useState<'watchlist' | 'trading' | 'ai-learning' | 'settings'>('watchlist');
  const [state, setState] = useState<ServerState | null>(null);
  const [backendOnline, setBackendOnline] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsError, setWsError] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectDelayRef = useRef(1000);

  // Fetch state via standard HTTP API
  const fetchStateHTTP = async () => {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        setBackendOnline(true);
        const data = await res.json();
        setState(prevState => {
          if (!prevState) return data;
          // Merge positions to ensure high-frequency WS updates take precedence
          const mergedPositions = data.positions.map((fetchedPos: any) => {
            const currentPos = prevState.positions.find(p => p.id === fetchedPos.id);
            if (currentPos && currentPos.priceUpdatedAt && fetchedPos.priceUpdatedAt && currentPos.priceUpdatedAt > fetchedPos.priceUpdatedAt) {
              return {
                ...fetchedPos,
                current_price: currentPos.current_price,
                currentPrice: currentPos.currentPrice,
                current_value_sol: currentPos.current_value_sol,
                currentValue: currentPos.currentValue,
                unrealized_pnl_sol: currentPos.unrealized_pnl_sol,
                unrealizedPnl: currentPos.unrealizedPnl,
                unrealized_pnl_percent: currentPos.unrealized_pnl_percent,
                unrealizedPnlPercent: currentPos.unrealizedPnlPercent,
                priceUpdatedAt: currentPos.priceUpdatedAt,
                priceSource: (currentPos as any).priceSource,
                isStale: (currentPos as any).isStale
              };
            }
            return fetchedPos;
          });
          return {
            ...data,
            positions: mergedPositions
          };
        });
      } else {
        setBackendOnline(false);
      }
    } catch (err) {
      setBackendOnline(false);
      console.warn('[HTTP] State sync pending server readiness...');
    }
  };

  // Initialize and maintain WebSocket connection
  const connectWS = () => {
    if (wsRef.current) return;

    // Use absolute URL protocol mapping
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    console.log(`[WS] Connecting to ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connection established');
      setWsConnected(true);
      setWsError(false);
      reconnectDelayRef.current = 1000; // Reset delay
      fetchStateHTTP(); // Sync latest
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'STATE_UPDATE') {
          const incomingData = payload.data;
          if (incomingData) {
            setState(prevState => {
              if (!prevState || !prevState.positions) return incomingData;
              const mergedPositions = (incomingData.positions || []).map((fetchedPos: any) => {
                const currentPos = prevState.positions.find(p => p.id === fetchedPos.id);
                if (
                  currentPos &&
                  currentPos.priceUpdatedAt &&
                  (!fetchedPos.priceUpdatedAt || currentPos.priceUpdatedAt > fetchedPos.priceUpdatedAt)
                ) {
                  return {
                    ...fetchedPos,
                    current_price: currentPos.current_price,
                    currentPrice: currentPos.currentPrice,
                    current_value_sol: currentPos.current_value_sol,
                    currentValue: currentPos.currentValue,
                    unrealized_pnl_sol: currentPos.unrealized_pnl_sol,
                    unrealizedPnl: currentPos.unrealizedPnl,
                    unrealized_pnl_percent: currentPos.unrealized_pnl_percent,
                    unrealizedPnlPercent: currentPos.unrealizedPnlPercent,
                    priceUpdatedAt: currentPos.priceUpdatedAt,
                    priceSource: (currentPos as any).priceSource,
                    isStale: (currentPos as any).isStale,
                    peak_pnl_percent: currentPos.peak_pnl_percent,
                    peak_price: currentPos.peak_price,
                    trailing_stop_armed: currentPos.trailing_stop_armed
                  };
                }
                return fetchedPos;
              });
              return {
                ...incomingData,
                positions: mergedPositions
              };
            });
          }
        } else if (payload.type === 'TOKEN_DISCOVERY_REFRESHED') {
          const discoveryData = payload.data;
          setState(prevState => {
            if (!prevState) return prevState;
            return {
              ...prevState,
              observations: discoveryData.tokens || [],
              discoveryFeed: discoveryData
            };
          });
        } else if (payload.type === 'POSITION_PNL_UPDATE') {
          const { positionId, mint, pnlSol, pnlPercent, currentValueSol, currentPriceSol, currentPriceUsd, solUsdRate, priceUpdatedAt, priceSource, isStale } = payload.data;
          
          setState(prevState => {
            if (!prevState) return prevState;
            const updatedPositions = prevState.positions.map(p => {
              if (p.id === positionId || p.token_mint === mint) {
                const currentPriceUsdFormatted = `$${currentPriceUsd < 0.01 ? currentPriceUsd.toFixed(8) : currentPriceUsd.toFixed(4)}`;
                const currentValueUsdFormatted = solUsdRate > 0 ? `$${(currentValueSol * solUsdRate).toFixed(2)}` : '$0.00';
                return {
                  ...p,
                  current_price: currentPriceSol,
                  currentPrice: `${currentPriceSol.toFixed(10)} SOL (${currentPriceUsdFormatted})`,
                  current_value_sol: currentValueSol,
                  currentValue: `${currentValueSol.toFixed(4)} SOL (${currentValueUsdFormatted})`,
                  unrealized_pnl_sol: pnlSol,
                  unrealizedPnl: `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`,
                  unrealized_pnl_percent: pnlPercent,
                  unrealizedPnlPercent: `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
                  priceUpdatedAt,
                  priceSource,
                  isStale
                };
              }
              return p;
            });
            return {
              ...prevState,
              positions: updatedPositions
            };
          });
        }
      } catch (err) {
        console.error('[WS] Error parsing state message:', err);
      }
    };

    ws.onerror = (err) => {
      console.log('[WS] Connection status check: offline. Handled gracefully.');
      setWsError(true);
    };

    ws.onclose = () => {
      console.log('[WS] Connection closed, rescheduling reconnect...');
      setWsConnected(false);
      wsRef.current = null;
      
      // Exponential backoff reconnect
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(30000, reconnectDelayRef.current * 1.5);
        connectWS();
      }, reconnectDelayRef.current);
    };
  };

  useEffect(() => {
    // 1. Initial HTTP Fetch so the app displays working UI instantly
    fetchStateHTTP();

    // 2. Start WebSocket
    connectWS();

    // 3. Robust Background HTTP Polling fallback when WS is offline
    const pollInterval = setInterval(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        fetchStateHTTP();
      }
    }, 2000);

    return () => {
      clearInterval(pollInterval);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on unmount
        wsRef.current.close();
      }
    };
  }, []);

  // Send action utility with automatic HTTP fallback
  const sendAction = async (type: string, data: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, data }));
    } else {
      console.log('[WS] Offline. Executing action via HTTP fallback POST...', type);
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, data })
        });
        if (res.ok) {
          fetchStateHTTP(); // Refresh client state immediately
        }
      } catch (err) {
        console.error('[HTTP Action] Fallback execution failed:', err);
      }
    }
  };

  if (!state) {
    return (
      <div className="min-h-screen bg-[#07090e] text-[#d1d5db] flex flex-col items-center justify-center font-sans">
        <div className="flex flex-col items-center gap-4 text-center">
          <Cpu className="w-12 h-12 text-blue-500 animate-pulse" />
          <div>
            <h1 className="text-lg font-bold text-white">Ultra Trading Bot</h1>
            <p className="text-xs text-[#6b7280]">Initializing continuous real-time pipeline connection...</p>
          </div>
          {wsError && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-3 py-1.5 rounded flex items-center gap-1.5 mt-2">
              <AlertCircle className="w-4 h-4" />
              <span>Dev Server Connection Lost. Attempting Automatic Reconnect...</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const { settings, connection } = state;

  return (
    <div className="min-h-screen bg-[#07090e] text-[#d1d5db] flex flex-col font-sans selection:bg-[#3b82f6]/30 selection:text-white">
      
      {/* Upper Global Navigation Header */}
      <header className="border-b border-[#1e2533] bg-[#0c0f16] px-4 md:px-6 py-3.5 flex flex-col md:flex-row items-center justify-between gap-4 sticky top-0 z-40">
        
        {/* Logo & Platform Info */}
        <div className="flex items-center gap-2.5">
          <Terminal className="text-[#3b82f6] w-6 h-6 shrink-0" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-extrabold text-sm md:text-md text-white tracking-wide">ULTRA TRADING BOT</h1>
              
              {/* Backend Status */}
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-extrabold ${
                backendOnline 
                  ? 'bg-emerald-500/10 text-[#34d399] border border-emerald-500/20' 
                  : 'bg-red-500/10 text-[#f87171] border border-red-500/20 animate-pulse'
              }`} title="Backend Express API Server Status">
                <span className={`w-1 h-1 rounded-full ${backendOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
                {backendOnline ? 'BACKEND: ONLINE' : 'BACKEND: OFFLINE'}
              </span>

              {/* Jupiter V3 Status */}
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-extrabold ${
                connection.jupiter === 'CONNECTED' 
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                  : connection.jupiter === 'NOT_CONFIGURED'
                  ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                  : 'bg-red-500/10 text-red-400 border border-red-500/20'
              }`} title="Jupiter Price API V3 Connection Status">
                <span className={`w-1 h-1 rounded-full ${connection.jupiter === 'CONNECTED' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                JUPITER V3: {connection.jupiter}
              </span>

              {/* Realtime WS Stream Status */}
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-extrabold ${
                wsConnected 
                  ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' 
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              }`} title="Real-time WebSocket Push Stream Status">
                <span className={`w-1 h-1 rounded-full ${wsConnected ? 'bg-blue-500' : 'bg-amber-500'}`} />
                {wsConnected ? 'STREAM: LIVE' : 'STREAM: POLLING'}
              </span>
            </div>
            <p className="text-[10px] text-[#6b7280]">Production-grade Solana trader-wallet copy terminal</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex bg-[#12161f] border border-[#1e2533] p-1 rounded-md max-w-full">
          <button 
            onClick={() => setActiveTab('watchlist')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-bold transition relative ${
              activeTab === 'watchlist' ? 'text-white' : 'text-[#6b7280] hover:text-[#d1d5db]'
            }`}
          >
            {activeTab === 'watchlist' && (
              <motion.div 
                layoutId="activeTabIndicator"
                className="absolute inset-0 bg-[#3b82f6]/10 border-b-2 border-blue-500 rounded-sm"
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
            <Eye className="w-3.5 h-3.5" />
            WATCHLIST
          </button>

          <button 
            onClick={() => setActiveTab('trading')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-bold transition relative ${
              activeTab === 'trading' ? 'text-white' : 'text-[#6b7280] hover:text-[#d1d5db]'
            }`}
          >
            {activeTab === 'trading' && (
              <motion.div 
                layoutId="activeTabIndicator"
                className="absolute inset-0 bg-[#3b82f6]/10 border-b-2 border-blue-500 rounded-sm"
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
            <TrendingUp className="w-3.5 h-3.5" />
            TRADING
          </button>

          <button 
            onClick={() => setActiveTab('ai-learning')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-bold transition relative ${
              activeTab === 'ai-learning' ? 'text-white' : 'text-[#6b7280] hover:text-[#d1d5db]'
            }`}
          >
            {activeTab === 'ai-learning' && (
              <motion.div 
                layoutId="activeTabIndicator"
                className="absolute inset-0 bg-[#3b82f6]/10 border-b-2 border-blue-500 rounded-sm"
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
            <Brain className="w-3.5 h-3.5 text-blue-400" />
            AI LEARNING
          </button>

          <button 
            onClick={() => setActiveTab('settings')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-bold transition relative ${
              activeTab === 'settings' ? 'text-white' : 'text-[#6b7280] hover:text-[#d1d5db]'
            }`}
          >
            {activeTab === 'settings' && (
              <motion.div 
                layoutId="activeTabIndicator"
                className="absolute inset-0 bg-[#3b82f6]/10 border-b-2 border-blue-500 rounded-sm"
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
            <SettingsIcon className="w-3.5 h-3.5" />
            SETTINGS
          </button>
        </nav>

        {/* Global Connection Signals & Auth */}
        <div className="flex items-center gap-3 md:gap-4">
          <div className="hidden lg:flex items-center gap-4 text-[10px]">
            <div className="flex items-center gap-1.5">
              <span className="text-[#6b7280]">RPC:</span>
              <span className={`font-bold ${connection.rpc === 'CONNECTED' ? 'text-emerald-400' : 'text-red-400'}`}>
                {connection.rpc}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[#6b7280]">WSS:</span>
              <span className={`font-bold ${connection.wss === 'CONNECTED' ? 'text-emerald-400' : 'text-red-400'}`}>
                {connection.wss}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[#6b7280]">MODE:</span>
              <span className={`font-bold uppercase ${settings.trading_mode === 'PAPER' ? 'text-emerald-400' : 'text-red-400'}`}>
                {settings.trading_mode}
              </span>
            </div>
          </div>
          <UserAuthButton />
        </div>

      </header>

      {/* Main Terminal Stage */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className="h-full"
          >
            {activeTab === 'watchlist' && (
              <WatchlistPage state={state} sendAction={sendAction} />
            )}
            {activeTab === 'trading' && (
              <TradingPage state={state} sendAction={sendAction} />
            )}
            {activeTab === 'ai-learning' && (
              <AILearningPage state={state} sendAction={sendAction} />
            )}
            {activeTab === 'settings' && (
              <SettingsPage state={state} sendAction={sendAction} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Compact Status Ticker Footer */}
      <footer className="border-t border-[#1e2533] bg-[#0c0f16] px-4 py-2 text-[10px] text-[#6b7280] flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#10b981] animate-pulse"></span>
          <span>Core stream pipeline: operational (24/7 background mode persistent on Render)</span>
        </div>
        <div>
          <span>Solana Engine v1.0.0</span>
        </div>
      </footer>

    </div>
  );
}
