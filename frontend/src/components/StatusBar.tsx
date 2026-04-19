import React, { useEffect, useState, useCallback, memo } from 'react';
import { SimMode } from '../hooks/useSimulation';
import { useT } from '../i18n';
import LangToggle from './LangToggle';
import * as api from '../services/api';

/**
 * LiveClock — 獨立元件每秒更新時鐘，避免帶動整個 StatusBar 重渲染。
 * 使用 memo 確保父元件狀態變更時不重渲染此元件。
 */
const LiveClock = memo(() => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span style={{ opacity: 0.4, fontSize: 10 }}>
      {now.toLocaleTimeString(undefined, { hour12: false })}
    </span>
  );
});

interface Position {
  lat: number;
  lng: number;
}

interface StatusBarProps {
  isConnected: boolean;
  deviceName: string;
  iosVersion: string;
  currentPosition: Position | null;
  speed: number | string;
  mode: SimMode;
  cooldown: number; // seconds remaining, 0 if inactive
  cooldownEnabled: boolean;
  cooldownDistanceKm?: number; // teleport distance that triggered current cooldown
  onToggleCooldown: (enabled: boolean) => void;
  onRestore?: () => void;
}

import type { StringKey } from '../i18n';
const modeLabelKeys: Record<SimMode, StringKey> = {
  [SimMode.Teleport]: 'mode.teleport',
  [SimMode.Navigate]: 'mode.navigate',
  [SimMode.Loop]: 'mode.loop',
  [SimMode.MultiStop]: 'mode.multi_stop',
  [SimMode.RandomWalk]: 'mode.random_walk',
  [SimMode.Joystick]: 'mode.joystick',
};

function formatCooldown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const StatusBar: React.FC<StatusBarProps> = ({
  isConnected,
  deviceName,
  iosVersion,
  currentPosition,
  speed,
  mode,
  cooldown,
  cooldownEnabled,
  cooldownDistanceKm = 0,
  onToggleCooldown,
  onRestore,
}) => {
  const t = useT();
  const [cooldownDisplay, setCooldownDisplay] = useState(cooldown);
  const lastServerCooldown = React.useRef(cooldown);
  const [copied, setCopied] = useState(false);
  const [homePos, setHomePos] = useState<{ lat: number; lng: number } | null>(null);
  const [homeSaved, setHomeSaved] = useState(false);

  // Load home position on mount
  useEffect(() => {
    api.getHomePosition().then(r => setHomePos(r.home_position)).catch(() => {});
  }, []);

  // ~10 m tolerance in decimal degrees (1° ≈ 111 km, so 0.0001° ≈ 11 m).
  // GPS jitter can shift the displayed position by up to ~1.5 m, so a 10 m
  // tolerance prevents the home button flickering "not set" after a jitter update.
  const isHomeSet =
    homePos !== null &&
    currentPosition !== null &&
    Math.abs(homePos.lat - currentPosition!.lat) < 0.0001 &&
    Math.abs(homePos.lng - currentPosition!.lng) < 0.0001;

  const handleSetHome = useCallback(async () => {
    if (!currentPosition) return;
    if (isHomeSet) {
      // Already home → clear it
      await api.clearHomePosition().catch(() => {});
      setHomePos(null);
    } else {
      await api.setHomePosition(currentPosition.lat, currentPosition.lng).catch(() => {});
      setHomePos({ lat: currentPosition.lat, lng: currentPosition.lng });
      setHomeSaved(true);
      setTimeout(() => setHomeSaved(false), 1500);
    }
  }, [currentPosition, isHomeSet]);

  // Sync from server value: accept if it differs by > 2 s from our local
  // counter (prevents the ±1 s stutter when the API poll overlaps the tick).
  useEffect(() => {
    const delta = Math.abs(cooldown - lastServerCooldown.current);
    lastServerCooldown.current = cooldown;
    if (cooldown <= 0 || delta > 2) {
      setCooldownDisplay(cooldown);
    }
  }, [cooldown]);

  // Local 1-second tick for smooth display
  useEffect(() => {
    if (cooldownDisplay <= 0) return;
    const timer = setTimeout(() => {
      setCooldownDisplay(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [cooldownDisplay]);

  return (
    <div
      className="status-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        rowGap: 4,
        columnGap: 16,
        padding: '6px 16px',
        fontSize: 12,
        color: '#c0c0c0',
        background: '#1a1a1e',
        borderTop: '1px solid #333',
        flexShrink: 0,
      }}
    >
      {/* Connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: isConnected ? '#4caf50' : '#f44336',
            boxShadow: isConnected ? '0 0 4px #4caf50' : '0 0 4px #f44336',
          }}
        />
        <span style={{ color: isConnected ? '#4caf50' : '#f44336', fontWeight: 500 }}>
          {isConnected ? t('status.connected') : t('status.disconnected')}
        </span>
      </div>

      {/* Separator */}
      <div style={{ width: 1, height: 14, background: '#333' }} />

      {/* Device name */}
      {deviceName && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5 }}>
              <rect x="5" y="2" width="14" height="20" rx="2" />
              <line x1="12" y1="18" x2="12" y2="18" />
            </svg>
            <span>{deviceName}</span>
          </div>
          <div style={{ width: 1, height: 14, background: '#333' }} />
        </>
      )}

      {/* iOS version */}
      {iosVersion && (
        <>
          <span style={{ opacity: 0.6 }}>iOS {iosVersion}</span>
          <div style={{ width: 1, height: 14, background: '#333' }} />
        </>
      )}

      {/* Current coordinates */}
      {currentPosition && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'monospace', fontSize: 11 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
            <span>{currentPosition.lat.toFixed(6)}, {currentPosition.lng.toFixed(6)}</span>
            <button
              onClick={() => {
                const txt = `${currentPosition.lat.toFixed(6)}, ${currentPosition.lng.toFixed(6)}`;
                navigator.clipboard.writeText(txt).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
                setTimeout(() => setCopied(false), 1500);
              }}
              title={t('status.copy_coord')}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '0 4px', color: copied ? '#4caf50' : 'rgba(255,255,255,0.6)',
                display: 'inline-flex', alignItems: 'center',
              }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              )}
            </button>
            {/* Home position button */}
            <button
              onClick={handleSetHome}
              title={isHomeSet ? '取消固定起始位置' : homeSaved ? '已設定！' : '設為起始位置（每次啟動從此處開始）'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '0 4px',
                color: isHomeSet ? '#ff9800' : homeSaved ? '#4caf50' : 'rgba(255,255,255,0.45)',
                display: 'inline-flex', alignItems: 'center',
                transition: 'color 0.2s',
              }}
            >
              {homeSaved && !isHomeSet ? (
                /* tick flash */
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                /* house icon — filled if this position is the pinned home */
                <svg width="12" height="12" viewBox="0 0 24 24" fill={isHomeSet ? '#ff9800' : 'none'} stroke={isHomeSet ? '#ff9800' : 'currentColor'} strokeWidth="2">
                  <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
                  <polyline points="9,21 9,12 15,12 15,21" />
                </svg>
              )}
            </button>
          </div>
          <div style={{ width: 1, height: 14, background: '#333' }} />
        </>
      )}

      {/* Speed + Mode */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5 }}>
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        <span>{speed} km/h</span>
        <span style={{ opacity: 0.4 }}>|</span>
        <span style={{ opacity: 0.7 }}>{t(modeLabelKeys[mode])}</span>
      </div>

      {/* Force wrap to a second row here */}
      <div style={{ flexBasis: '100%', height: 0 }} />

      {/* Cooldown enable toggle */}
      <label
        title={t('status.cooldown_tooltip')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
      >
        <input
          type="checkbox"
          checked={cooldownEnabled}
          onChange={(e) => onToggleCooldown(e.target.checked)}
          style={{ cursor: 'pointer', margin: 0 }}
        />
        <span style={{ opacity: cooldownEnabled ? 1 : 0.5 }}>{cooldownEnabled ? t('status.cooldown_enabled') : t('status.cooldown_disabled')}</span>
      </label>

      {/* Restore button */}
      {onRestore && (
        <>
          <div style={{ width: 1, height: 14, background: '#333' }} />
          <button
            onClick={onRestore}
            title={t('status.restore_tooltip')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              fontSize: 12,
              background: 'rgba(108, 140, 255, 0.15)',
              border: '1px solid rgba(108, 140, 255, 0.4)',
              color: '#6c8cff',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 109-9" />
              <polyline points="3,3 3,9 9,9" />
            </svg>
            {t('status.restore')}
          </button>
        </>
      )}

      {/* Cooldown timer */}
      {cooldownDisplay > 0 && (
        <>
          <div style={{ width: 1, height: 14, background: '#333' }} />
          <div
            title={cooldownDistanceKm > 0 ? `傳送距離 ${cooldownDistanceKm.toFixed(0)} km` : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: '#ff9800',
              fontWeight: 600,
              cursor: cooldownDistanceKm > 0 ? 'help' : 'default',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ff9800" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
            <span>{t('status.cooldown_active')} {formatCooldown(cooldownDisplay)}</span>
            {cooldownDistanceKm > 0 && (
              <span style={{ fontSize: 10, opacity: 0.65, fontWeight: 400 }}>
                ({cooldownDistanceKm.toFixed(0)} km)
              </span>
            )}
          </div>
        </>
      )}

      {/* Spacer to push right-aligned items */}
      <div style={{ flex: 1 }} />

      {/* Language toggle */}
      <LangToggle />
      <div style={{ width: 1, height: 14, background: '#333' }} />

      {/* Live clock — 獨立元件，避免每秒帶動整個 StatusBar 重渲染 */}
      <LiveClock />
    </div>
  );
};

export default StatusBar;
