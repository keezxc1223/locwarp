import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { describePipiError } from '../services/api';
import type { PipiCookieResult, PipiKind, PipiStatusResponse } from '../services/api';
import type { PipiFlowerFilter, PipiMarkerSize, PipiMushroomFilter } from '../defaults';
import { PIPI_MIN_ZOOM } from '../pipiFetchPlanner';
import { PIPI_MAX_MARKERS } from '../pipiMarkerSelection';
import type { PipiKinds, PipiLayerStatus } from '../hooks/usePipiMushroomLayer';

interface Props {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  kinds: PipiKinds;
  onKindsChange: (k: PipiKinds) => void;
  flowerFilter: PipiFlowerFilter;
  onFlowerFilterChange: (f: PipiFlowerFilter) => void;
  mushroomFilter: PipiMushroomFilter;
  onMushroomFilterChange: (f: PipiMushroomFilter) => void;
  /** Mushroom sizes and types seen in the loaded data. */
  facets: { sizes: string[]; names: string[] };
  markerSize: PipiMarkerSize;
  onMarkerSizeChange: (s: PipiMarkerSize) => void;
  status: PipiLayerStatus;
  configured: boolean | null;
  cookieInfo: Pick<PipiStatusResponse, 'source' | 'updated_at'>;
  onRefresh: () => void;
  onSaveCookie: (cookie: string) => Promise<PipiCookieResult>;
  onClearCookie: () => Promise<void>;
  onClose: () => void;
  t: (key: any, vars?: Record<string, string | number>) => string;
}

// Chrome Web Store page of the cookie-sync extension. Empty until it is
// published; while empty the guide explains loading the bundled folder
// unpacked. Fill it in and the guide becomes "install from the store".
const EXTENSION_STORE_URL = '';

const KIND_COLORS: Record<PipiKind, string> = {
  mushroom: '#ff9f43',
  flower: '#ff6fa8',
  smoke: '#9aa3b2',
};
const KIND_ORDER: PipiKind[] = ['mushroom', 'flower', 'smoke'];
const FLOWER_FILTER_ORDER: { key: keyof PipiFlowerFilter; labelKey: string }[] = [
  { key: 'ribbonOnly', labelKey: 'map.pipi_flower_ribbon_only' },
  { key: 'showCommon', labelKey: 'map.pipi_flower_show_common' },
];
const MARKER_SIZE_ORDER: PipiMarkerSize[] = ['small', 'medium', 'large'];
const PANEL_ACCENT = '#ff9f43';
const WARN_BOX: React.CSSProperties = {
  marginTop: 6, padding: '5px 8px', background: 'rgba(255,193,7,0.12)',
  border: '1px solid rgba(255,193,7,0.45)', borderRadius: 4, fontSize: 11, color: '#ffd54f', lineHeight: 1.4,
};

const toggleIn = (list: string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

// One group of on/off options in the mushroom filter (sizes, types). The
// header carries the count and the two bulk actions; the options sit in an
// even grid, and a long list scrolls inside its own box instead of
// stretching the panel.
const FacetGroup: React.FC<{
  title: string;
  values: string[];
  hidden: string[];
  columns: number;
  onChange: (hidden: string[]) => void;
  t: (key: any, vars?: Record<string, string | number>) => string;
}> = ({ title, values, hidden, columns, onChange, t }) => {
  const shown = values.filter((v) => !hidden.includes(v)).length;
  return (
    <div className="pipi-filter-group">
      <div className="pipi-filter-head">
        <span>{title}<small>{shown}/{values.length}</small></span>
        <button type="button" onClick={() => onChange(hidden.filter((h) => !values.includes(h)))} disabled={shown === values.length}>
          {t('bm.select_all')}
        </button>
        <button type="button" onClick={() => onChange([...new Set([...hidden, ...values])])} disabled={shown === 0}>
          {t('map.pipi_filter_none')}
        </button>
      </div>
      <div className="pipi-filter-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {values.map((v) => {
          const on = !hidden.includes(v);
          return (
            <button key={v} type="button" className={`pipi-opt${on ? ' on' : ''}`} aria-pressed={on} title={v}
              onClick={() => onChange(toggleIn(hidden, v))}
            >{v}</button>
          );
        })}
      </div>
    </div>
  );
};

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

const PipiMushroomPanel: React.FC<Props> = ({
  enabled, onEnabledChange, kinds, onKindsChange, flowerFilter, onFlowerFilterChange,
  mushroomFilter, onMushroomFilterChange, facets, markerSize, onMarkerSizeChange,
  status, configured, cookieInfo, onRefresh, onSaveCookie, onClearCookie, onClose, t,
}) => {
  const cookieBadge = !configured
    ? t('map.pipi_cookie_unset')
    : cookieInfo.updated_at
      ? t(cookieInfo.source === 'extension' ? 'map.pipi_cookie_via_extension' : 'map.pipi_cookie_via_manual',
        { time: clock(cookieInfo.updated_at) })
      : t('map.pipi_cookie_set');
  const [cookieInput, setCookieInput] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cookieMsg, setCookieMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    const v = cookieInput.trim();
    if (!v || busy) return;
    setBusy(true);
    setCookieMsg(null);
    try {
      const r = await onSaveCookie(v);
      setCookieInput('');
      if (r.logged_in) setCookieMsg({ ok: true, text: t('map.pipi_cookie_ok') });
      else if (r.error === 'pipi_login_required') setCookieMsg({ ok: false, text: t('map.pipi_cookie_not_logged_in') });
      else setCookieMsg({ ok: false, text: describePipiError(r.error || 'pipi_unavailable') });
    } catch (e) {
      setCookieMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onClearCookie();
      setCookieMsg({ ok: true, text: t('map.pipi_cookie_cleared') });
    } catch (e) {
      setCookieMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  let statusText: string;
  let statusColor = '#9499ac';
  switch (status.phase) {
    case 'off': statusText = t('map.pipi_status_off'); break;
    case 'no_cookie': statusText = t('map.pipi_status_no_cookie'); statusColor = '#ffd54f'; break;
    case 'zoom': statusText = t('map.pipi_status_zoom', { zoom: PIPI_MIN_ZOOM, current: status.zoom }); statusColor = '#ffd54f'; break;
    case 'region': statusText = t('map.pipi_status_region'); break;
    case 'loading': statusText = t('map.pipi_status_loading'); break;
    case 'ok':
      statusText = t('map.pipi_status_ok', { count: status.shown, time: status.updatedAt ? clock(status.updatedAt) : '-' });
      statusColor = '#8fe3a8';
      break;
    default: statusText = status.error || 'error'; statusColor = '#ff8a8a';
  }

  const chip = (active: boolean, color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5,
    background: active ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.03)',
    border: `1px solid ${active ? color : 'rgba(255,255,255,0.12)'}`,
    color: active ? '#fff' : '#7d8399',
    fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 12, cursor: 'pointer',
  });

  // Shown on the collapsed header, so a filter that is hiding mushrooms is
  // never out of sight.
  const mushFilterActive = mushroomFilter.hiddenSizes.length > 0 || mushroomFilter.hiddenNames.length > 0 || mushroomFilter.minMinutes > 0;
  const openSite = () => window.open('https://pipimushroom.com/', '_blank', 'noopener');
  const openExtFolder = () => { void window.electronAPI?.openPipiExtensionFolder?.(); };

  return (
    <div
      onContextMenu={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="pipi-panel"
    >
      <div className="pipi-panel-head">
        <span>{t('map.pipi_title')}</span>
        <button type="button" className="pipi-panel-close" onClick={onClose} aria-label="close">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="pipi-panel-row">
        <span>{t('map.pipi_layer_on')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          className={`ios-switch${enabled ? ' on' : ''}`}
          onClick={() => onEnabledChange(!enabled)}
        ><span className="ios-switch-knob" /></button>
      </div>

      <div className="pipi-panel-notice">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9.5" /><line x1="12" y1="11" x2="12" y2="16.5" /><line x1="12" y1="7.5" x2="12.01" y2="7.5" />
        </svg>
        <span>{t('map.pipi_source')}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {KIND_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onKindsChange({ ...kinds, [k]: !kinds[k] })}
            style={chip(kinds[k], KIND_COLORS[k])}
            aria-pressed={kinds[k]}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: kinds[k] ? KIND_COLORS[k] : '#4a4f63' }} />
            {t(`map.pipi_kind_${k}`)}
          </button>
        ))}
      </div>

      {/* Mushroom sub-filter. The choices come from the loaded data, so they
          appear once some mushrooms have been loaded. */}
      {kinds.mushroom && (
        <details className="pipi-panel-details pipi-panel-filter">
          <summary>
            {t('map.pipi_mush_filter_title')}
            {mushFilterActive && <span className="pipi-panel-badge">{t('map.pipi_mush_filter_on')}</span>}
          </summary>
          <div className="pipi-filter">
            {facets.sizes.length === 0 && facets.names.length === 0 && (
              <div className="pipi-filter-empty">{t('map.pipi_mush_filter_empty')}</div>
            )}
            {facets.sizes.length > 0 && (
              <FacetGroup
                title={t('map.pipi_mush_size')}
                values={facets.sizes}
                hidden={mushroomFilter.hiddenSizes}
                columns={Math.min(4, Math.max(2, facets.sizes.length))}
                onChange={(hiddenSizes) => onMushroomFilterChange({ ...mushroomFilter, hiddenSizes })}
                t={t}
              />
            )}
            {facets.names.length > 0 && (
              <FacetGroup
                title={t('map.pipi_mush_type')}
                values={facets.names}
                hidden={mushroomFilter.hiddenNames}
                columns={2}
                onChange={(hiddenNames) => onMushroomFilterChange({ ...mushroomFilter, hiddenNames })}
                t={t}
              />
            )}
            <div className="pipi-filter-group">
              <div className="pipi-filter-head"><span>{t('map.pipi_mush_min_left')}</span></div>
              <div className="pipi-filter-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
                {[0, 5, 10, 20, 30].map((m) => (
                  <button key={m} type="button"
                    className={`pipi-opt${mushroomFilter.minMinutes === m ? ' on' : ''}`}
                    aria-pressed={mushroomFilter.minMinutes === m}
                    onClick={() => onMushroomFilterChange({ ...mushroomFilter, minMinutes: m })}
                  >{m === 0 ? t('map.pipi_mush_any') : t('map.pipi_mush_minutes_short', { n: m })}</button>
                ))}
              </div>
            </div>
          </div>
        </details>
      )}

      {/* Disabled while flowers are off, but the ticks are kept so turning
          flowers back on restores them. */}
      <div style={{
        display: 'flex', gap: 12, flexWrap: 'wrap', margin: '0 0 8px 4px', paddingLeft: 10,
        borderLeft: `2px solid ${kinds.flower ? KIND_COLORS.flower : 'rgba(255,255,255,0.12)'}`,
        fontSize: 11, color: kinds.flower ? '#c7d0e4' : '#5d6378',
      }}>
        {FLOWER_FILTER_ORDER.map(({ key, labelKey }) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: kinds.flower ? 'pointer' : 'not-allowed' }}>
            <input
              type="checkbox"
              checked={flowerFilter[key]}
              disabled={!kinds.flower}
              onChange={(e) => onFlowerFilterChange({ ...flowerFilter, [key]: e.target.checked })}
            />
            {t(labelKey)}
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: '#c7d0e4', marginRight: 2 }}>{t('map.pipi_marker_size')}</span>
        {MARKER_SIZE_ORDER.map((sz) => (
          <button
            key={sz}
            type="button"
            onClick={() => onMarkerSizeChange(sz)}
            style={chip(markerSize === sz, PANEL_ACCENT)}
            aria-pressed={markerSize === sz}
          >{t(`map.pipi_marker_size_${sz}`)}</button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1, fontSize: 11, color: statusColor, lineHeight: 1.45 }}>{statusText}</div>
        {enabled && (
          <button type="button" className="pipi-panel-btn" onClick={onRefresh} disabled={status.phase === 'loading'}>
            {t('map.pipi_refresh')}
          </button>
        )}
      </div>
      {enabled && status.truncated && status.phase === 'ok' && (
        <div style={WARN_BOX}>{t('map.pipi_truncated')}</div>
      )}
      {enabled && status.viewCapped && status.phase === 'ok' && (
        <div style={WARN_BOX}>{t('map.pipi_capped', { count: PIPI_MAX_MARKERS })}</div>
      )}

      <div className="pipi-panel-rule" />

      {/* Login: only the state and one button live here. The how-to opens
          in its own dialog, so the panel stays about the map. */}
      <div className="pipi-login-row">
        <span className={`pipi-login-dot${configured ? ' on' : ''}`} />
        <span className="pipi-login-text">
          <b>{configured ? t('map.pipi_login_state_on') : t('map.pipi_login_state_off')}</b>
          <small>{cookieBadge}</small>
        </span>
        <button type="button" className={`pipi-panel-btn${configured ? '' : ' primary'}`} onClick={() => setGuideOpen(true)}>
          {t('map.pipi_guide_button')}
        </button>
      </div>
      {cookieMsg && !guideOpen && (
        <div style={{ marginTop: 6, fontSize: 11, color: cookieMsg.ok ? '#8fe3a8' : '#ff8a8a', lineHeight: 1.4 }}>
          {cookieMsg.text}
        </div>
      )}

      {guideOpen && createPortal(
        <div className="lib-scrim" onClick={() => setGuideOpen(false)}>
          <div className="lib-dialog pipi-guide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="pipi-guide-head">
              <div className="lib-dialog-title">{t('map.pipi_guide_title')}</div>
              <span className={`pipi-guide-state${configured ? ' on' : ''}`}>{cookieBadge}</span>
            </div>
            <div className="pipi-guide-intro">{t('map.pipi_guide_intro')}</div>

            <div className="pipi-guide-card">
              <div className="pipi-guide-card-title">
                {t('map.pipi_guide_ext_title')}<span>{t('map.pipi_guide_recommended')}</span>
              </div>
              {EXTENSION_STORE_URL ? (
                <>
                  <div className="pipi-guide-step">
                    <i>1</i>
                    <p>{t('map.pipi_step_store')}</p>
                    <button type="button" className="pipi-panel-btn primary"
                      onClick={() => window.open(EXTENSION_STORE_URL, '_blank', 'noopener')}
                    >{t('map.pipi_open_store')}</button>
                  </div>
                  <div className="pipi-guide-step">
                    <i>2</i>
                    <p>{t('map.pipi_step_3')}</p>
                    <button type="button" className="pipi-panel-btn" onClick={openSite}>{t('map.pipi_open_site')}</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="pipi-guide-step">
                    <i>1</i>
                    <p>{t('map.pipi_step_1')}</p>
                    {window.electronAPI?.openPipiExtensionFolder && (
                      <button type="button" className="pipi-panel-btn" onClick={openExtFolder}>{t('map.pipi_open_ext_folder')}</button>
                    )}
                  </div>
                  <div className="pipi-guide-step">
                    <i>2</i>
                    <p>{t('map.pipi_step_2')}</p>
                  </div>
                  <div className="pipi-guide-step">
                    <i>3</i>
                    <p>{t('map.pipi_step_3')}</p>
                    <button type="button" className="pipi-panel-btn" onClick={openSite}>{t('map.pipi_open_site')}</button>
                  </div>
                </>
              )}
            </div>

            <details className="pipi-guide-card">
              <summary className="pipi-guide-card-title">{t('map.pipi_manual_title')}</summary>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input
                  type="password"
                  value={cookieInput}
                  onChange={(e) => setCookieInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
                  placeholder={t('map.pipi_cookie_placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                  className="pipi-panel-input"
                />
                <button type="button" className="pipi-panel-btn primary" onClick={() => void save()} disabled={busy || !cookieInput.trim()}>
                  {t('generic.save')}
                </button>
              </div>
              <div className="pipi-guide-help">{t('map.pipi_cookie_help')}</div>
            </details>

            {cookieMsg && (
              <div style={{ fontSize: 11.5, color: cookieMsg.ok ? '#8fe3a8' : '#ff8a8a', lineHeight: 1.4 }}>{cookieMsg.text}</div>
            )}

            <div className="lib-form-actions">
              {configured && (
                <button type="button" className="lib-btn danger" onClick={() => void clear()} disabled={busy}>{t('map.pipi_logout')}</button>
              )}
              <button type="button" className="lib-btn primary" onClick={() => setGuideOpen(false)}>{t('generic.close')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

    </div>
  );
};

export default PipiMushroomPanel;
