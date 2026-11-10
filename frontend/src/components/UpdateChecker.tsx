import React, { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import pkg from '../../package.json';
import { useT } from '../i18n';

// Update flow.
//
//   1. On launch, ask GitHub whether a newer release exists. That is the
//      only thing that happens without the user: a badge appears.
//   2. The badge (status bar, 設定 > 版本) opens the dialog below.
//   3. Download starts only when the user presses 更新. When it is done the
//      dialog offers to restart; nothing installs behind the user's back.
//
// The download and install are done by electron-updater in the main
// process. Outside the packaged app (dev server, or a release that ships
// no latest.yml) the dialog falls back to opening the release page.

const CURRENT = (pkg as { version: string }).version;
const REPO = 'keezxc1223/locwarp';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
// Mirror of the installers for people who cannot reach GitHub reliably.
const DRIVE_URL = 'https://drive.google.com/drive/folders/1bqVnNnSbwrVaf2GT6fEhW6R0ZlhE-fc3';

function parseVer(s: string): number[] {
  return s.replace(/^v/i, '').split('.').map((p) => parseInt(p, 10) || 0);
}

function isNewer(a: string, b: string): boolean {
  const x = parseVer(a);
  const y = parseVer(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    if (xi !== yi) return xi > yi;
  }
  return false;
}

type Phase = 'idle' | 'starting' | 'downloading' | 'ready' | 'error';

interface UpdateState {
  current: string;
  latest: string | null;
  releaseUrl: string | null;
  dialogOpen: boolean;
  phase: Phase;
  percent: number;
  transferred: number;
  total: number;
  error: string | null;
}

let state: UpdateState = {
  current: CURRENT, latest: null, releaseUrl: null, dialogOpen: false,
  phase: 'idle', percent: 0, transferred: 0, total: 0, error: null,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const getState = () => state;

let started = false;
function startOnce(): void {
  if (started) return;
  started = true;

  (async () => {
    try {
      const r = await fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) return;
      const data = await r.json();
      const tag: string | undefined = data?.tag_name;
      if (!tag || !isNewer(tag, CURRENT)) return;
      set({ latest: tag, releaseUrl: data?.html_url || RELEASES_URL });
    } catch { /* offline / rate-limited / DNS: stay quiet */ }
  })();

  window.electronAPI?.onUpdateStatus?.((s) => {
    if (s.phase === 'downloading') {
      set({ phase: 'downloading', percent: s.percent, transferred: s.transferred, total: s.total });
    } else if (s.phase === 'ready') {
      // Bring the dialog back if the user closed it while it downloaded.
      set({ phase: 'ready', percent: 100, dialogOpen: true });
    } else if (s.phase === 'error') {
      set({ phase: 'error', error: s.message });
    }
  });
}

export function openUpdateDialog(): void { set({ dialogOpen: true }); }

async function beginDownload(): Promise<void> {
  const api = window.electronAPI;
  if (!api?.updateDownload || !(await api.updateSupported?.())) {
    set({ phase: 'error', error: 'UNSUPPORTED' });
    return;
  }
  set({ phase: 'starting', percent: 0, transferred: 0, total: 0, error: null });
  const res = await api.updateDownload();
  if (!res.ok) set({ phase: 'error', error: res.message || res.code || 'ERROR' });
  else if (getState().phase === 'starting') set({ phase: 'downloading' });
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  releaseUrl: string | null;
  phase: Phase;
}

/** Latest release info plus where the in-app update currently stands. */
export function useUpdateCheck(): UpdateInfo {
  useEffect(() => { startOnce(); }, []);
  const s = useSyncExternalStore(subscribe, getState, getState);
  return { current: s.current, latest: s.latest, releaseUrl: s.releaseUrl, phase: s.phase };
}

const mb = (n: number) => (n / 1048576).toFixed(1);

/** Mounted once in App. Renders nothing until the dialog is opened. */
export const UpdateDialog: React.FC = () => {
  const t = useT();
  useEffect(() => { startOnce(); }, []);
  const s = useSyncExternalStore(subscribe, getState, getState);
  if (!s.dialogOpen || !s.latest) return null;

  const close = () => set({ dialogOpen: false });
  const openRelease = () => window.open(s.releaseUrl || RELEASES_URL, '_blank', 'noopener');
  const openDrive = () => window.open(DRIVE_URL, '_blank', 'noopener');
  const busy = s.phase === 'starting' || s.phase === 'downloading';

  return createPortal(
    <div className="lib-scrim" onClick={close}>
      <div className="lib-dialog lw-update" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="lib-dialog-title">{t('update.title')}</div>
        <div className="lw-update-versions">
          <div><span>{t('update.current')}</span><b>v{s.current}</b></div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
          </svg>
          <div className="new"><span>{t('update.latest')}</span><b>{s.latest}</b></div>
        </div>

        {s.phase === 'idle' && <div className="lw-update-note">{t('update.idle_note')}</div>}

        {busy && (
          <div className="lw-update-progress">
            <div className="lw-update-track"><div style={{ width: `${Math.max(2, Math.min(100, s.percent))}%` }} /></div>
            <div className="lw-update-note">
              {s.phase === 'starting' || s.total === 0
                ? t('update.preparing')
                : `${t('update.downloading')} ${Math.floor(s.percent)}%  (${mb(s.transferred)} / ${mb(s.total)} MB)`}
            </div>
          </div>
        )}

        {s.phase === 'ready' && <div className="lw-update-note ok">{t('update.ready_note')}</div>}

        {s.phase === 'error' && (
          <div className="lw-update-note err">
            {t('update.failed_note')}
            {s.error && s.error !== 'UNSUPPORTED' && <code>{s.error}</code>}
          </div>
        )}

        {/* Manual sources stay reachable in every state: they are the way
            out when the in-app download is slow or fails. */}
        <div className="lw-update-links">
          <button type="button" onClick={openRelease}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 .5a11.5 11.5 0 00-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 015.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0012 .5z" />
            </svg>
            {t('update.link_github')}
          </button>
          <button type="button" onClick={openDrive}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
              <path d="M8.5 3h7l6.5 11.5-3.5 6h-13l-3.5-6z" /><path d="M8.5 3L15 14.5H2" /><path d="M15.5 3L9 14.5l3.5 6" />
            </svg>
            {t('update.link_drive')}
          </button>
        </div>

        <div className="lib-form-actions">
          <button type="button" className="lib-btn" onClick={close}>
            {busy ? t('update.hide') : t('update.later')}
          </button>
          {s.phase === 'idle' && (
            <button type="button" className="lib-btn primary" onClick={() => { void beginDownload(); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t('update.start')}
            </button>
          )}
          {s.phase === 'error' && s.error !== 'UNSUPPORTED' && (
            <button type="button" className="lib-btn primary" onClick={() => { void beginDownload(); }}>{t('generic.retry')}</button>
          )}
          {s.phase === 'ready' && (
            <button type="button" className="lib-btn primary" onClick={() => { void window.electronAPI?.updateInstall?.(); }}>
              {t('update.restart')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
