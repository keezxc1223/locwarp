import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SimMode } from '../hooks/useSimulation';
import type { RuntimesMap } from '../hooks/useSimulation';
import type { DeviceInfo } from '../hooks/useDevice';
import { useT } from '../i18n';
import LangToggle from './LangToggle';
import pkg from '../../package.json';

const DEVICE_COLORS = ['#4285f4', '#ff9800'];
const DEVICE_LETTERS = ['A', 'B'];

const APP_VERSION = (pkg as { version: string }).version;

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
  onOpenLog?: () => void;
  // Group mode: when two devices are connected, cooldown toggle is force-off
  // and displays a different tooltip. Does not modify the saved setting.
  dualDevice?: boolean;
  runtimes?: RuntimesMap;
  devices?: DeviceInfo[];
}

function stateToMode(state: string): SimMode | null {
  switch (state) {
    case 'navigating': return SimMode.Navigate;
    case 'looping': return SimMode.Loop;
    case 'multi_stop': return SimMode.MultiStop;
    case 'random_walk': return SimMode.RandomWalk;
    case 'joystick': return SimMode.Joystick;
    case 'teleport':
    case 'idle':
    default: return null;
  }
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
  onOpenLog,
  dualDevice = false,
  runtimes,
  devices,
}) => {
  const t = useT();
  const [cooldownDisplay, setCooldownDisplay] = useState(cooldown);
  const [copied, setCopied] = useState(false);
  // Initial-position dialog state (React modal replaces unavailable
  // native window.prompt which Electron does not support).
  const [initialDialogOpen, setInitialDialogOpen] = useState(false);
  const [initialDialogValue, setInitialDialogValue] = useState('');
  const [initialDialogError, setInitialDialogError] = useState<string | null>(null);
  const [initialDialogBusy, setInitialDialogBusy] = useState(false);

  const handleInitialDialogSave = async () => {
    const { setInitialPosition } = await import('../services/api');
    const trimmed = initialDialogValue.trim();
    setInitialDialogError(null);
    if (trimmed === '') {
      setInitialDialogBusy(true);
      try {
        await setInitialPosition(null, null);
        setInitialDialogOpen(false);
      } catch (e: any) {
        setInitialDialogError(e?.message || 'error');
      } finally { setInitialDialogBusy(false); }
      return;
    }
    const m = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) {
      setInitialDialogError(t('status.set_initial_invalid'));
      return;
    }
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setInitialDialogError(t('status.set_initial_invalid'));
      return;
    }
    setInitialDialogBusy(true);
    try {
      await setInitialPosition(lat, lng);
      setInitialDialogOpen(false);
    } catch (e: any) {
      setInitialDialogError(e?.message || 'error');
    } finally { setInitialDialogBusy(false); }
  };

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
        position: 'absolute',
        bottom: 10,
        left: 10,
        right: 10,
        zIndex: 850,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        rowGap: 4,
        columnGap: 12,
        padding: '6px 16px',
        fontSize: 12,
        color: '#c7cbd9',
        background: 'rgba(18, 21, 32, 0.72)',
        backdropFilter: 'blur(24px) saturate(160%)',
        WebkitBackdropFilter: 'blur(24px) saturate(160%)',
        border: '1px solid rgba(108, 140, 255, 0.18)',
        borderRadius: 18,
        boxShadow:
          '0 14px 36px rgba(12, 18, 40, 0.48), 0 2px 8px rgba(12, 18, 40, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
        letterSpacing: '-0.005em',
      }}
    >
      {/* Connection / device name / iOS version removed from the bottom bar —
          the left-side DeviceStatus panel already shows all of this, so
          repeating it here only ate horizontal space. */}

      {/* Dual-device pills */}
      {dualDevice && devices && runtimes && devices.slice(0, 2).map((dev, i) => {
        const rt = runtimes[dev.udid];
        const color = DEVICE_COLORS[i];
        const letter = DEVICE_LETTERS[i];
        const coord = rt?.currentPos
          ? `${rt.currentPos.lat.toFixed(4)},${rt.currentPos.lng.toFixed(4)}`
          : '—';
        const spd = rt?.currentSpeedKmh ? rt.currentSpeedKmh.toFixed(0) : String(speed);
        const dMode = rt ? stateToMode(rt.state) : null;
        const modeLabel = dMode ? t(modeLabelKeys[dMode]) : t(modeLabelKeys[mode]);
        return (
          <div
            key={dev.udid}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.04)',
              fontFamily: 'monospace', fontSize: 11,
            }}
            title={dev.name}
          >
            <span style={{ color, fontWeight: 700 }}>{letter}</span>
            <span>{coord}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{spd}km/h</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ opacity: 0.75 }}>{modeLabel}</span>
          </div>
        );
      })}
      {dualDevice && <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />}

      {/* Current coordinates (single-device mode only) */}
      {!dualDevice && currentPosition && (
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
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
        </>
      )}

      {/* Speed + Mode (single-device mode only) */}
      {!dualDevice && <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5 }}>
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        <span>{speed} km/h</span>
        <span style={{ opacity: 0.4 }}>|</span>
        <span style={{ opacity: 0.7 }}>{t(modeLabelKeys[mode])}</span>
      </div>}

      {/* Force wrap to a second row here */}
      <div style={{ flexBasis: '100%', height: 0 }} />

      {/* Cooldown enable toggle */}
      <label
        title={dualDevice ? t('status.cooldown_dual_disabled') : t('status.cooldown_tooltip')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: dualDevice ? 'not-allowed' : 'pointer', userSelect: 'none', opacity: dualDevice ? 0.55 : 1 }}
      >
        <input
          type="checkbox"
          checked={dualDevice ? false : cooldownEnabled}
          disabled={dualDevice}
          onChange={(e) => { if (!dualDevice) onToggleCooldown(e.target.checked) }}
          style={{ cursor: dualDevice ? 'not-allowed' : 'pointer', margin: 0 }}
        />
        <span style={{ opacity: (dualDevice || !cooldownEnabled) ? 0.5 : 1 }}>{(dualDevice || !cooldownEnabled) ? t('status.cooldown_disabled') : t('status.cooldown_enabled')}</span>
      </label>

      {/* Restore button */}
      {onRestore && (
        <>
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
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
            {dualDevice ? t('status.restore_all') : t('status.restore')}
          </button>
          {onOpenLog && (
            <button
              onClick={onOpenLog}
              title={t('status.open_log_tooltip')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                fontSize: 12,
                background: 'rgba(255, 193, 7, 0.12)',
                border: '1px solid rgba(255, 193, 7, 0.4)',
                color: '#ffc107',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="16" y2="17" />
              </svg>
              {t('status.open_log')}
            </button>
          )}
          {/* Set initial map position (persisted in backend settings.json) */}
          <button
            onClick={async () => {
              const { getInitialPosition } = await import('../services/api');
              try {
                const res = await getInitialPosition();
                setInitialDialogValue(res.position ? `${res.position.lat}, ${res.position.lng}` : '');
              } catch { setInitialDialogValue(''); }
              setInitialDialogError(null);
              setInitialDialogOpen(true);
            }}
            title={t('status.set_initial_tooltip')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              fontSize: 12,
              background: 'rgba(78, 205, 196, 0.12)',
              border: '1px solid rgba(78, 205, 196, 0.4)',
              color: '#4ecdc4',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {t('status.set_initial')}
          </button>
        </>
      )}

      {/* Cooldown timer */}
      {cooldownDisplay > 0 && (
        <>
          <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
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

      {/* Right cluster: lang toggle · time · version, all inline. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <LangToggle />
        <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.12)' }} />
        <span style={{ opacity: 0.4, fontSize: 10 }}>
          {new Date().toLocaleTimeString(undefined, { hour12: false })}
        </span>
        <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.12)' }} />
        <span style={{ fontSize: 10, opacity: 0.45, fontFamily: 'monospace' }}>
          v{APP_VERSION}
        </span>
      </div>

      {initialDialogOpen && createPortal((
        <div
          onClick={() => { if (!initialDialogBusy) setInitialDialogOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(8, 10, 20, 0.55)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 360, background: 'rgba(26, 29, 39, 0.96)',
              border: '1px solid rgba(108, 140, 255, 0.25)', borderRadius: 12,
              padding: 22, color: '#e8eaf0',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65)',
              fontSize: 13,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              {t('status.set_initial')}
            </div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 12, lineHeight: 1.5 }}>
              {t('status.set_initial_prompt')}
            </div>
            <input
              type="text"
              value={initialDialogValue}
              onChange={(e) => { setInitialDialogValue(e.target.value); setInitialDialogError(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !initialDialogBusy) handleInitialDialogSave();
                if (e.key === 'Escape' && !initialDialogBusy) setInitialDialogOpen(false);
              }}
              autoFocus
              placeholder="25.033, 121.564"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'rgba(10, 12, 18, 0.7)',
                border: '1px solid rgba(108, 140, 255, 0.3)',
                borderRadius: 6, color: '#e8eaf0',
                padding: '8px 10px', fontFamily: 'monospace', fontSize: 13,
                outline: 'none',
              }}
            />
            {initialDialogError && (
              <div style={{ color: '#ff4757', fontSize: 11, marginTop: 8 }}>{initialDialogError}</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setInitialDialogOpen(false)}
                disabled={initialDialogBusy}
                style={{
                  padding: '6px 14px', fontSize: 12, cursor: 'pointer',
                  background: 'transparent', color: '#9499ac',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6,
                }}
              >{t('generic.cancel')}</button>
              <button
                onClick={handleInitialDialogSave}
                disabled={initialDialogBusy}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: '#6c8cff', color: '#fff',
                  border: 'none', borderRadius: 6,
                  opacity: initialDialogBusy ? 0.6 : 1,
                }}
              >{t('generic.save')}</button>
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
};

export default StatusBar;
