import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SimMode } from '../hooks/useSimulation';
import type { RuntimesMap } from '../hooks/useSimulation';
import type { DeviceInfo } from '../hooks/useDevice';
import { useT } from '../i18n';
import LangToggle from './LangToggle';
import PhoneControlButton from './PhoneControl';
import SettingsModal from './SettingsModal';
import pkg from '../../package.json';
import { WeatherIcon, categorize, labelKeyFor } from './WeatherIcon';
import { useUpdateCheck } from './UpdateChecker';

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
  onOpenSettings?: () => void;
  onOpenAvatarPicker?: () => void;
  // "Locate PC" button: detects this PC's lat/lng via the browser
  // geolocation API (Wi-Fi positioning under the hood), then asks the
  // user to either teleport the iPhone there or just pan the map.
  onLocatePcFly?: (lat: number, lng: number) => void;
  onLocatePcPanOnly?: (lat: number, lng: number) => void;
  // Group mode: when two devices are connected, cooldown toggle is force-off
  // and displays a different tooltip. Does not modify the saved setting.
  dualDevice?: boolean;
  runtimes?: RuntimesMap;
  devices?: DeviceInfo[];
  countryCode?: string;  // ISO 3166-1 alpha-2 lowercase, for flag icon
  // Reverse-geocoded city / POI name from short_name. Empty when the
  // lookup hasn't returned yet (or fired into the ocean). Surfaced in
  // the timezone-detail modal alongside the country name.
  cityName?: string;
  // Weather at the current virtual location (Open-Meteo). null = unknown.
  weatherCode?: number | null;
  tempC?: number | null;
  // Destination timezone, populated from the same reverse-geocode/timezone
  // pipeline that fills countryCode/weather. Used to render the trailing
  // "+1h JST · 16:42" chip when the virtual location's GMT offset differs
  // from the user's local offset by at least one hour. Null = unknown / no
  // timezone resolved yet for the current position.
  timezoneZone?: string | null;
  gmtOffsetSeconds?: number | null;
}

function stateToMode(state: string): SimMode | null {
  switch (state) {
    case 'navigating': return SimMode.Navigate;
    case 'looping': return SimMode.Loop;
    // Single-pass (0 圈) runs on the multi_stop backend but is the merged
    // 多點路徑 mode in the UI, so show the Loop label.
    case 'multi_stop': return SimMode.Loop;
    case 'random_walk': return SimMode.RandomWalk;
    case 'flower': return SimMode.Flower;
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
  [SimMode.RandomWalk]: 'mode.random_walk',
  [SimMode.Joystick]: 'mode.joystick',
  [SimMode.GoldDitto]: 'mode.goldditto',
  [SimMode.Flower]: 'mode.flower',
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
  onOpenSettings,
  onOpenAvatarPicker,
  onLocatePcFly,
  onLocatePcPanOnly,
  dualDevice = false,
  runtimes,
  devices,
  countryCode = '',
  cityName = '',
  weatherCode = null,
  tempC = null,
  timezoneZone = null,
  gmtOffsetSeconds = null,
}) => {
  const t = useT();
  const { latest: updateLatest, releaseUrl: updateUrl } = useUpdateCheck();
  const [cooldownDisplay, setCooldownDisplay] = useState(cooldown);
  // Tick every second so the right-side clock and the destination-timezone
  // chip both stay live. Without this React only re-renders StatusBar when
  // a parent prop changes (position update, mode swap, etc.), so the time
  // text would freeze whenever the user wasn't actively moving the map.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const [copied, setCopied] = useState(false);
  // Initial-position dialog state (React modal replaces unavailable
  // native window.prompt which Electron does not support).

  // Timezone-detail modal: opened by clicking the trailing tz chip in the
  // status bar. Shows the localized full zone name + IANA id + diff +
  // destination wall-clock + place. Replaces the v0.2.127 popup toast
  // (the chip itself replaces the at-a-glance summary the toast used to
  // give); user-discoverable so the chip is now the entry point to the
  // detail.
  const [tzModalOpen, setTzModalOpen] = useState(false);

  // Settings panel (v0.2.130). Opens from the trailing settings button
  // next to the avatar/map-pin chip. Hosts the route-completion alert
  // toggle today; structured for future per-user preferences.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Locate-PC flow: button fires browser geolocation, then this dialog
  // confirms whether the user wants to teleport the iPhone or just pan
  // the map view. Errors (denied / unavailable / timeout) surface in
  // the same dialog body so the user can read them before dismissing.
  const [locatePcOpen, setLocatePcOpen] = useState(false);
  const [locatePcBusy, setLocatePcBusy] = useState(false);
  const [locatePcResult, setLocatePcResult] = useState<{ lat: number; lng: number; accuracy: number; via: string } | null>(null);
  const [locatePcError, setLocatePcError] = useState<string | null>(null);

  const handleLocatePcClick = async () => {
    setLocatePcOpen(true);
    setLocatePcResult(null);
    setLocatePcError(null);
    setLocatePcBusy(true);

    const api = (typeof window !== 'undefined') ? window.electronAPI : undefined;
    if (!api?.locatePc) {
      setLocatePcError('electronAPI.locatePc unavailable (preload missing)');
      setLocatePcBusy(false);
      return;
    }
    try {
      const r = await api.locatePc();
      setLocatePcBusy(false);
      if (r.ok && r.lat != null && r.lng != null) {
        setLocatePcResult({
          lat: r.lat,
          lng: r.lng,
          accuracy: r.accuracy ?? 100,
          via: r.via ?? 'unknown',
        });
        return;
      }
      if (r.code === 'DENIED') {
        setLocatePcError(t('status.locate_pc_denied'));
        return;
      }
      setLocatePcError(`${r.code ?? 'ERROR'}${r.message ? ': ' + r.message : ''}`);
    } catch (e: any) {
      setLocatePcBusy(false);
      setLocatePcError(`IPC error: ${e?.message || e}`);
    }
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
      {/* Connection / device name / iOS version + per-device A/B/C pills
          removed from the bottom bar — the left-side DeviceStatus panel
          already shows all of this, so repeating it here only ate
          horizontal space. */}

      {/* Weather chip. Shows current conditions at the virtual location
          with an animated icon. Renders in both single and dual mode
          (dual devices share one coordinate). */}
      {currentPosition && weatherCode != null && tempC != null && (() => {
        const cat = categorize(weatherCode);
        if (!cat) return null;
        const labelKey = labelKeyFor(cat);
        const label = labelKey ? t(labelKey) : '';
        return (
          <div
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 8px', borderRadius: 999,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontSize: 11, fontFamily: 'monospace',
            }}
            title={`${label} · ${tempC.toFixed(1)}°C`}
          >
            <WeatherIcon cat={cat} size={14} />
            <span>{Math.round(tempC)}°C</span>
            <span style={{ opacity: 0.75 }}>{label}</span>
          </div>
        );
      })()}

      {/* Current coordinates. Rendered in both single and dual modes
          because group mode keeps both iPhones on the same coordinate. */}
      {currentPosition && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'monospace', fontSize: 11 }}>
            {countryCode ? (
              <img
                src={`https://flagcdn.com/w40/${countryCode}.png`}
                alt={countryCode.toUpperCase()}
                title={countryCode.toUpperCase()}
                width={18}
                height={12}
                style={{ borderRadius: 2, boxShadow: '0 0 0 1px rgba(255,255,255,0.15)' }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5 }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
              </svg>
            )}
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

      {/* Speed + Mode. Rendered in both single and dual modes. */}
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

      {/* Destination timezone chip. Replaces the old toast (v0.2.128) — only
          shows when the virtual location's GMT offset differs from the
          user's local offset by >=1 hour. Time portion ticks live thanks
          to the `now` state above. Date + weekday + time are all derived
          from the destination timezone via Intl, so daylight savings and
          midnight rollovers are handled by the runtime. */}
      {timezoneZone && gmtOffsetSeconds != null && (() => {
        const localOffsetSec = -now.getTimezoneOffset() * 60;
        const diffSec = gmtOffsetSeconds - localOffsetSec;
        if (Math.abs(diffSec) < 3600) return null;
        const diffH = Math.round(diffSec / 3600);
        const sign = diffH >= 0 ? '+' : '';
        const lang = (typeof localStorage !== 'undefined' && localStorage.getItem('locwarp.lang') === 'en') ? 'en' : 'zh-TW';
        let timeStr = '';
        let zoneAbbr = timezoneZone;
        let dateStr = '';
        let weekdayStr = '';
        try {
          timeStr = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezoneZone,
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
          }).format(now);
        } catch { /* leave blank */ }
        try {
          // zh-TW with month: 'numeric' renders "5/8"; en with month: 'short'
          // renders "May 8". Both are compact enough for the status bar.
          dateStr = new Intl.DateTimeFormat(lang, {
            timeZone: timezoneZone,
            month: lang === 'en' ? 'short' : 'numeric',
            day: 'numeric',
          }).format(now);
        } catch { /* skip */ }
        try {
          weekdayStr = new Intl.DateTimeFormat(lang, {
            timeZone: timezoneZone,
            weekday: 'short',
          }).format(now);
        } catch { /* skip */ }
        try {
          const parts = new Intl.DateTimeFormat('en', {
            timeZone: timezoneZone, timeZoneName: 'short',
          }).formatToParts(now);
          const named = parts.find((p) => p.type === 'timeZoneName')?.value;
          if (named) zoneAbbr = named;
        } catch { /* keep IANA id */ }
        const dateBlock = [dateStr, weekdayStr].filter(Boolean).join(' ');
        return (
          <>
            <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
            <button
              onClick={() => setTzModalOpen(true)}
              title={t('tz.detail_tooltip')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '3px 8px', borderRadius: 999,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'inherit',
                fontSize: 11, fontFamily: 'monospace',
                cursor: 'pointer',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
                <circle cx="12" cy="12" r="10" />
                <polyline points="12,6 12,12 16,14" />
              </svg>
              <span style={{ fontWeight: 600 }}>{sign}{diffH}h</span>
              <span style={{ opacity: 0.75 }}>{zoneAbbr}</span>
              {dateBlock && <span style={{ opacity: 0.75 }}>{dateBlock}</span>}
              {timeStr && <span style={{ opacity: 0.85 }}>{timeStr}</span>}
            </button>
          </>
        );
      })()}

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
          {/* Log 資料夾 + 起始地圖位置 moved to the Settings page (issue #34). */}
          {/* Locate PC: detect this PC's lat/lng (Wi-Fi positioning) */}
          {(onLocatePcFly || onLocatePcPanOnly) && (
            <button
              onClick={handleLocatePcClick}
              title={t('status.locate_pc_tooltip')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                fontSize: 12,
                background: 'rgba(244, 143, 177, 0.12)',
                border: '1px solid rgba(244, 143, 177, 0.4)',
                color: '#f48fb1',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="2" x2="12" y2="5" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="2" y1="12" x2="5" y2="12" />
                <line x1="19" y1="12" x2="22" y2="12" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              {t('status.locate_pc')}
            </button>
          )}
          {/* 手機操控 — opens the phone-control pairing modal */}
          <PhoneControlButton />
          {/* 地圖釘 / 使用者頭像 — opens the avatar picker panel */}
          {onOpenAvatarPicker && (
            <button
              onClick={onOpenAvatarPicker}
              title={t('status.avatar_tooltip')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                fontSize: 12,
                background: 'rgba(108, 140, 255, 0.12)',
                border: '1px solid rgba(108, 140, 255, 0.4)',
                color: '#6c8cff',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              {t('status.avatar')}
            </button>
          )}
          {/* 設定 moved to the top navigation bar's 設定 tab (issue #34). */}
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
          {now.toLocaleTimeString(undefined, { hour12: false })}
        </span>
        <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.12)' }} />
        {updateLatest && updateUrl ? (
          <a
            href={updateUrl}
            target="_blank"
            rel="noreferrer"
            title={t('update.title')}
            onClick={(e) => {
              try {
                const anyWin: any = window;
                if (anyWin.locwarp?.openExternal) {
                  e.preventDefault();
                  anyWin.locwarp.openExternal(updateUrl);
                }
              } catch { /* fall back to default link nav */ }
            }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '1px 4px', borderRadius: 4,
              textDecoration: 'none', cursor: 'pointer',
            }}
          >
            <span className="lw-update-pill">NEW</span>
            <span style={{
              fontSize: 10, opacity: 0.7, fontFamily: 'monospace',
              color: '#e8eaf0',
            }}>
              v{APP_VERSION}
            </span>
          </a>
        ) : (
          <span style={{ fontSize: 10, opacity: 0.45, fontFamily: 'monospace' }}>
            v{APP_VERSION}
          </span>
        )}
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {tzModalOpen && timezoneZone && gmtOffsetSeconds != null && createPortal((() => {
        const localOffsetSec = -now.getTimezoneOffset() * 60;
        const diffSec = gmtOffsetSeconds - localOffsetSec;
        const diffH = Math.round(diffSec / 3600);
        const sign = diffH >= 0 ? '+' : '';
        const lang = (typeof localStorage !== 'undefined' && localStorage.getItem('locwarp.lang') === 'en') ? 'en' : 'zh-TW';
        let zoneFullName = timezoneZone;
        let timeStr = '';
        let dateStr = '';
        let weekdayStr = '';
        let countryName = '';
        try {
          const parts = new Intl.DateTimeFormat(lang, { timeZone: timezoneZone, timeZoneName: 'long' }).formatToParts(now);
          const named = parts.find((p) => p.type === 'timeZoneName')?.value;
          if (named) zoneFullName = named;
        } catch { /* keep IANA id */ }
        try {
          timeStr = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezoneZone,
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
          }).format(now);
        } catch { /* skip */ }
        try {
          dateStr = new Intl.DateTimeFormat(lang, {
            timeZone: timezoneZone,
            year: 'numeric', month: 'long', day: 'numeric',
          }).format(now);
        } catch { /* skip */ }
        try {
          weekdayStr = new Intl.DateTimeFormat(lang, {
            timeZone: timezoneZone, weekday: 'long',
          }).format(now);
        } catch { /* skip */ }
        if (countryCode) {
          try {
            countryName = new Intl.DisplayNames([lang], { type: 'region' }).of(countryCode.toUpperCase()) ?? '';
          } catch { /* skip */ }
        }
        const place = [countryName, cityName].filter(Boolean).join(' ');
        const dateLine = [dateStr, weekdayStr].filter(Boolean).join(' · ');
        const rowLabelStyle: React.CSSProperties = {
          fontSize: 11, opacity: 0.55, marginBottom: 3, letterSpacing: '0.02em',
        };
        const rowValueStyle: React.CSSProperties = {
          fontSize: 13, color: '#e8eaf0', lineHeight: 1.45,
        };
        return (
          <div
            onClick={() => setTzModalOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 2000,
              background: 'rgba(8, 10, 20, 0.55)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 360, position: 'relative',
                background: 'rgba(26, 29, 39, 0.96)',
                border: '1px solid rgba(108, 140, 255, 0.25)', borderRadius: 12,
                padding: '22px 24px', color: '#e8eaf0',
                boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65)',
              }}
            >
              {/* Top-right close button. Stays in the corner so it doesn't
                  push the content down. */}
              <button
                onClick={() => setTzModalOpen(false)}
                title={t('generic.close')}
                aria-label={t('generic.close')}
                style={{
                  position: 'absolute', top: 10, right: 10,
                  width: 26, height: 26, borderRadius: 6,
                  background: 'transparent', border: 'none',
                  color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, paddingRight: 28 }}>
                {t('tz.modal_title')}
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={rowLabelStyle}>{t('tz.zone_label')}</div>
                <div style={rowValueStyle}>{zoneFullName}</div>
                <div style={{ fontSize: 11, opacity: 0.45, fontFamily: 'monospace', marginTop: 1 }}>{timezoneZone}</div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={rowLabelStyle}>{t('tz.offset_label')}</div>
                <div style={rowValueStyle}>{sign}{diffH}h</div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={rowLabelStyle}>{t('tz.local_now_label')}</div>
                <div style={rowValueStyle}>{timeStr}</div>
                {dateLine && <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{dateLine}</div>}
              </div>

              {place && (
                <div>
                  <div style={rowLabelStyle}>{t('tz.location_label')}</div>
                  <div style={rowValueStyle}>{place}</div>
                </div>
              )}
            </div>
          </div>
        );
      })(), document.body)}

      {locatePcOpen && createPortal((
        <div
          onClick={() => { if (!locatePcBusy) { setLocatePcOpen(false); setLocatePcResult(null); setLocatePcError(null); } }}
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(8, 10, 20, 0.55)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 380, background: 'rgba(26, 29, 39, 0.96)',
              border: '1px solid rgba(244, 143, 177, 0.3)', borderRadius: 12,
              padding: 22, color: '#e8eaf0',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65)',
              fontSize: 13,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
              {t('status.locate_pc_dialog_title')}
            </div>
            {locatePcBusy && (
              <div style={{ fontSize: 12, opacity: 0.75, padding: '12px 0' }}>
                {t('status.locate_pc_busy')}
              </div>
            )}
            {locatePcError && (
              <div style={{ fontSize: 12, color: '#ff7a8a', padding: '8px 0', lineHeight: 1.6 }}>
                {locatePcError}
              </div>
            )}
            {locatePcResult && (
              <>
                <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6, fontFamily: 'monospace' }}>
                  {locatePcResult.lat.toFixed(6)}, {locatePcResult.lng.toFixed(6)}
                </div>
                <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>
                  {t('status.locate_pc_accuracy').replace('{m}', Math.round(locatePcResult.accuracy).toString())}
                </div>
                <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 14 }}>
                  {t(locatePcResult.via === 'windows' ? 'status.locate_pc_source_wifi' : 'status.locate_pc_source_ip')}
                  {locatePcResult.via !== 'windows' && ` · ${locatePcResult.via}`}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {onLocatePcFly && (
                    <button
                      onClick={() => {
                        if (!locatePcResult) return;
                        // Pan the map first (synchronous, <1 frame) so the
                        // user sees the view snap to PC location
                        // immediately. Then fire teleport in parallel:
                        // the backend round-trip + websocket
                        // position_update would otherwise leave the
                        // map frozen for ~1s, and even after that the
                        // map-view recenter only kicks in on jumps > 500m.
                        onLocatePcPanOnly?.(locatePcResult.lat, locatePcResult.lng);
                        onLocatePcFly(locatePcResult.lat, locatePcResult.lng);
                        setLocatePcOpen(false);
                        setLocatePcResult(null);
                      }}
                      style={{
                        padding: '10px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                        background: '#6c8cff', color: '#fff',
                        border: 'none', borderRadius: 8, textAlign: 'left',
                      }}
                    >
                      {t('status.locate_pc_fly')}
                    </button>
                  )}
                  {onLocatePcPanOnly && (
                    <button
                      onClick={() => {
                        if (!locatePcResult) return;
                        onLocatePcPanOnly(locatePcResult.lat, locatePcResult.lng);
                        setLocatePcOpen(false);
                        setLocatePcResult(null);
                      }}
                      style={{
                        padding: '10px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                        background: 'rgba(108, 140, 255, 0.15)', color: '#a8b8ff',
                        border: '1px solid rgba(108, 140, 255, 0.4)', borderRadius: 8, textAlign: 'left',
                      }}
                    >
                      {t('status.locate_pc_pan_only')}
                    </button>
                  )}
                </div>
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button
                onClick={() => { setLocatePcOpen(false); setLocatePcResult(null); setLocatePcError(null); }}
                disabled={locatePcBusy}
                style={{
                  padding: '6px 14px', fontSize: 12, cursor: locatePcBusy ? 'not-allowed' : 'pointer',
                  background: 'transparent', color: '#9499ac',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6,
                  opacity: locatePcBusy ? 0.6 : 1,
                }}
              >{t('generic.cancel')}</button>
            </div>
          </div>
        </div>
      ), document.body)}

    </div>
  );
};

export default StatusBar;
