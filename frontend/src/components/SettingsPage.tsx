import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import {
  isAlertSoundEnabled,
  setAlertSoundEnabled,
  playCompletionAlert,
} from '../services/alertSound';
import { getInitialPosition, setInitialPosition, setPhoneAppearance } from '../services/api';
import { useUpdateCheck, openUpdateDialog } from './UpdateChecker';
import {
  parseCoord, formatCoord, fromWgs84, useCoordSettings, setCoordSettings,
  isDefaultCoordSettings, coordBadge,
  type CoordDatum, type CoordOrder,
} from '../utils/coords';
import {
  THEMES, themeDef, applyAppearance, loadSavedAppearance, saveAppearance, sameAppearance,
  type Appearance, type GlassMode,
} from '../utils/appearance';
import type { RenderMode, RenderModeInfo } from '../types/electron';

interface Props {
  onOpenLogFolder: () => void;
  // Fires the AMFI "reveal Developer Mode" request against the connected
  // iPhone. App resolves the target device + surfaces a toast if none is
  // connected. Lives here permanently (not gated on dev-mode state) so the
  // option is always reachable from 設定.
  onEnableDeveloperMode: () => void | Promise<void>;
}

// Sample point for the coordinate-format preview (WGS84). It has to sit in
// mainland China, otherwise switching the coordinate system would not
// change the numbers shown.
const EXAMPLE = { lat: 31.2418, lng: 121.4954 };

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

// One settings group. Closed until asked for: the page is a short list of
// group names, and only what the user opens takes up room.
const Group: React.FC<{
  id: string; title: string; open: Set<string>; onToggle: (id: string) => void; children: React.ReactNode;
}> = ({ id, title, open, onToggle, children }) => {
  const isOpen = open.has(id);
  return (
    <div className={`ios-group${isOpen ? ' open' : ''}`}>
      <button type="button" className="ios-group-head" aria-expanded={isOpen} onClick={() => onToggle(id)}>
        <span>{title}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {isOpen && <div className="ios-card">{children}</div>}
    </div>
  );
};

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
  const [devModeBusy, setDevModeBusy] = useState(false);
  const [renderInfo, setRenderInfo] = useState<RenderModeInfo | null>(null);
  const [renderDirty, setRenderDirty] = useState(false);
  const update = useUpdateCheck();
  const savedCoord = useCoordSettings();

  // Every group starts closed, every time the page opens.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Everything the save bar covers is edited as a draft. Appearance is
  // previewed live on the window; nothing is written until 儲存設定, and
  // leaving the page without saving puts the saved look back.
  type Draft = { datum: CoordDatum; order: CoordOrder; alert: boolean; look: Appearance };
  const [baseline, setBaseline] = useState<Draft>(() => ({
    datum: savedCoord.datum,
    order: savedCoord.order,
    alert: isAlertSoundEnabled(),
    look: loadSavedAppearance(),
  }));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);
  const dirty = draft.datum !== baseline.datum || draft.order !== baseline.order
    || draft.alert !== baseline.alert || !sameAppearance(draft.look, baseline.look);
  const patch = (p: Partial<Draft>) => { setJustSaved(false); setDraft((d) => ({ ...d, ...p })); };
  const patchLook = (p: Partial<Appearance>) => patch({ look: { ...draft.look, ...p } });

  useEffect(() => { applyAppearance(draft.look); }, [draft.look]);
  useEffect(() => () => {
    applyAppearance(loadSavedAppearance());
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  const saveAll = () => {
    setCoordSettings({ datum: draft.datum, order: draft.order });
    setAlertSoundEnabled(draft.alert);
    saveAppearance(draft.look);
    // The phone control page follows the desktop's theme colour.
    setPhoneAppearance(themeDef(draft.look.theme).accent).catch(() => { /* phone page keeps its last colour */ });
    setBaseline(draft);
    setJustSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setJustSaved(false), 2400);
  };

  const example = fromWgs84(EXAMPLE.lat, EXAMPLE.lng, draft.datum);
  const exampleCells = [
    { axis: 'lat' as const, text: example.lat.toFixed(6) },
    { axis: 'lng' as const, text: example.lng.toFixed(6) },
  ];
  if (draft.order === 'lnglat') exampleCells.reverse();

  // Startup map view (起始地圖位置) — moved here from the status bar.
  const [initOpen, setInitOpen] = useState(false);
  const [initVal, setInitVal] = useState('');
  const [initErr, setInitErr] = useState<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);

  const openInitial = async () => {
    try {
      const res = await getInitialPosition();
      setInitVal(res.position ? formatCoord(res.position.lat, res.position.lng, 6) : '');
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
    const parsed = parseCoord(trimmed);
    if (!parsed) { setInitErr(t('status.set_initial_invalid')); return; }
    const { lat, lng } = parsed;
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
      <Group id="general" title={t('settings.group_general')} open={open} onToggle={toggle}>
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
      </Group>

      {/* 座標格式 */}
      <Group id="coord" title={t('settings.group_coord')} open={open} onToggle={toggle}>
        <label className="ios-row ios-row-stack">
          <span className="ios-row-label">
            {t('settings.coord_datum_label')} <Help title={t('settings.coord_datum_desc')} />
          </span>
          <select
            className="ios-select"
            value={draft.datum}
            onChange={(e) => patch({ datum: e.target.value as CoordDatum })}
          >
            <option value="wgs84">{t('settings.coord_datum_wgs84')}</option>
            <option value="gcj02">{t('settings.coord_datum_gcj02')}</option>
            <option value="bd09">{t('settings.coord_datum_bd09')}</option>
          </select>
        </label>
        <label className="ios-row ios-row-stack">
          <span className="ios-row-label">
            {t('settings.coord_order_label')} <Help title={t('settings.coord_order_desc')} />
          </span>
          <select
            className="ios-select"
            value={draft.order}
            onChange={(e) => patch({ order: e.target.value as CoordOrder })}
          >
            <option value="latlng">{t('settings.coord_order_latlng')}</option>
            <option value="lnglat">{t('settings.coord_order_lnglat')}</option>
          </select>
        </label>
        <div className="ios-row ios-row-stack">
          <span className="ios-row-caption">{t('settings.coord_example')}</span>
          <div className="coord-preview">
            {exampleCells.map((p) => (
              <div key={p.axis} className="coord-preview-cell">
                <span className="coord-preview-axis">{t(p.axis === 'lat' ? 'coord.lat' : 'coord.lng')}</span>
                <span className="coord-preview-value">{p.text}</span>
              </div>
            ))}
          </div>
        </div>
      </Group>

      {/* 應用程式 */}
      <Group id="app" title={t('settings.group_app')} open={open} onToggle={toggle}>
        <div className="ios-row">
          <span className="ios-row-label">
            {t('settings.alert_sound_label')} <Help title={t('settings.alert_sound_desc')} />
          </span>
          <span className="ios-row-control">
            <button type="button" className="ios-pill" onClick={() => playCompletionAlert(true)}>
              {t('settings.alert_sound_test')}
            </button>
            <IosSwitch checked={draft.alert} onChange={(v) => patch({ alert: v })} />
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
          onClick={() => {
            if (update.latest) openUpdateDialog();
            else window.open('https://github.com/keezxc1223/locwarp/releases', '_blank', 'noopener');
          }}
        >
          <span className="ios-row-label">{t('settings.version')}</span>
          <span className="ios-row-value">
            v{update.current} · {update.latest ? t('settings.update_available') : t('settings.up_to_date')}
            <Chevron />
          </span>
        </button>
      </Group>

      {/* 外觀 */}
      <Group id="look" title={t('settings.group_look')} open={open} onToggle={toggle}>
        <div className="ios-row ios-row-stack">
          <span className="ios-row-label">
            {t('settings.theme_label')}
            <span className="ios-row-caption">{t(`theme.${draft.look.theme}`)}</span>
          </span>
          <div className="theme-swatches">
            {THEMES.map((th) => (
              <button
                key={th.id}
                type="button"
                className={`theme-swatch${draft.look.theme === th.id ? ' on' : ''}`}
                style={{ ['--sw-a' as any]: th.accent, ['--sw-b' as any]: th.accent2 }}
                title={t(`theme.${th.id}`)}
                aria-label={t(`theme.${th.id}`)}
                aria-pressed={draft.look.theme === th.id}
                onClick={() => patchLook({ theme: th.id })}
              />
            ))}
          </div>
        </div>
        <div className="ios-row ios-row-stack">
          <span className="ios-row-label">
            {t('settings.glass_label')} <Help title={t('settings.glass_desc')} />
          </span>
          <div className="lw-segment">
            {(['liquid', 'frosted', 'solid'] as GlassMode[]).map((g) => (
              <button
                key={g}
                type="button"
                className={draft.look.glass === g ? 'on' : ''}
                onClick={() => patchLook({ glass: g })}
              >{t(`settings.glass_${g}`)}</button>
            ))}
          </div>
        </div>
        <div className="ios-row">
          <span className="ios-row-label">{t('settings.motion_label')}</span>
          <IosSwitch checked={draft.look.motion} onChange={(v) => patchLook({ motion: v })} />
        </div>
      </Group>

      <div className="lw-savebar">
        <div className={`lw-savebar-note${dirty ? ' dirty' : justSaved ? ' ok' : ''}`}>
          {dirty ? t('settings.unsaved') : justSaved ? t('settings.saved') : t('settings.save_hint')}
        </div>
        <div className="lw-savebar-actions">
          <button type="button" disabled={!dirty} onClick={() => { setJustSaved(false); setDraft(baseline); }}>
            {t('settings.discard')}
          </button>
          <button type="button" className="save" disabled={!dirty} onClick={saveAll}>
            {t('settings.save')}
          </button>
        </div>
      </div>

      {initOpen && createPortal((
        <div
          onClick={() => { if (!initBusy) setInitOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 2200,
            background: 'rgba(8, 10, 20, 0.55)', backdropFilter: 'blur(4px)', animation: 'var(--anim-scrim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 360, maxWidth: 'calc(100vw - 48px)',
              background: 'var(--glass-pop)',
              border: '1px solid rgba(var(--accent-rgb), 0.25)', borderRadius: 12,
              padding: 22, color: '#e8eaf0',
              boxShadow: 'var(--shadow-pop)', animation: 'var(--anim-pop)', fontSize: 13,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{t('status.set_initial')}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 12, lineHeight: 1.5 }}>
              {t('status.set_initial_prompt')}{!isDefaultCoordSettings() && ` (${coordBadge(t)})`}
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
              placeholder={formatCoord(25.033, 121.564, 3)}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'rgba(10, 12, 18, 0.7)',
                border: '1px solid rgba(var(--accent-rgb), 0.3)',
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
                  background: 'var(--accent-blue)', color: '#fff', border: 'none', borderRadius: 6,
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
