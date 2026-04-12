import React, { useEffect, useState } from 'react';
import { SimMode } from '../hooks/useSimulation';
import { useT } from '../i18n';
import LangToggle from './LangToggle';

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
  onToggleCooldown,
  onRestore,
}) => {
  const t = useT();
  const [cooldownDisplay, setCooldownDisplay] = useState(cooldown);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCooldownDisplay(cooldown);
    if (cooldown <= 0) return;

    const interval = setInterval(() => {
      setCooldownDisplay((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [cooldown]);

  return (
    <div
      className="status-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
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
          {isConnected ? '已連線' : '未連線'}
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

      {/* Cooldown enable toggle */}
      <div style={{ width: 1, height: 14, background: '#333' }} />
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
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: '#ff9800',
              fontWeight: 600,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ff9800" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
            <span>{t('status.cooldown_active')} {formatCooldown(cooldownDisplay)}</span>
          </div>
        </>
      )}

      {/* Spacer to push right-aligned items */}
      <div style={{ flex: 1 }} />

      {/* Language toggle */}
      <LangToggle />
      <div style={{ width: 1, height: 14, background: '#333' }} />

      {/* Timestamp */}
      <span style={{ opacity: 0.4, fontSize: 10 }}>
        {new Date().toLocaleTimeString()}
      </span>
    </div>
  );
};

export default StatusBar;
