import React, { useState } from 'react';
import { 
  Server, 
  Key, 
  ShieldAlert, 
  Globe, 
  Layers, 
  Cpu, 
  Save, 
  AlertCircle,
  CheckCircle2,
  HelpCircle
} from 'lucide-react';
import { ServerState, Settings, ConnectionStatus } from '../types';

interface SettingsPageProps {
  state: ServerState;
  sendAction: (type: string, data: any) => void;
}

export default function SettingsPage({ state, sendAction }: SettingsPageProps) {
  const { settings, connection } = state;

  const [rpcUrl, setRpcUrl] = useState(settings.rpc_url);
  const [backupRpcUrl, setBackupRpcUrl] = useState(settings.backup_rpc_url);
  const [wssUrl, setWssUrl] = useState(settings.wss_url);
  const [backupWssUrl, setBackupWssUrl] = useState(settings.backup_wss_url);
  const [laserKey, setLaserKey] = useState(settings.laserstream_key);

  // RugCheck security settings state
  const [enableRugCheck, setEnableRugCheck] = useState(settings.enableRugCheck ?? true);
  const [maxHolderConcentration, setMaxHolderConcentration] = useState(settings.maxHolderConcentration ?? 20);
  const [requireLpLocked, setRequireLpLocked] = useState(settings.requireLpLocked ?? true);
  const [requireMintAuthorityRemoved, setRequireMintAuthorityRemoved] = useState(settings.requireMintAuthorityRemoved ?? true);
  const [requireFreezeAuthorityRemoved, setRequireFreezeAuthorityRemoved] = useState(settings.requireFreezeAuthorityRemoved ?? true);
  const [maxRiskScore, setMaxRiskScore] = useState(settings.maxRiskScore ?? 300);
  
  const [successMsg, setSuccessMsg] = useState('');

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMsg('');

    sendAction('UPDATE_SETTINGS', {
      rpc_url: rpcUrl,
      backup_rpc_url: backupRpcUrl,
      wss_url: wssUrl,
      backup_wss_url: backupWssUrl,
      laserstream_key: laserKey,
      enableRugCheck,
      requiredRugStatus: ['Good'],
      maxHolderConcentration: Number(maxHolderConcentration),
      requireLpLocked,
      requireMintAuthorityRemoved,
      requireFreezeAuthorityRemoved,
      maxRiskScore: Number(maxRiskScore)
    });

    setSuccessMsg('System and RugCheck security configuration persisted successfully!');
    setTimeout(() => setSuccessMsg(''), 4000);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'CONNECTED':
        return <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-[10px] font-bold">CONNECTED</span>;
      case 'CONNECTING':
        return <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded text-[10px] font-bold animate-pulse">CONNECTING</span>;
      case 'DISCONNECTED':
        return <span className="bg-gray-500/10 text-gray-400 border border-gray-500/20 px-2 py-0.5 rounded text-[10px] font-bold">DISCONNECTED</span>;
      case 'NOT_CONFIGURED':
        return <span className="bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded text-[10px] font-bold">NOT CONFIGURED</span>;
      case 'INVALID_API_KEY':
        return <span className="bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded text-[10px] font-bold">INVALID API KEY</span>;
      case 'ERROR':
      case 'CONNECTION_ERROR':
      default:
        return <span className="bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded text-[10px] font-bold">CONNECTION ERROR</span>;
    }
  };

  return (
    <div className="space-y-6" id="settings_container">
      
      {/* Network Status Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-[#12161f] border border-[#1e2533] p-4 rounded-lg">
        <div className="p-3 bg-[#0b0e14] border border-[#1e2533] rounded flex justify-between items-center">
          <div>
            <span className="text-[10px] text-[#6b7280] block font-bold uppercase tracking-wider">Solana RPC</span>
            <span className="text-xs text-[#f3f4f6] font-medium font-mono truncate max-w-[130px] block" title={settings.rpc_url}>
              {settings.rpc_url ? new URL(settings.rpc_url).hostname : 'None'}
            </span>
          </div>
          {getStatusBadge(connection.rpc)}
        </div>

        <div className="p-3 bg-[#0b0e14] border border-[#1e2533] rounded flex justify-between items-center">
          <div>
            <span className="text-[10px] text-[#6b7280] block font-bold uppercase tracking-wider">Solana WSS</span>
            <span className="text-xs text-[#f3f4f6] font-medium font-mono truncate max-w-[130px] block" title={settings.wss_url}>
              {settings.wss_url ? new URL(settings.wss_url).hostname : 'None'}
            </span>
          </div>
          {getStatusBadge(connection.wss)}
        </div>

        <div className="p-3 bg-[#0b0e14] border border-[#1e2533] rounded flex justify-between items-center">
          <div>
            <span className="text-[10px] text-[#6b7280] block font-bold uppercase tracking-wider">LaserStream</span>
            <span className="text-xs text-[#f3f4f6] font-medium font-mono truncate max-w-[130px] block">
              {settings.laserstream_key ? 'LaserStream API' : 'Not Connected'}
            </span>
          </div>
          {getStatusBadge(connection.laserstream)}
        </div>

        <div className="p-3 bg-[#0b0e14] border border-[#1e2533] rounded flex justify-between items-center">
          <div>
            <span className="text-[10px] text-[#6b7280] block font-bold uppercase tracking-wider">Jupiter Price API</span>
            <span className="text-xs text-[#f3f4f6] font-medium font-mono truncate max-w-[130px] block">
              {connection.jupiter === 'CONNECTED' ? 'Jupiter Sync Active' : 'Server API key required'}
            </span>
          </div>
          {getStatusBadge(connection.jupiter)}
        </div>
      </div>

      {/* Main Settings Form */}
      <form onSubmit={handleSaveSettings} className="space-y-6" id="settings_form">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Solana Credentials Panel */}
          <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-[#1e2533] pb-3 mb-2">
              <Server className="text-blue-400 w-5 h-5" />
              <h2 className="text-md font-semibold text-[#f3f4f6]">Solana Cluster RPC / WSS Connection</h2>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#9ca3af] mb-1">Primary RPC Endpoint</label>
              <input 
                type="text" 
                value={rpcUrl}
                onChange={(e) => setRpcUrl(e.target.value)}
                placeholder="https://api.mainnet-beta.solana.com"
                className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-3 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#9ca3af] mb-1">Backup RPC Endpoint</label>
              <input 
                type="text" 
                value={backupRpcUrl}
                onChange={(e) => setBackupRpcUrl(e.target.value)}
                placeholder="https://solana-mainnet.g.allthatnode.com/..."
                className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-3 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#9ca3af] mb-1">Primary WSS Websocket Endpoint</label>
              <input 
                type="text" 
                value={wssUrl}
                onChange={(e) => setWssUrl(e.target.value)}
                placeholder="wss://api.mainnet-beta.solana.com"
                className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-3 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#9ca3af] mb-1">Backup WSS Websocket Endpoint</label>
              <input 
                type="text" 
                value={backupWssUrl}
                onChange={(e) => setBackupWssUrl(e.target.value)}
                placeholder="wss://other-wss.solana.com"
                className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-3 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>
          </div>

          {/* Third-Party Services Panel */}
          <div className="bg-[#12161f] border border-[#1e2533] rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-[#1e2533] pb-3 mb-2">
              <Key className="text-amber-400 w-5 h-5" />
              <h2 className="text-md font-semibold text-[#f3f4f6]">Trading Integrations & API Keys</h2>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-[#9ca3af]">LaserStream Secret Key</label>
                <span className="text-[9px] bg-[#3b82f6]/10 text-blue-400 px-1.5 py-0.5 rounded font-bold">Fast Feed</span>
              </div>
              <input 
                type="password" 
                value={laserKey}
                onChange={(e) => setLaserKey(e.target.value)}
                placeholder="Enter LaserStream token"
                className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-3 py-2 text-xs text-[#f3f4f6] focus:outline-none focus:border-blue-500 font-mono"
              />
              <p className="text-[10px] text-[#6b7280] mt-1">
                Enables ultra low-latency Solana transaction events subscription feed on Render containers 24/7.
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-[#9ca3af]">Jupiter API Key</label>
                <span className="text-[9px] bg-[#10b981]/10 text-emerald-400 px-1.5 py-0.5 rounded font-bold">Swap Engine</span>
              </div>
              <div className="w-full bg-[#0b0e14] border border-[#1e2533] rounded px-3 py-2 text-xs text-emerald-300 font-mono">
                Managed securely by Render: JUPITER_API_KEY
              </div>
              <p className="text-[10px] text-[#6b7280] mt-1">
                The Jupiter API key is server-side only. Configure it in Render Environment Variables; it is never stored in the browser or database.
              </p>
            </div>

            <div className="bg-[#ef4444]/5 border border-[#ef4444]/10 rounded p-3 flex items-start gap-2.5">
              <ShieldAlert className="w-4 h-4 text-[#ef4444] shrink-0 mt-0.5" />
              <div className="text-[10px] text-[#9ca3af] leading-relaxed">
                <strong className="text-[#f3f4f6] font-semibold">Security Vault:</strong> All sensitive credentials and API secrets are stored locally inside the container's encrypted persistent ledger. No key telemetry is transmitted to external analytic dashboards.
              </div>
            </div>
          </div>

        </div>

        {/* RugCheck Security Filter Panel */}
        <div className="bg-[#12161f] border border-blue-500/30 rounded-lg p-5 space-y-4" id="rugcheck_settings_card">
          <div className="flex items-center justify-between border-b border-[#1e2533] pb-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="text-blue-400 w-5 h-5" />
              <div>
                <h2 className="text-md font-semibold text-[#f3f4f6]">RugCheck On-Chain Security Filter</h2>
                <p className="text-[11px] text-[#9ca3af]">Automated verification against honeypots, active authorities, unlocked liquidity, and insider holdings.</p>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                checked={enableRugCheck} 
                onChange={(e) => setEnableRugCheck(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-[#1e2533] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              <span className="ml-2 text-xs font-bold text-[#f3f4f6]">{enableRugCheck ? 'FILTER ACTIVE' : 'DISABLED'}</span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
            {/* Max Holder Concentration */}
            <div className="bg-[#0b0e14] border border-[#1e2533] p-3 rounded">
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-medium text-[#9ca3af]">Max Top Holder Concentration</label>
                <span className="text-xs font-mono font-bold text-blue-400">{maxHolderConcentration}%</span>
              </div>
              <input 
                type="range"
                min="5"
                max="50"
                step="1"
                value={maxHolderConcentration}
                onChange={(e) => setMaxHolderConcentration(Number(e.target.value))}
                className="w-full accent-blue-500 cursor-pointer"
              />
              <span className="text-[10px] text-[#6b7280] block mt-1">Rejects tokens if top 5 non-pool holders exceed this limit.</span>
            </div>

            {/* Max Risk Score */}
            <div className="bg-[#0b0e14] border border-[#1e2533] p-3 rounded">
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-medium text-[#9ca3af]">Max Allowed Risk Score</label>
                <span className="text-xs font-mono font-bold text-blue-400">{maxRiskScore}</span>
              </div>
              <input 
                type="range"
                min="50"
                max="1000"
                step="50"
                value={maxRiskScore}
                onChange={(e) => setMaxRiskScore(Number(e.target.value))}
                className="w-full accent-blue-500 cursor-pointer"
              />
              <span className="text-[10px] text-[#6b7280] block mt-1">Lower score is safer (Good &lt; 300).</span>
            </div>

            {/* Required Status */}
            <div className="bg-[#0b0e14] border border-[#1e2533] p-3 rounded flex flex-col justify-center">
              <span className="text-xs font-medium text-[#9ca3af] block mb-1">Mandatory Risk Level</span>
              <div className="flex items-center gap-2">
                <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-bold px-2.5 py-1 rounded">
                  GOOD ONLY
                </span>
                <span className="text-[10px] text-[#6b7280]">Tokens marked Warn/Danger are rejected.</span>
              </div>
            </div>
          </div>

          {/* Toggle Checklist */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
            <label className="flex items-center gap-2 p-2.5 bg-[#0b0e14] border border-[#1e2533] rounded cursor-pointer hover:border-[#2d3748] transition">
              <input 
                type="checkbox"
                checked={requireLpLocked}
                onChange={(e) => setRequireLpLocked(e.target.checked)}
                className="rounded text-blue-600 focus:ring-0 bg-[#12161f] border-[#1e2533]"
              />
              <div>
                <span className="text-xs font-semibold text-[#f3f4f6] block">Require LP Locked / Burned</span>
                <span className="text-[10px] text-[#6b7280]">Rejects unlocked pools</span>
              </div>
            </label>

            <label className="flex items-center gap-2 p-2.5 bg-[#0b0e14] border border-[#1e2533] rounded cursor-pointer hover:border-[#2d3748] transition">
              <input 
                type="checkbox"
                checked={requireMintAuthorityRemoved}
                onChange={(e) => setRequireMintAuthorityRemoved(e.target.checked)}
                className="rounded text-blue-600 focus:ring-0 bg-[#12161f] border-[#1e2533]"
              />
              <div>
                <span className="text-xs font-semibold text-[#f3f4f6] block">Require Mint Authority Revoked</span>
                <span className="text-[10px] text-[#6b7280]">Must be null</span>
              </div>
            </label>

            <label className="flex items-center gap-2 p-2.5 bg-[#0b0e14] border border-[#1e2533] rounded cursor-pointer hover:border-[#2d3748] transition">
              <input 
                type="checkbox"
                checked={requireFreezeAuthorityRemoved}
                onChange={(e) => setRequireFreezeAuthorityRemoved(e.target.checked)}
                className="rounded text-blue-600 focus:ring-0 bg-[#12161f] border-[#1e2533]"
              />
              <div>
                <span className="text-xs font-semibold text-[#f3f4f6] block">Require Freeze Authority Revoked</span>
                <span className="text-[10px] text-[#6b7280]">Must be null</span>
              </div>
            </label>
          </div>
        </div>

        {/* Form CTA Actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {successMsg && (
              <div className="text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 py-1.5 px-3 rounded flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                <span>{successMsg}</span>
              </div>
            )}
          </div>

          <button 
            type="submit"
            className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-2.5 px-6 rounded transition flex items-center gap-1.5"
          >
            <Save className="w-4 h-4" />
            SAVE CONFIGURATION
          </button>
        </div>
      </form>

    </div>
  );
}
