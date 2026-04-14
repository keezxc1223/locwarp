import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { wifiTunnelDiscover, wifiRepair } from '../services/api';
import { useT } from '../i18n';

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
  onScan: () => void | Promise<void>;
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
  const t = useT();
  const [showDropdown, setShowDropdown] = useState(false);
  const [tunnelIp, setTunnelIp] = useState(() => localStorage.getItem('locwarp.tunnel.ip') || '');
  const [tunnelPort, setTunnelPort] = useState(() => localStorage.getItem('locwarp.tunnel.port') || '49152');
  const [tunnelConnecting, setTunnelConnecting] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [showIpHelp, setShowIpHelp] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [wifiExpanded, setWifiExpanded] = useState(false);
  const [showWifiWarning, setShowWifiWarning] = useState(false);
  const [showRepairConfirm, setShowRepairConfirm] = useState(false);
  const [repairState, setRepairState] = useState<'idle' | 'running' | 'success' | 'failed'>('idle');
  const [repairMessage, setRepairMessage] = useState<string>('');

  const handleRepair = async () => {
    setRepairState('running');
    setRepairMessage('');
    try {
      const res = await wifiRepair();
      setRepairState('success');
      setRepairMessage(`${res.name || 'iPhone'} (iOS ${res.ios_version})`);
    } catch (err: any) {
      setRepairState('failed');
      setRepairMessage(err?.message || 'Unknown error');
    }
  };
  const [scanning, setScanning] = useState(false);
  // null = no recent scan; number = device count from most recent scan (flash display)
  const [scanResult, setScanResult] = useState<number | null>(null);
  const scanResultTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const devicesRef = React.useRef(devices);
  devicesRef.current = devices;

  const handleScan = async () => {
    if (scanResultTimer.current) clearTimeout(scanResultTimer.current);
    setScanning(true);
    setScanResult(null);
    try {
      await Promise.resolve(onScan());
    } finally {
      setScanning(false);
      // Read the freshest devices state via ref — parent has updated by now
      setScanResult(devicesRef.current.length);
      scanResultTimer.current = setTimeout(() => setScanResult(null), 2000);
    }
  };

  React.useEffect(() => () => {
    if (scanResultTimer.current) clearTimeout(scanResultTimer.current);
  }, []);
  // iOS 16-and-below WiFi state removed in v0.1.49 (LocWarp now requires iOS 17+).

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
        setTunnelError(t('wifi.device_not_detected'));
      }
    } catch (err: any) {
      setTunnelError(err.message || t('wifi.detect_failed'));
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
          onClick={handleScan}
          disabled={scanning}
          style={{ padding: '4px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 70, justifyContent: 'center' }}
          title={t('device.scan_tooltip')}
        >
          {scanning ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="16" />
              </svg>
              {t('device.scan_scanning')}
            </>
          ) : scanResult != null && scanResult > 0 ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span style={{ color: '#4caf50' }}>{t('device.scan_found', { n: scanResult })}</span>
            </>
          ) : scanResult === 0 ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f44336" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span style={{ color: '#f44336' }}>{t('device.scan_none')}</span>
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 1l4 4" />
                <path d="M5 12a7 7 0 0114 0" />
                <path d="M8.5 8.5a4 4 0 017 0" />
                <circle cx="12" cy="12" r="1" fill="currentColor" />
              </svg>
              USB
            </>
          )}
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
              {devices.map((d) => {
                // LocWarp v0.1.49+ requires iOS 17. Mark older devices as
                // unsupported so users don't waste a click waiting for the
                // backend to reject the connect.
                const major = parseInt((d.iosVersion || '0').split('.')[0], 10) || 0;
                const unsupported = major > 0 && major < 17;
                return (
                <div
                  key={d.id}
                  onClick={() => {
                    if (unsupported) return;
                    onSelect(d.id);
                    setShowDropdown(false);
                  }}
                  style={{
                    padding: '8px 12px',
                    cursor: unsupported ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    borderBottom: '1px solid #333',
                    background: device?.id === d.id ? '#3a3a4e' : 'transparent',
                    opacity: unsupported ? 0.55 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (unsupported) return;
                    (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
                  }}
                  onMouseLeave={(e) => {
                    if (unsupported) return;
                    (e.currentTarget as HTMLDivElement).style.background = device?.id === d.id ? '#3a3a4e' : 'transparent';
                  }}
                  title={unsupported ? t('device.ios_unsupported_label', { version: d.iosVersion }) : undefined}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={unsupported ? '#f44336' : 'currentColor'} strokeWidth="2">
                    {unsupported ? (
                      <>
                        <circle cx="12" cy="12" r="10" />
                        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                      </>
                    ) : (
                      <>
                        <rect x="5" y="2" width="14" height="20" rx="2" />
                        <line x1="12" y1="18" x2="12" y2="18" />
                      </>
                    )}
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: device?.id === d.id ? 600 : 400 }}>{d.name}</div>
                    <div style={{ opacity: 0.5, fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                      {unsupported
                        ? <span style={{ color: '#f44336' }}>{t('device.ios_unsupported_label', { version: d.iosVersion })}</span>
                        : <>iOS {d.iosVersion}</>}
                      {d.connectionType && !unsupported && (
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
                );
              })}
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
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.2 }}>
                <span>{t('wifi.section_title')}</span>
                <span style={{ fontSize: 10, opacity: 0.6 }}>{t('wifi.section_hint')}</span>
              </span>
              <span
                role="button"
                aria-label={t('wifi.warning_label')}
                title={t('wifi.warning_label')}
                onClick={(e) => { e.stopPropagation(); setShowWifiWarning(true); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 16, height: 16, borderRadius: '50%',
                  background: 'rgba(255, 193, 7, 0.15)', color: '#ffc107',
                  fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  border: '1px solid rgba(255, 193, 7, 0.4)',
                }}
              >!</span>
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
              <button
                onClick={() => { setRepairState('idle'); setRepairMessage(''); setShowRepairConfirm(true); }}
                title={t('wifi.repair_tooltip')}
                style={{
                  width: '100%', padding: '5px 8px', fontSize: 11, marginBottom: 8,
                  background: 'rgba(255, 193, 7, 0.08)',
                  border: '1px solid rgba(255, 193, 7, 0.35)',
                  borderRadius: 4, color: '#ffc107', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 11-6.219-8.56" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
                {t('wifi.repair_button')}
              </button>

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
                  {t('wifi.help_ip')}
                </button>
                <button
                  onClick={handleDiscover}
                  disabled={discovering || tunnelStatus.running}
                  title={t('wifi.detect_tooltip')}
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
                  {discovering ? t('wifi.detect_scanning') : t('wifi.detect')}
                </button>
              </div>

              {showIpHelp && (
                <div style={{
                  fontSize: 11, padding: '8px 10px', marginBottom: 8,
                  background: 'rgba(108, 140, 255, 0.08)',
                  border: '1px solid rgba(108, 140, 255, 0.3)',
                  borderRadius: 4, lineHeight: 1.6,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: '#6c8cff' }}>
                    {t('wifi.help_title')}
                  </div>
                  <div style={{ opacity: 0.85 }}>
                    {t('wifi.help_steps')}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.6, marginTop: 6 }}>
                    {t('wifi.help_hint')}
                  </div>
                </div>
              )}

              {/* iOS 17+ WiFi Tunnel (RSD) */}
              {onStartWifiTunnel && (
                tunnelStatus.running ? (
                  <div>
                    <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, padding: '4px 6px', background: 'rgba(76, 175, 80, 0.08)', borderRadius: 3 }}>
                      <div>RSD: {tunnelStatus.rsd_address}:{tunnelStatus.rsd_port}</div>
                      <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }}>{t('wifi.tunnel_usb_can_disconnect')}</div>
                    </div>
                    <button
                      className="action-btn"
                      onClick={async () => { if (onStopTunnel) await onStopTunnel(); }}
                      style={{ width: '100%', fontSize: 11, color: '#f44336' }}
                    >
                      {t('wifi.tunnel_stop')}
                    </button>
                  </div>
                ) : (
                  <div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 4 }}>
                      <span style={{ opacity: 0.7, width: 36 }}>IP</span>
                      <input
                        type="text" className="search-input"
                        placeholder={t('wifi.ip_placeholder')}
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
                          {t('wifi.tunnel_establishing')}
                        </span>
                      ) : t('wifi.tunnel_start')}
                    </button>
                    {tunnelError && (
                      <div style={{ fontSize: 11, color: '#f44336', marginTop: 4, padding: '4px 6px', background: 'rgba(244,67,54,0.1)', borderRadius: 3 }}>
                        {tunnelError}
                      </div>
                    )}
                    <div style={{ fontSize: 10, opacity: 0.4, marginTop: 6 }}>
                      {t('wifi.tunnel_admin_hint')}
                    </div>
                  </div>
                )
              )}

            </div>
          )}
        </div>
      )}

      {showWifiWarning && createPortal(
        <div
          onClick={() => setShowWifiWarning(false)}
          className="anim-fade-in"
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(8, 10, 20, 0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="anim-scale-in"
            style={{
              background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)', borderRadius: 14,
              padding: 26, maxWidth: 560, width: '100%',
              maxHeight: '80vh', overflowY: 'auto',
              color: '#e8e8e8',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '50%',
                background: 'rgba(255, 193, 7, 0.15)', color: '#ffc107',
                fontSize: 20, fontWeight: 700, border: '1px solid rgba(255,193,7,0.5)',
                flexShrink: 0,
              }}>!</span>
              <strong style={{ fontSize: 16 }}>{t('wifi.warning_title')}</strong>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-line', opacity: 0.92 }}>
              {t('wifi.warning_body')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                onClick={() => setShowWifiWarning(false)}
                style={{
                  padding: '8px 20px', fontSize: 13, borderRadius: 5,
                  background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer',
                  fontWeight: 600,
                }}
              >{t('wifi.warning_ok')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showRepairConfirm && createPortal(
        <div
          onClick={() => { if (repairState !== 'running') setShowRepairConfirm(false); }}
          className="anim-fade-in"
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(8, 10, 20, 0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="anim-scale-in"
            style={{
              background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)', borderRadius: 14,
              padding: 26, maxWidth: 460, width: '100%',
              color: '#e8e8e8',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '50%',
                background: 'rgba(108, 140, 255, 0.15)', color: '#6c8cff',
                fontSize: 18, fontWeight: 700, border: '1px solid rgba(108,140,255,0.5)',
                flexShrink: 0,
              }}>↻</span>
              <strong style={{ fontSize: 15 }}>{t('wifi.repair_confirm_title')}</strong>
            </div>

            {repairState === 'idle' && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-line', opacity: 0.92 }}>
                  {t('wifi.repair_confirm_body')}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
                  <button
                    onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: 'pointer' }}
                  >{t('wifi.repair_cancel')}</button>
                  <button
                    onClick={handleRepair}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                  >{t('wifi.repair_ok')}</button>
                </div>
              </>
            )}

            {repairState === 'running' && (
              <div style={{ fontSize: 13, lineHeight: 1.7, textAlign: 'center', padding: '20px 0' }}>
                <div style={{
                  width: 32, height: 32, margin: '0 auto 12px',
                  border: '3px solid rgba(108,140,255,0.25)',
                  borderTopColor: '#6c8cff', borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                <div style={{ color: '#ffc107' }}>{t('wifi.repair_running')}</div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>
            )}

            {repairState === 'success' && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: '#4caf50' }}>
                  {t('wifi.repair_success')}
                </div>
                {repairMessage && (
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>{repairMessage}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                  <button
                    onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                  >{t('wifi.warning_ok')}</button>
                </div>
              </>
            )}

            {repairState === 'failed' && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: '#ff6b6b' }}>
                  {t('wifi.repair_failed')}
                </div>
                {repairMessage && (
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8, padding: 8,
                    background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.3)',
                    borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{repairMessage}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
                  <button
                    onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: 'pointer' }}
                  >{t('wifi.repair_cancel')}</button>
                  <button
                    onClick={handleRepair}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                  >{t('wifi.repair_ok')}</button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default DeviceStatus;
