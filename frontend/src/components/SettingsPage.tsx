import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import {
  isAlertSoundEnabled,
  setAlertSoundEnabled,
  playCompletionAlert,
} from '../services/alertSound';
import { getInitialPosition, setInitialPosition } from '../services/api';
import { useUpdateCheck } from './UpdateChecker';
import type { RenderMode, RenderModeInfo } from '../types/electron';

interface Props {
  onOpenLogFolder: () => void;
  // Fires the AMFI "reveal Developer Mode" request against the connected
  // iPhone. App resolves the target device + surfaces a toast if none is
  // connected. Lives here permanently (not gated on dev-mode state) so the
  // option is always reachable from 設定.
  onEnableDeveloperMode: () => void | Promise<void>;
}

// iOS-style switch: a pill that slides. Pure CSS via .ios-switch classes.
const IosSwitch: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={`ios-switch${checked ? ' on' : ''}`}
    onClick={() => onChange(!checked)}
  >
    <span className="ios-switch-knob" />
  </button>
);

const Chevron: React.FC = () => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
    style={{ opacity: 0.4, flexShrink: 0 }}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

const Help: React.FC<{ title: string }> = ({ title }) => (
  <span className="ios-help" title={title} aria-label={title}>?</span>
);

/**
 * Settings page rendered as the "設定" tab of the left navigation rail.
 * Uses iOS-style grouped inset cards. Hosts the genuinely set-once options;
 * frequently-changed controls (path source, geocode provider, connection
 * toggles) deliberately stay in their contextual pages.
 */
const SettingsPage: React.FC<Props> = ({ onOpenLogFolder, onEnableDeveloperMode }) => {
  const t = useT();
  const [alertEnabled, setAlertEnabled] = useState<boolean>(() => isAlertSoundEnabled());
  const [devModeBusy, setDevModeBusy] = useState(false);
  const [renderInfo, setRenderInfo] = useState<RenderModeInfo | null>(null);
  const [renderDirty, setRenderDirty] = useState(false);
  const update = useUpdateCheck();

  // Startup map view (起始地圖位置) — moved here from the status bar.
  const [initOpen, setInitOpen] = useState(false);
  const [initVal, setInitVal] = useState('');
  const [initErr, setInitErr] = useState<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);

  const openInitial = async () => {
    try {
      const res = await getInitialPosition();
      setInitVal(res.position ? `${res.position.lat}, ${res.position.lng}` : '');
    } catch { setInitVal(''); }
    setInitErr(null);
    setInitOpen(true);
  };
  const saveInitial = async () => {
    const trimmed = initVal.trim();
    setInitErr(null);
    if (trimmed === '') {
      setInitBusy(true);
      try { await setInitialPosition(null, null); setInitOpen(false); }
      catch (e: any) { setInitErr(e?.message || 'error'); }
      finally { setInitBusy(false); }
      return;
    }
    const m = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) { setInitErr(t('status.set_initial_invalid')); return; }
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setInitErr(t('status.set_initial_invalid')); return;
    }
    setInitBusy(true);
    try { await setInitialPosition(lat, lng); setInitOpen(false); }
    catch (e: any) { setInitErr(e?.message || 'error'); }
    finally { setInitBusy(false); }
  };

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getRenderMode) return;
    api.getRenderMode().then((info) => {
      setRenderInfo(info);
      setRenderDirty(false);
    }).catch(() => { /* non-Electron context */ });
  }, []);

  const handleAlert = (next: boolean) => {
    setAlertEnabled(next);
    setAlertSoundEnabled(next);
  };
  const handleRender = async (hardware: boolean) => {
    const api = window.electronAPI;
    if (!api?.setRenderMode) return;
    const next: RenderMode = hardware ? 'hardware' : 'software';
    await api.setRenderMode(next);
    setRenderInfo((prev) => prev ? { ...prev, mode: next, saved: next } : prev);
    setRenderDirty(true);
  };

  return (
    <div className="settings-page">
      <div className="settings-page-title">{t('settings.title')}</div>

      {/* 一般 */}
      <div className="ios-group-label">{t('settings.group_general')}</div>
      <div className="ios-card">
        <button type="button" className="ios-row ios-row-tap" onClick={openInitial} title={t('status.set_initial_tooltip')}>
          <span className="ios-row-label">{t('status.set_initial')}</span>
          <Chevron />
        </button>
        <button type="button" className="ios-row ios-row-tap" onClick={onOpenLogFolder} title={t('status.open_log_tooltip')}>
          <span className="ios-row-label">{t('status.open_log')}</span>
          <Chevron />
        </button>
        <button
          type="button"
          className="ios-row ios-row-tap"
          disabled={devModeBusy}
          title={t('dev_mode.reveal_tooltip')}
          onClick={async () => {
            setDevModeBusy(true);
            try { await onEnableDeveloperMode(); }
            finally { setDevModeBusy(false); }
          }}
        >
          <span className="ios-row-label">
            {devModeBusy ? t('dev_mode.reveal_working') : t('dev_mode.enable_button')} <Help title={t('dev_mode.reveal_tooltip')} />
          </span>
          <Chevron />
        </button>
      </div>

      {/* 應用程式 */}
      <div className="ios-group-label">{t('settings.group_app')}</div>
      <div className="ios-card">
        <div className="ios-row">
          <span className="ios-row-label">
            {t('settings.alert_sound_label')} <Help title={t('settings.alert_sound_desc')} />
          </span>
          <span className="ios-row-control">
            <button type="button" className="ios-pill" onClick={() => playCompletionAlert(true)}>
              {t('settings.alert_sound_test')}
            </button>
            <IosSwitch checked={alertEnabled} onChange={handleAlert} />
          </span>
        </div>

        {renderInfo && (
          <div className="ios-row">
            <span className="ios-row-label">
              {t('settings.render_mode_label')} <Help title={t('settings.render_mode_desc')} />
            </span>
            <IosSwitch checked={renderInfo.mode === 'hardware'} onChange={handleRender} />
          </div>
        )}
        {renderInfo && renderDirty && (
          <div className="ios-row" style={{ alignItems: 'center' }}>
            <span className="ios-row-sub">{t('settings.render_mode_restart_hint')}</span>
            <button type="button" className="ios-pill" onClick={() => window.electronAPI?.relaunchApp()}>
              {t('settings.render_mode_restart_now')}
            </button>
          </div>
        )}

        <button
          type="button"
          className="ios-row ios-row-tap"
          onClick={() => window.open(update.releaseUrl || 'https://github.com/keezxc1223/locwarp/releases', '_blank', 'noopener')}
        >
          <span className="ios-row-label">{t('settings.version')}</span>
          <span className="ios-row-value">
            v{update.current} · {update.latest ? t('settings.update_available') : t('settings.up_to_date')}
            <Chevron />
          </span>
        </button>
      </div>

      {initOpen && createPortal((
        <div
          onClick={() => { if (!initBusy) setInitOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 2200,
            background: 'rgba(8, 10, 20, 0.55)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 360, maxWidth: 'calc(100vw - 48px)',
              background: 'rgba(26, 29, 39, 0.96)',
              border: '1px solid rgba(108, 140, 255, 0.25)', borderRadius: 12,
              padding: 22, color: '#e8eaf0',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65)', fontSize: 13,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{t('status.set_initial')}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 12, lineHeight: 1.5 }}>
              {t('status.set_initial_prompt')}
            </div>
            <input
              type="text"
              value={initVal}
              onChange={(e) => { setInitVal(e.target.value); setInitErr(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !initBusy) saveInitial();
                if (e.key === 'Escape' && !initBusy) setInitOpen(false);
              }}
              autoFocus
              placeholder="25.033, 121.564"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'rgba(10, 12, 18, 0.7)',
                border: '1px solid rgba(108, 140, 255, 0.3)',
                borderRadius: 6, color: '#e8eaf0',
                padding: '8px 10px', fontFamily: 'monospace', fontSize: 13, outline: 'none',
              }}
            />
            {initErr && <div style={{ color: '#ff4757', fontSize: 11, marginTop: 8 }}>{initErr}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setInitOpen(false)}
                disabled={initBusy}
                style={{
                  padding: '6px 14px', fontSize: 12, cursor: 'pointer',
                  background: 'transparent', color: '#9499ac',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6,
                }}
              >{t('generic.cancel')}</button>
              <button
                onClick={saveInitial}
                disabled={initBusy}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: '#6c8cff', color: '#fff', border: 'none', borderRadius: 6,
                  opacity: initBusy ? 0.6 : 1,
                }}
              >{t('generic.save')}</button>
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
};

export default SettingsPage;
