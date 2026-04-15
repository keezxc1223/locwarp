import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import pkg from '../../package.json';
import { useT } from '../i18n';

const CURRENT = (pkg as { version: string }).version;
const REPO = 'keezxc1223/locwarp';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

function parseVer(s: string): number[] {
  return s.replace(/^v/i, '').split('.').map((p) => parseInt(p, 10) || 0);
}

/** Returns true if `a` is strictly newer than `b`. */
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

type Phase = 'idle' | 'downloading' | 'downloaded' | 'error';

interface UpdaterEvent {
  type: 'checking' | 'available' | 'not-available' | 'progress' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  bytesPerSecond?: number;
  message?: string;
}

interface UpdaterBridge {
  check: () => Promise<{ ok: boolean; version?: string | null; reason?: string }>;
  download: () => Promise<{ ok: boolean; reason?: string }>;
  quitAndInstall: () => Promise<{ ok: boolean }>;
  onEvent: (cb: (e: UpdaterEvent) => void) => () => void;
}

function getUpdater(): UpdaterBridge | null {
  try {
    return (window as any).locwarpUpdater ?? null;
  } catch {
    return null;
  }
}

/**
 * Shows a dismissible update dialog when the GitHub API reports a newer
 * release. The user picks one of:
 *   - Install now: renderer asks the main process to download via
 *     electron-updater and then quit-and-install on completion
 *   - Open GitHub: external browser to the releases page (for users who
 *     prefer the manual route / want to read the changelog first)
 *   - Skip: closes the dialog; it will reappear on the next launch if a
 *     newer version is still available (no 6h cooldown).
 */
const UpdateChecker: React.FC = () => {
  const t = useT();
  const [latest, setLatest] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Fetch GitHub API on mount for quick "is there a new version?" signal.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } });
        if (!r.ok) return;
        const data = await r.json();
        const tag: string | undefined = data?.tag_name;
        if (!tag || cancelled) return;
        if (!isNewer(tag, CURRENT)) return;
        setLatest(tag);
      } catch {
        // Offline / rate-limited / DNS — silent.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Subscribe to electron-updater progress / error / downloaded events.
  useEffect(() => {
    const updater = getUpdater();
    if (!updater) return;
    const off = updater.onEvent((e) => {
      if (e.type === 'progress') {
        setPhase('downloading');
        setPercent(Math.max(0, Math.min(100, Math.round(e.percent ?? 0))));
      } else if (e.type === 'downloaded') {
        setPhase('downloaded');
        setPercent(100);
      } else if (e.type === 'error') {
        setPhase('error');
        setErrMsg(e.message ?? 'update error');
      }
    });
    return off;
  }, []);

  if (!latest) return null;

  const dismiss = () => setLatest(null);

  const openGithub = () => {
    try {
      const anyWin: any = window;
      if (anyWin.locwarp?.openExternal) {
        anyWin.locwarp.openExternal(RELEASES_URL);
      } else {
        window.open(RELEASES_URL, '_blank');
      }
    } catch {
      window.open(RELEASES_URL, '_blank');
    }
  };

  const startUpdate = async () => {
    const updater = getUpdater();
    if (!updater) {
      // Dev build or old packaged build without the bridge — fall back to
      // opening the releases page so the user can still grab the installer.
      openGithub();
      return;
    }
    setPhase('downloading');
    setPercent(0);
    setErrMsg(null);
    const res = await updater.download();
    if (!res.ok) {
      setPhase('error');
      setErrMsg(res.reason ?? 'download failed');
    }
  };

  const restartAndInstall = async () => {
    const updater = getUpdater();
    if (!updater) return;
    await updater.quitAndInstall();
  };

  const primaryLabel =
    phase === 'downloading' ? t('update.downloading') :
    phase === 'downloaded' ? t('update.restart_install') :
    phase === 'error' ? t('update.retry') :
    t('update.install_now');

  const primaryAction =
    phase === 'downloaded' ? restartAndInstall : startUpdate;

  const primaryDisabled = phase === 'downloading';

  return createPortal(
    <div
      className="anim-fade-in"
      onClick={phase === 'downloading' ? undefined : dismiss}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(8, 10, 20, 0.55)',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        zIndex: 2000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="anim-scale-in"
        style={{
          background: 'rgba(26, 29, 39, 0.96)',
          backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
          border: '1px solid rgba(108, 140, 255, 0.25)',
          borderRadius: 12, padding: 22, width: 380, color: '#e0e0e0',
          boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255,255,255,0.05) inset',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div
            style={{
              width: 32, height: 32, borderRadius: 8,
              background: 'linear-gradient(135deg, #6c8cff, #4285f4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M12 2v13M5 9l7-7 7 7" />
              <path d="M5 21h14" />
            </svg>
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>
            {t('update.title')}
          </div>
        </div>

        <div style={{ fontSize: 12.5, lineHeight: 1.7, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ opacity: 0.65 }}>{t('update.current')}</span>
            <span style={{ fontFamily: 'monospace' }}>v{CURRENT}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ opacity: 0.65 }}>{t('update.latest')}</span>
            <span style={{ fontFamily: 'monospace', color: '#6c8cff', fontWeight: 600 }}>
              {latest}
            </span>
          </div>
        </div>

        {phase === 'downloading' && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
              {t('update.downloading')} · {percent}%
            </div>
            <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${percent}%`,
                background: 'linear-gradient(90deg, #6c8cff, #4285f4)',
                transition: 'width 0.2s ease',
              }} />
            </div>
          </div>
        )}

        {phase === 'downloaded' && (
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 14, color: '#5dd4a0' }}>
            {t('update.downloaded_hint')}
          </div>
        )}

        {phase === 'error' && errMsg && (
          <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 14, color: '#ff8a80', wordBreak: 'break-word' }}>
            {errMsg}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="action-btn primary"
            onClick={primaryAction}
            disabled={primaryDisabled}
            style={{ flex: 1 }}
          >
            {primaryLabel}
          </button>
          <button className="action-btn" onClick={openGithub} disabled={phase === 'downloading'}>
            {t('update.goto_github')}
          </button>
          <button className="action-btn" onClick={dismiss} disabled={phase === 'downloading'}>
            {t('update.skip')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default UpdateChecker;
