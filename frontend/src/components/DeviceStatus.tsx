import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { wifiTunnelDiscover, wifiTunnelFindPort, wifiRepair, wifiKeepaliveGet, wifiKeepaliveSet, type TunnelInfo } from '../services/api';
import { useT } from '../i18n';

const MAX_TUNNEL_DEVICES = 3;

interface Device {
  id: string;
  name: string;
  iosVersion: string;
  connectionType?: string;
  developerModeEnabled?: boolean | null;
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
  onStopTunnel?: (udid?: string) => Promise<void>;
  tunnelStatus?: TunnelStatus;
  tunnels?: TunnelInfo[];
  onWifiConnect?: (ip: string) => Promise<any>;
  pinnedUdids?: string[];
  onTogglePin?: (udid: string) => void;
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
  tunnels = [],
  onWifiConnect,
  pinnedUdids = [],
  onTogglePin,
}) => {
  const t = useT();
  const [showDropdown, setShowDropdown] = useState(false);
  const [tunnelIp, setTunnelIp] = useState(() => localStorage.getItem('locwarp.tunnel.ip') || '');
  const [tunnelPort, setTunnelPort] = useState(() => localStorage.getItem('locwarp.tunnel.port') || '');
  const [portScanning, setPortScanning] = useState(false);
  // Saved IPs are written by useDevice.startWifiTunnel into
  // locwarp.tunnel.savedips as a max-5 ring buffer. Surface them here so
  // users can re-establish a tunnel to the same iPhone with one click,
  // instead of retyping the IP after every WiFi drop / manual Stop
  // (issue #29). Refresh whenever the dropdown is toggled or after a
  // successful connect so the list reflects useDevice's latest write.
  const readSavedIps = (): Array<{ ip: string; port: number; udid?: string; lastUsed: number }> => {
    try {
      const raw = localStorage.getItem('locwarp.tunnel.savedips') || '[]';
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e) => e && typeof e.ip === 'string' && typeof e.port === 'number');
    } catch { return []; }
  };
  const [savedIps, setSavedIps] = useState(readSavedIps);
  const [showSavedIps, setShowSavedIps] = useState(false);
  const refreshSavedIps = () => setSavedIps(readSavedIps());
  // Map udid -> last known device name, harvested from savedips. Lets the
  // active-tunnel card and recent list keep showing the real phone name
  // after a WiFi drop, instead of falling back to a raw UDID string
  // (issue #33). The name is written into savedips on every successful
  // connect by useDevice.startWifiTunnel.
  const savedNameByUdid: Record<string, string> = {};
  savedIps.forEach((e: any) => { if (e && e.udid && e.name) savedNameByUdid[e.udid] = e.name; });
  // Auto-attempt the saved IP/port on app launch. Default ON so users who
  // previously connected over WiFi don't have to re-click on every cold
  // start — App.tsx reads this flag once after the WS handshake settles.
  const [autoConnectEnabled, setAutoConnectEnabled] = useState<boolean>(
    () => localStorage.getItem('locwarp.tunnel.autoconnect') !== '0',
  );
  const handleAutoConnectToggle = (next: boolean) => {
    setAutoConnectEnabled(next);
    try { localStorage.setItem('locwarp.tunnel.autoconnect', next ? '1' : '0'); } catch { /* ignore */ }
  };
  // Keep-alive lives on the backend (it pokes the RSD tunnel), so we read
  // its current value once on mount and write changes through the API.
  const [keepaliveEnabled, setKeepaliveEnabled] = useState<boolean>(true);
  React.useEffect(() => {
    wifiKeepaliveGet().then((r) => setKeepaliveEnabled(r.enabled !== false)).catch(() => { /* keep default */ });
  }, []);
  const handleKeepaliveToggle = (next: boolean) => {
    setKeepaliveEnabled(next);
    wifiKeepaliveSet(next).catch(() => { /* best-effort */ });
  };
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
  // WiFi tunnel remains iOS 17+ only; iOS 16 devices are supported over USB.

  // Multi-result detect: keep the full list and let the user pick one when
  // mDNS / subnet scan returns 2+ iPhones. Single result auto-fills as before.
  const [discoverResults, setDiscoverResults] = useState<Array<{ ip: string; port: number; name: string }>>([]);
  const handleDiscover = async () => {
    setDiscovering(true);
    setTunnelError(null);
    setDiscoverResults([]);
    try {
      const res = await wifiTunnelDiscover();
      const rawList = res?.devices || [];
      // Deduplicate by ip:port — mDNS can return the same device on
      // multiple interfaces (e.g. Ethernet + WiFi) with identical IPs.
      const seen = new Set<string>();
      const list = rawList.filter((d: any) => {
        const key = `${d.ip}:${d.port}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (list.length === 0) {
        setTunnelError(t('wifi.device_not_detected'));
      } else if (list.length === 1) {
        setTunnelIp(list[0].ip);
        setTunnelPort(String(list[0].port));
      } else {
        setDiscoverResults(list.map((d: any) => ({ ip: d.ip, port: d.port, name: d.name || d.ip })));
      }
    } catch (err: any) {
      setTunnelError(err.message || t('wifi.detect_failed'));
    } finally {
      setDiscovering(false);
    }
  };
  const pickDiscoverResult = (r: { ip: string; port: number }) => {
    setTunnelIp(r.ip);
    setTunnelPort(String(r.port));
    setDiscoverResults([]);
  };

  return (
    <div className={`device-status ${isConnected ? 'device-connected' : 'device-disconnected'}`}>
      {/* Device info card — no scan button inside */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
        <div
          style={{
            width: 10, height: 10, borderRadius: '50%', flexShrink: 0, marginTop: 4,
            background: isConnected ? '#4caf50' : '#f44336',
            boxShadow: isConnected ? '0 0 6px #4caf50' : '0 0 6px #f44336',
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {device ? (() => {
            const isWifi = device.connectionType === 'Network';
            const activeTunnel = isWifi ? tunnels.find((tn) => tn.udid === device.id) : null;
            const pinned = activeTunnel ? pinnedUdids.includes(device.id) : false;
            return (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                  {device.name}
                </div>
                <div style={{ fontSize: 11, opacity: 0.65, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 3 }}>
                  <span>iOS {device.iosVersion}</span>
                  <span style={{
                    padding: '1px 6px', borderRadius: 3, fontSize: 11,
                    background: isWifi ? 'rgba(76, 175, 80, 0.15)' : 'rgba(108, 140, 255, 0.15)',
                    color: isWifi ? '#4caf50' : '#6c8cff',
                  }}>
                    {isWifi ? 'WiFi' : 'USB'}
                  </span>
                  {activeTunnel && (
                    <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.75 }}>
                      {activeTunnel.rsd_address}:{activeTunnel.rsd_port}
                    </span>
                  )}
                </div>
                {activeTunnel && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
                    {onTogglePin && (
                      <button
                        onClick={() => onTogglePin(device.id)}
                        title={pinned ? t('wifi.pin_on_tooltip') : t('wifi.pin_off_tooltip')}
                        style={{
                          fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
                          border: pinned ? '1px solid rgba(108, 140, 255, 0.6)' : '1px solid rgba(255,255,255,0.18)',
                          background: pinned ? 'rgba(108, 140, 255, 0.18)' : 'transparent',
                          color: pinned ? '#9ac0ff' : 'var(--text-muted)',
                        }}
                      >
                        {pinned ? t('wifi.pin_on') : t('wifi.pin_off')}
                      </button>
                    )}
                    <button
                      onClick={async () => { if (onStopTunnel) await onStopTunnel(device.id); }}
                      style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
                        border: '1px solid rgba(244, 67, 54, 0.45)',
                        background: 'rgba(244, 67, 54, 0.08)', color: '#f44336',
                      }}
                    >
                      {t('wifi.tunnel_stop')}
                    </button>
                  </div>
                )}
              </>
            );
          })() : (
            <div style={{ fontSize: 13, opacity: 0.55 }}>No device</div>
          )}
        </div>
      </div>

      {/* USB scan button — standalone row below device info */}
      <button
        className="action-btn"
        onClick={handleScan}
        disabled={scanning}
        style={{ width: '100%', padding: '6px 10px', fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
        title={t('device.scan_tooltip')}
      >
        {scanning ? (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="16" />
            </svg>
            {t('device.scan_scanning')}
          </>
        ) : scanResult != null && scanResult > 0 ? (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span style={{ color: '#4caf50' }}>{t('device.scan_found', { n: scanResult })}</span>
          </>
        ) : scanResult === 0 ? (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f44336" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span style={{ color: '#f44336' }}>{t('device.scan_none')}</span>
          </>
        ) : (
          t('device.scan_tooltip')
        )}
      </button>

      {/* WiFi tunnel cards for additional devices not shown in the top row */}
      {tunnels.filter((tn) => tn.udid !== device?.id).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {tunnels.filter((tn) => tn.udid !== device?.id).map((tn) => {
            const dev = devices.find((d) => d.id === tn.udid);
            const dispName = dev?.name || savedNameByUdid[tn.udid] || tn.udid.slice(0, 12);
            const pinned = pinnedUdids.includes(tn.udid);
            return (
              <div key={tn.udid} style={{
                display: 'flex', alignItems: 'flex-start', gap: 6,
                marginBottom: 4, padding: '5px 8px',
                background: 'rgba(76, 175, 80, 0.08)',
                border: '1px solid rgba(76, 175, 80, 0.25)',
                borderRadius: 3,
              }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4caf50', flexShrink: 0, boxShadow: '0 0 4px #4caf50', marginTop: 3 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                    {dispName}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.65, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginTop: 3 }}>
                    {dev?.iosVersion && <span>iOS {dev.iosVersion}</span>}
                    <span style={{ padding: '1px 6px', borderRadius: 3, background: 'rgba(76, 175, 80, 0.15)', color: '#4caf50', fontSize: 11 }}>WiFi</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.75 }}>{tn.rsd_address}:{tn.rsd_port}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
                    {onTogglePin && (
                      <button
                        onClick={() => onTogglePin(tn.udid)}
                        title={pinned ? t('wifi.pin_on_tooltip') : t('wifi.pin_off_tooltip')}
                        style={{
                          fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
                          border: pinned ? '1px solid rgba(108, 140, 255, 0.6)' : '1px solid rgba(255,255,255,0.18)',
                          background: pinned ? 'rgba(108, 140, 255, 0.18)' : 'transparent',
                          color: pinned ? '#9ac0ff' : 'var(--text-muted)',
                        }}
                      >
                        {pinned ? t('wifi.pin_on') : t('wifi.pin_off')}
                      </button>
                    )}
                    <button
                      onClick={async () => { if (onStopTunnel) await onStopTunnel(tn.udid); }}
                      style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
                        border: '1px solid rgba(244, 67, 54, 0.45)',
                        background: 'rgba(244, 67, 54, 0.08)', color: '#f44336',
                      }}
                    >
                      {t('wifi.tunnel_stop')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Device dropdown — only shown when 2+ USB devices found; single device auto-connects */}
      {devices.length > 1 && (
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
              {t('device.scan_found', { n: devices.length })}
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
                // iOS 16 is supported again. Keep only truly older devices
                // disabled so users don't waste a click waiting for the
                // backend to reject the connect.
                const major = parseInt((d.iosVersion || '0').split('.')[0], 10) || 0;
                const unsupported = major > 0 && major < 16;
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
              <span>{t('wifi.section_title')}</span>
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
              {/* Help + Discover + Repair buttons row */}
              <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
                <button
                  onClick={() => setShowIpHelp(!showIpHelp)}
                  style={{
                    flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 5,
                    border: `1px solid ${showIpHelp ? 'rgba(108,140,255,0.5)' : 'rgba(255,255,255,0.18)'}`,
                    background: showIpHelp ? 'rgba(108,140,255,0.12)' : 'rgba(255,255,255,0.05)',
                    color: showIpHelp ? '#9ac0ff' : 'rgba(255,255,255,0.75)',
                    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {t('wifi.help_ip')}
                </button>
                <button
                  onClick={handleDiscover}
                  disabled={discovering || tunnels.length >= MAX_TUNNEL_DEVICES}
                  title={t('wifi.detect_tooltip')}
                  style={{
                    flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 5,
                    border: '1px solid rgba(108, 140, 255, 0.5)',
                    background: 'rgba(108, 140, 255, 0.12)',
                    color: '#6c8cff', cursor: discovering ? 'wait' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                    opacity: (discovering || tunnels.length >= MAX_TUNNEL_DEVICES) ? 0.5 : 1,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={discovering ? { animation: 'spin 1s linear infinite' } : undefined}>
                    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  {discovering ? t('wifi.detect_scanning') : t('wifi.detect')}
                </button>
                <button
                  onClick={() => { setRepairState('idle'); setRepairMessage(''); setShowRepairConfirm(true); }}
                  title={t('wifi.repair_tooltip')}
                  style={{
                    flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 5,
                    background: 'rgba(255, 193, 7, 0.08)',
                    border: '1px solid rgba(255, 193, 7, 0.35)',
                    color: '#ffc107', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 11-6.219-8.56" /><polyline points="21 3 21 9 15 9" />
                  </svg>
                  {t('wifi.repair_button')}
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

              {/* Multi-result discovery picker — appears when /detect returns 2+ iPhones */}
              {discoverResults.length > 0 && (
                <div style={{
                  fontSize: 11, padding: '6px 8px', marginBottom: 8,
                  background: 'rgba(108, 140, 255, 0.06)',
                  border: '1px solid rgba(108, 140, 255, 0.3)',
                  borderRadius: 4,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: '#6c8cff' }}>
                    {t('wifi.tunnel_detect_multiple', { n: discoverResults.length })}
                  </div>
                  {discoverResults.map((r) => (
                    <div key={`${r.ip}:${r.port}`} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '4px 0', borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}>
                      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ opacity: 0.85 }}>{r.ip}</span>
                        <span style={{ opacity: 0.55, marginLeft: 6 }}>{r.name}</span>
                      </div>
                      <button
                        onClick={() => pickDiscoverResult(r)}
                        style={{
                          fontSize: 10, padding: '2px 6px', borderRadius: 3,
                          border: '1px solid rgba(108, 140, 255, 0.5)',
                          background: 'rgba(108, 140, 255, 0.12)', color: '#6c8cff',
                          cursor: 'pointer',
                        }}
                      >
                        {t('wifi.tunnel_use_this')}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Auto-connect on launch toggle */}
              <label
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 11, padding: '5px 8px', marginBottom: 6,
                  background: 'rgba(108, 140, 255, 0.06)',
                  border: '1px solid rgba(108, 140, 255, 0.2)',
                  borderRadius: 4, cursor: 'pointer',
                }}
                title={t('wifi.autoconnect_tooltip')}
              >
                <input type="checkbox" checked={autoConnectEnabled} onChange={(e) => handleAutoConnectToggle(e.target.checked)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
                <span style={{
                  position: 'relative', display: 'inline-flex', alignItems: 'center',
                  width: 28, height: 15, borderRadius: 8, flexShrink: 0,
                  background: autoConnectEnabled ? '#6c8cff' : 'rgba(255,255,255,0.18)',
                  transition: 'background 0.2s',
                }}>
                  <span style={{
                    position: 'absolute', left: autoConnectEnabled ? 14 : 1,
                    top: '50%', transform: 'translateY(-50%)',
                    width: 13, height: 13, borderRadius: '50%',
                    background: '#fff', transition: 'left 0.18s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
                  }} />
                </span>
                <span style={{ flex: 1 }}>{t('wifi.autoconnect_label')}</span>
              </label>

              {/* Keep-alive toggle */}
              <label
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 11, padding: '5px 8px', marginBottom: 8,
                  background: 'rgba(108, 140, 255, 0.06)',
                  border: '1px solid rgba(108, 140, 255, 0.2)',
                  borderRadius: 4, cursor: 'pointer',
                }}
                title={t('wifi.keepalive_tooltip')}
              >
                <input type="checkbox" checked={keepaliveEnabled} onChange={(e) => handleKeepaliveToggle(e.target.checked)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
                <span style={{
                  position: 'relative', display: 'inline-flex', alignItems: 'center',
                  width: 28, height: 15, borderRadius: 8, flexShrink: 0,
                  background: keepaliveEnabled ? '#6c8cff' : 'rgba(255,255,255,0.18)',
                  transition: 'background 0.2s',
                }}>
                  <span style={{
                    position: 'absolute', left: keepaliveEnabled ? 14 : 1,
                    top: '50%', transform: 'translateY(-50%)',
                    width: 13, height: 13, borderRadius: '50%',
                    background: '#fff', transition: 'left 0.18s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
                  }} />
                </span>
                <span style={{ flex: 1 }}>{t('wifi.keepalive_label')}</span>
              </label>

              {/* iOS 17+ WiFi Tunnel (RSD) — add form */}
              {onStartWifiTunnel && (
                <>
                  {tunnels.length >= MAX_TUNNEL_DEVICES ? (
                    <div style={{
                      fontSize: 11, padding: '6px 8px', textAlign: 'center',
                      opacity: 0.5,
                      border: '1px dashed rgba(255,255,255,0.15)',
                      borderRadius: 3,
                    }}>
                      {t('wifi.tunnel_max_reached', { max: MAX_TUNNEL_DEVICES })}
                    </div>
                  ) : (
                    <div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 4, position: 'relative' }}>
                        <span style={{ opacity: 0.7, width: 36 }}>IP</span>
                        <input
                          type="text" className="search-input"
                          placeholder={t('wifi.ip_placeholder')}
                          value={tunnelIp} onChange={(e) => setTunnelIp(e.target.value)}
                          style={{ flex: 1, fontSize: 12, paddingLeft: 10 }} disabled={tunnelConnecting}
                        />
                        {savedIps.length > 0 && (
                          <button
                            type="button"
                            onClick={() => { refreshSavedIps(); setShowSavedIps((v) => !v); }}
                            disabled={tunnelConnecting}
                            title={t('wifi.recent_ips_tooltip')}
                            style={{
                              padding: '2px 6px', fontSize: 10, lineHeight: 1.2,
                              background: 'rgba(108, 140, 255, 0.12)',
                              border: '1px solid rgba(108, 140, 255, 0.35)',
                              color: '#9ac0ff', borderRadius: 3,
                              cursor: tunnelConnecting ? 'not-allowed' : 'pointer',
                              display: 'inline-flex', alignItems: 'center', gap: 3,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('wifi.recent_ips_button', { n: savedIps.length })}
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                              style={{ transform: showSavedIps ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                              <polyline points="6,9 12,15 18,9" />
                            </svg>
                          </button>
                        )}
                        {showSavedIps && savedIps.length > 0 && (
                          <div
                            style={{
                              position: 'absolute', top: '100%', right: 0, left: 42,
                              marginTop: 4, zIndex: 30,
                              background: '#2a2a2e',
                              border: '1px solid rgba(108, 140, 255, 0.35)',
                              borderRadius: 4,
                              boxShadow: '0 6px 14px rgba(0,0,0,0.45)',
                              maxHeight: 180, overflowY: 'auto',
                            }}
                          >
                            {savedIps.map((entry, idx) => {
                              const dev = devices.find((d) => d.id === entry.udid);
                              const label = dev?.name || (entry as any).name || (entry.udid ? entry.udid.slice(0, 10) : entry.ip);
                              return (
                                <div
                                  key={`${entry.ip}:${entry.port}:${idx}`}
                                  onClick={() => {
                                    setTunnelIp(entry.ip);
                                    setTunnelPort(String(entry.port));
                                    setShowSavedIps(false);
                                  }}
                                  style={{
                                    padding: '6px 10px', cursor: 'pointer', fontSize: 11,
                                    borderBottom: '1px solid #333',
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                                  }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e'; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                                >
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {label}
                                    </div>
                                    <div style={{ fontSize: 10, opacity: 0.55, fontFamily: 'monospace' }}>
                                      {entry.ip}:{entry.port}
                                    </div>
                                  </div>
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5, flexShrink: 0 }}>
                                    <polyline points="9 18 15 12 9 6" />
                                  </svg>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 6 }}>
                        <span style={{ opacity: 0.7, width: 36 }}>Port</span>
                        <input
                          type="text" className="search-input" placeholder="49152"
                          value={tunnelPort} onChange={(e) => setTunnelPort(e.target.value)}
                          style={{ flex: 1, fontSize: 12, paddingLeft: 10 }} disabled={tunnelConnecting || portScanning}
                          title={t('wifi.port_empty_hint')}
                        />
                        <button
                          className="action-btn"
                          style={{ padding: '4px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
                          disabled={tunnelConnecting || portScanning}
                          title={t('wifi.port_scan_tooltip')}
                          onClick={async () => {
                            const ip = tunnelIp.trim();
                            if (!ip) {
                              setTunnelError(t('wifi.ip_required_for_scan'));
                              return;
                            }
                            setTunnelError(null);
                            setPortScanning(true);
                            try {
                              const res = await wifiTunnelFindPort(ip);
                              if (!res.ports || res.ports.length === 0) {
                                setTunnelError(t('wifi.port_scan_no_hit'));
                              } else {
                                setTunnelPort(String(res.ports[0]));
                              }
                            } catch (err: any) {
                              setTunnelError(err.message || t('wifi.port_scan_failed'));
                            } finally {
                              setPortScanning(false);
                            }
                          }}
                        >
                          {portScanning ? t('wifi.port_scanning_short') : t('wifi.port_scan_button')}
                        </button>
                      </label>
                      <button
                        className="action-btn primary"
                        onClick={async () => {
                          const ip = tunnelIp.trim();
                          if (!ip) {
                            setTunnelError(t('wifi.ip_required_for_scan'));
                            return;
                          }
                          setTunnelError(null);
                          setTunnelConnecting(true);
                          // iOS rebinds its RemotePairing port across reboots /
                          // network changes, so a single guessed (or stale
                          // recent-list) port often times out while a different
                          // open port is the live one (issue #33). Instead of
                          // firing once at ports[0], try the entered port first
                          // (fast path when it's still valid), then scan the
                          // IANA dynamic range and try every open port until a
                          // handshake actually succeeds.
                          const tried = new Set<number>();
                          let connectedPort: number | null = null;
                          let lastErr: any = null;
                          const tryPort = async (p: number): Promise<boolean> => {
                            if (!Number.isFinite(p) || p <= 0 || tried.has(p)) return false;
                            tried.add(p);
                            try {
                              await onStartWifiTunnel(ip, p);
                              connectedPort = p;
                              return true;
                            } catch (err: any) {
                              lastErr = err;
                              return false;
                            }
                          };
                          try {
                            const entered = parseInt(tunnelPort);
                            if (Number.isFinite(entered) && entered > 0) {
                              await tryPort(entered);
                            }
                            if (connectedPort === null) {
                              // Scan and walk every open port. Each wrong port
                              // costs one backend handshake timeout (~8s), but
                              // the scan usually returns only a handful.
                              setPortScanning(true);
                              let ports: number[] = [];
                              try {
                                const res = await wifiTunnelFindPort(ip);
                                ports = res.ports || [];
                              } catch (err: any) {
                                lastErr = err;
                              }
                              setPortScanning(false);
                              if (ports.length === 0 && tried.size === 0) {
                                setTunnelError(t('wifi.port_scan_no_hit'));
                                setTunnelConnecting(false);
                                return;
                              }
                              for (const p of ports) {
                                if (await tryPort(p)) break;
                              }
                            }
                            if (connectedPort !== null) {
                              setTunnelPort(String(connectedPort));
                              // Legacy single-entry keys — kept so the IP / Port
                              // input fields pre-fill correctly next launch. The
                              // savedips multi-entry list is written by
                              // useDevice.startWifiTunnel for every code path.
                              localStorage.setItem('locwarp.tunnel.ip', ip);
                              localStorage.setItem('locwarp.tunnel.port', String(connectedPort));
                              refreshSavedIps();
                            } else {
                              setTunnelError(lastErr?.message || t('wifi.port_scan_no_hit'));
                            }
                          } finally {
                            setPortScanning(false);
                            setTunnelConnecting(false);
                          }
                        }}
                        disabled={tunnelConnecting || portScanning}
                        style={{
                          width: '100%', fontSize: 13, fontWeight: 600, padding: '9px 12px',
                          borderRadius: 7, border: 'none',
                          background: (tunnelConnecting || portScanning) ? 'rgba(108,140,255,0.45)' : 'linear-gradient(135deg, #6c8cff 0%, #4f6fe8 100%)',
                          color: '#fff', cursor: (tunnelConnecting || portScanning) ? 'wait' : 'pointer',
                          boxShadow: (tunnelConnecting || portScanning) ? 'none' : '0 4px 14px rgba(108,140,255,0.45)',
                          letterSpacing: '0.02em', transition: 'all 0.15s',
                        }}
                      >
                        {(tunnelConnecting || portScanning) ? (
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
                            </svg>
                            {portScanning ? t('wifi.port_scanning') : t('wifi.tunnel_establishing')}
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
                  )}
                </>
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
