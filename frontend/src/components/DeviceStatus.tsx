import React, { useState } from 'react';
import { wifiTunnelDiscover } from '../services/api';

interface Device {
  id: string;
  name: string;
  iosVersion: string;
  connectionType?: string;
}

interface TunnelStatus {
  running: boolean;
  rsd_address?: string;
  rsd_port?: number;
}

interface DeviceStatusProps {
  device: Device | null;
  devices: Device[];
  isConnected: boolean;
  onScan: () => void;
  onSelect: (id: string) => void;
  onStartWifiTunnel?: (ip: string, port?: number) => Promise<any>;
  onStopTunnel?: () => Promise<void>;
  tunnelStatus?: TunnelStatus;
  onWifiConnect?: (ip: string) => Promise<any>;
}

const DeviceStatus: React.FC<DeviceStatusProps> = ({
  device,
  devices,
  isConnected,
  onScan,
  onSelect,
  onStartWifiTunnel,
  onStopTunnel,
  tunnelStatus = { running: false },
  onWifiConnect,
}) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [tunnelIp, setTunnelIp] = useState(() => localStorage.getItem('locwarp.tunnel.ip') || '192.168.0.205');
  const [tunnelPort, setTunnelPort] = useState(() => localStorage.getItem('locwarp.tunnel.port') || '49152');
  const [tunnelConnecting, setTunnelConnecting] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [showIpHelp, setShowIpHelp] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [wifiExpanded, setWifiExpanded] = useState(false);
  const [wifiTab, setWifiTab] = useState<'ios17plus' | 'ios17minus'>('ios17plus');
  const [legacyIp, setLegacyIp] = useState('');
  const [legacyConnecting, setLegacyConnecting] = useState(false);
  const [legacyError, setLegacyError] = useState<string | null>(null);

  const handleLegacyConnect = async () => {
    if (!onWifiConnect || !legacyIp.trim()) return;
    setLegacyConnecting(true);
    setLegacyError(null);
    try {
      await onWifiConnect(legacyIp.trim());
    } catch (err: any) {
      setLegacyError(err.message || '連線失敗');
    } finally {
      setLegacyConnecting(false);
    }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setTunnelError(null);
    try {
      const res = await wifiTunnelDiscover();
      const first = res?.devices?.[0];
      if (first) {
        setTunnelIp(first.ip);
        setTunnelPort(String(first.port));
      } else {
        setTunnelError('未偵測到裝置,請確認 iPhone 與電腦在同一 WiFi');
      }
    } catch (err: any) {
      setTunnelError(err.message || '偵測失敗');
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <div className={`device-status ${isConnected ? 'device-connected' : 'device-disconnected'}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {/* Status indicator dot */}
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: isConnected ? '#4caf50' : '#f44336',
            flexShrink: 0,
            boxShadow: isConnected ? '0 0 6px #4caf50' : '0 0 6px #f44336',
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {device ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {device.name}
              </div>
              <div style={{ fontSize: 11, opacity: 0.6, display: 'flex', alignItems: 'center', gap: 4 }}>
                iOS {device.iosVersion}
                {device.connectionType && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '1px 5px',
                      borderRadius: 3,
                      fontSize: 10,
                      background: device.connectionType === 'Network' ? 'rgba(76, 175, 80, 0.15)' : 'rgba(108, 140, 255, 0.15)',
                      color: device.connectionType === 'Network' ? '#4caf50' : '#6c8cff',
                    }}
                  >
                    {device.connectionType === 'Network' ? (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M5 12.55a11 11 0 0114 0" />
                        <path d="M8.53 16.11a6 6 0 016.95 0" />
                        <circle cx="12" cy="20" r="1" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <rect x="9" y="2" width="6" height="20" rx="1" />
                        <line x1="9" y1="18" x2="15" y2="18" />
                      </svg>
                    )}
                    {device.connectionType === 'Network' ? 'WiFi' : 'USB'}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.6 }}>No device</div>
          )}
        </div>
        <button
          className="action-btn"
          onClick={onScan}
          style={{ padding: '4px 10px', fontSize: 12 }}
          title="Scan USB"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 1l4 4" />
            <path d="M5 12a7 7 0 0114 0" />
            <path d="M8.5 8.5a4 4 0 017 0" />
            <circle cx="12" cy="12" r="1" fill="currentColor" />
          </svg>
          USB
        </button>
      </div>

      {/* Device dropdown */}
      {devices.length >= 1 && (
        <div style={{ position: 'relative', marginBottom: 6 }}>
          <button
            className="action-btn"
            onClick={() => setShowDropdown(!showDropdown)}
            style={{ width: '100%', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                <rect x="5" y="2" width="14" height="20" rx="2" />
                <line x1="12" y1="18" x2="12" y2="18" />
              </svg>
              {devices.length} devices found
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ transform: showDropdown ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
            >
              <polyline points="6,9 12,15 18,9" />
            </svg>
          </button>

          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: '#2a2a2e',
                border: '1px solid #444',
                borderRadius: 4,
                marginTop: 4,
                zIndex: 100,
                boxShadow: '0 4px 8px rgba(0,0,0,0.3)',
              }}
            >
              {devices.map((d) => (
                <div
                  key={d.id}
                  onClick={() => {
                    onSelect(d.id);
                    setShowDropdown(false);
                  }}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    borderBottom: '1px solid #333',
                    background: device?.id === d.id ? '#3a3a4e' : 'transparent',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = device?.id === d.id ? '#3a3a4e' : 'transparent'; }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="5" y="2" width="14" height="20" rx="2" />
                    <line x1="12" y1="18" x2="12" y2="18" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: device?.id === d.id ? 600 : 400 }}>{d.name}</div>
                    <div style={{ opacity: 0.5, fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                      iOS {d.iosVersion}
                      {d.connectionType && (
                        <span style={{
                          fontSize: 9,
                          padding: '0 3px',
                          borderRadius: 2,
                          background: d.connectionType === 'Network' ? 'rgba(76, 175, 80, 0.15)' : 'rgba(108, 140, 255, 0.15)',
                          color: d.connectionType === 'Network' ? '#4caf50' : '#6c8cff',
                        }}>
                          {d.connectionType === 'Network' ? 'WiFi' : 'USB'}
                        </span>
                      )}
                    </div>
                  </div>
                  {device?.id === d.id && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3" style={{ marginLeft: 'auto' }}>
                      <polyline points="20,6 9,17 4,12" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* WiFi Connection Section — collapsible with iOS version tabs */}
      {(onStartWifiTunnel || onWifiConnect) && (
        <div style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 4 }}>
          {/* Collapsible header */}
          <button
            onClick={() => setWifiExpanded(!wifiExpanded)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', background: 'transparent',
              border: 'none', color: 'inherit', padding: 0, cursor: 'pointer',
              fontSize: 12,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              WiFi 無線連線
              {tunnelStatus.running && (
                <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 3,
                  background: 'rgba(76, 175, 80, 0.15)', color: '#4caf50',
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4caf50' }} />
                  Active
                </span>
              )}
            </span>
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ transform: wifiExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', opacity: 0.6 }}
            >
              <polyline points="6,9 12,15 18,9" />
            </svg>
          </button>

          {wifiExpanded && (
            <div style={{ marginTop: 8 }}>
              {/* iOS version tabs */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 8, padding: 2, background: 'rgba(255,255,255,0.04)', borderRadius: 4 }}>
                <button
                  onClick={() => setWifiTab('ios17plus')}
                  style={{
                    flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 3, border: 'none',
                    background: wifiTab === 'ios17plus' ? 'rgba(108, 140, 255, 0.2)' : 'transparent',
                    color: wifiTab === 'ios17plus' ? '#6c8cff' : 'rgba(255,255,255,0.6)',
                    fontWeight: wifiTab === 'ios17plus' ? 600 : 400, cursor: 'pointer',
                  }}
                >
                  iOS 17+
                </button>
                <button
                  onClick={() => setWifiTab('ios17minus')}
                  style={{
                    flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 3, border: 'none',
                    background: wifiTab === 'ios17minus' ? 'rgba(108, 140, 255, 0.2)' : 'transparent',
                    color: wifiTab === 'ios17minus' ? '#6c8cff' : 'rgba(255,255,255,0.6)',
                    fontWeight: wifiTab === 'ios17minus' ? 600 : 400, cursor: 'pointer',
                  }}
                >
                  iOS 17 以下
                </button>
              </div>

              {/* Help + Discover buttons row */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button
                  onClick={() => setShowIpHelp(!showIpHelp)}
                  style={{
                    flex: 1, fontSize: 10, padding: '3px 6px', borderRadius: 3,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.7)',
                    cursor: 'pointer',
                  }}
                >
                  ? 如何找 IP
                </button>
                {wifiTab === 'ios17plus' && (
                  <button
                    onClick={handleDiscover}
                    disabled={discovering || tunnelStatus.running}
                    title="自動偵測同網段 iPhone 的 IP 與 Port"
                    style={{
                      flex: 1, fontSize: 10, padding: '3px 6px', borderRadius: 3,
                      border: '1px solid rgba(108, 140, 255, 0.5)',
                      background: 'rgba(108, 140, 255, 0.12)',
                      color: '#6c8cff', cursor: discovering ? 'wait' : 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={discovering ? { animation: 'spin 1s linear infinite' } : undefined}>
                      <circle cx="11" cy="11" r="7" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    {discovering ? '偵測中' : '自動偵測'}
                  </button>
                )}
              </div>

              {showIpHelp && (
                <div style={{
                  fontSize: 11, padding: '8px 10px', marginBottom: 8,
                  background: 'rgba(108, 140, 255, 0.08)',
                  border: '1px solid rgba(108, 140, 255, 0.3)',
                  borderRadius: 4, lineHeight: 1.6,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: '#6c8cff' }}>
                    如何找到 iPhone 的 IP?
                  </div>
                  <div style={{ opacity: 0.85 }}>
                    iPhone 上:<br />
                    <b>設定 → Wi-Fi → 點目前連線網路旁的 (i) → 往下找「IP 位址」</b>
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.6, marginTop: 6 }}>
                    iPhone 與電腦必須在同一個 WiFi 網段
                  </div>
                </div>
              )}

              {/* iOS 17+ — WiFi Tunnel (RSD) */}
              {wifiTab === 'ios17plus' && onStartWifiTunnel && (
                tunnelStatus.running ? (
                  <div>
                    <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, padding: '4px 6px', background: 'rgba(76, 175, 80, 0.08)', borderRadius: 3 }}>
                      <div>RSD: {tunnelStatus.rsd_address}:{tunnelStatus.rsd_port}</div>
                      <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }}>USB 可拔除</div>
                    </div>
                    <button
                      className="action-btn"
                      onClick={async () => { if (onStopTunnel) await onStopTunnel(); }}
                      style={{ width: '100%', fontSize: 11, color: '#f44336' }}
                    >
                      Stop Tunnel
                    </button>
                  </div>
                ) : (
                  <div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 4 }}>
                      <span style={{ opacity: 0.7, width: 36 }}>IP</span>
                      <input
                        type="text" className="search-input"
                        placeholder="iPhone IP(例如 192.168.0.205)"
                        value={tunnelIp} onChange={(e) => setTunnelIp(e.target.value)}
                        style={{ flex: 1, fontSize: 12 }} disabled={tunnelConnecting}
                      />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 6 }}>
                      <span style={{ opacity: 0.7, width: 36 }}>Port</span>
                      <input
                        type="text" className="search-input" placeholder="49152"
                        value={tunnelPort} onChange={(e) => setTunnelPort(e.target.value)}
                        style={{ flex: 1, fontSize: 12 }} disabled={tunnelConnecting}
                      />
                    </label>
                    <button
                      className="action-btn primary"
                      onClick={async () => {
                        if (!tunnelIp.trim()) return;
                        setTunnelConnecting(true); setTunnelError(null);
                        try {
                          await onStartWifiTunnel(tunnelIp.trim(), parseInt(tunnelPort) || 49152);
                          // Remember on success
                          localStorage.setItem('locwarp.tunnel.ip', tunnelIp.trim());
                          localStorage.setItem('locwarp.tunnel.port', tunnelPort || '49152');
                        } catch (err: any) {
                          setTunnelError(err.message || 'WiFi tunnel failed');
                        } finally { setTunnelConnecting(false); }
                      }}
                      disabled={tunnelConnecting || !tunnelIp.trim()}
                      style={{ width: '100%', fontSize: 12 }}
                    >
                      {tunnelConnecting ? (
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
                          </svg>
                          建立 tunnel 中...
                        </span>
                      ) : 'Start WiFi Tunnel'}
                    </button>
                    {tunnelError && (
                      <div style={{ fontSize: 11, color: '#f44336', marginTop: 4, padding: '4px 6px', background: 'rgba(244,67,54,0.1)', borderRadius: 3 }}>
                        {tunnelError}
                      </div>
                    )}
                    <div style={{ fontSize: 10, opacity: 0.4, marginTop: 6 }}>
                      請使用身分管理員開啟 LocWarp,必須先通過 USB 信任。
                    </div>
                  </div>
                )
              )}

              {/* iOS 17 以下 — Legacy direct WiFi */}
              {wifiTab === 'ios17minus' && (
                <div>
                  {onWifiConnect ? (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 6 }}>
                        <span style={{ opacity: 0.7, width: 36 }}>IP</span>
                        <input
                          type="text" className="search-input"
                          placeholder="iPhone IP(例如 192.168.0.205)"
                          value={legacyIp} onChange={(e) => setLegacyIp(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleLegacyConnect()}
                          style={{ flex: 1, fontSize: 12 }} disabled={legacyConnecting}
                        />
                      </label>
                      <button
                        className="action-btn primary"
                        onClick={handleLegacyConnect}
                        disabled={legacyConnecting || !legacyIp.trim()}
                        style={{ width: '100%', fontSize: 12 }}
                      >
                        {legacyConnecting ? '連線中...' : 'Connect'}
                      </button>
                      {legacyError && (
                        <div style={{ fontSize: 11, color: '#f44336', marginTop: 4, padding: '4px 6px', background: 'rgba(244,67,54,0.1)', borderRadius: 3 }}>
                          {legacyError}
                        </div>
                      )}
                      <div style={{ fontSize: 10, opacity: 0.4, marginTop: 6 }}>
                        iOS 17 以下不需建立 RSD tunnel,iPhone 解鎖且已配對即可直接連線。
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 11, opacity: 0.6, padding: '8px 0' }}>
                      iOS 17 以下連線方式目前不可用。
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DeviceStatus;
