import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { listPairedDevices, unpairDevice, type PairedDevice } from '../services/api';
import { useT } from '../i18n';

interface Props {
  onClose: () => void;
  // udid -> name known to the frontend (live devices + saved WiFi entries),
  // used when the backend's name cache has nothing for a udid.
  knownNames: Record<string, string>;
  // Called after a successful unpair so the caller can drop saved WiFi
  // addresses / pins for that phone.
  onUnpaired: (udid: string) => void;
}

const tagStyle = (color: string): React.CSSProperties => ({
  padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
  background: `rgba(${color}, 0.15)`, color: `rgb(${color})`,
});

const PairedDevicesDialog: React.FC<Props> = ({ onClose, knownNames, onUnpaired }) => {
  const t = useT();
  const [list, setList] = useState<PairedDevice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PairedDevice | null>(null);
  const [busyUdid, setBusyUdid] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    setLoadError(null);
    listPairedDevices()
      .then((r) => setList(r.devices))
      .catch((e: any) => setLoadError(e?.message || 'error'));
  };
  useEffect(load, []);

  const nameOf = (d: PairedDevice) => d.name || knownNames[d.udid] || d.udid;

  const doUnpair = async (d: PairedDevice) => {
    setConfirm(null);
    setBusyUdid(d.udid);
    setMsg(null);
    try {
      const r = await unpairDevice(d.udid);
      onUnpaired(d.udid);
      setMsg({ ok: true, text: r.device_side ? t('paired.done_device') : t('paired.done_local') });
      setList((prev) => (prev ? prev.filter((x) => x.udid !== d.udid) : prev));
    } catch (e: any) {
      setMsg({ ok: false, text: t('paired.failed', { error: e?.message || 'error' }) });
      load();
    } finally {
      setBusyUdid(null);
    }
  };

  const busy = busyUdid !== null;

  return createPortal(
    <div
      onClick={() => { if (!busy) onClose(); }}
      className="anim-fade-in"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(8, 10, 20, 0.55)',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', animation: 'var(--anim-scrim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="anim-scale-in"
        style={{
          background: 'var(--glass-pop)',
          backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
          border: '1px solid rgba(var(--accent-rgb), 0.2)', borderRadius: 14,
          padding: 22, maxWidth: 460, width: '100%', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          color: '#e8e8e8', boxShadow: 'var(--shadow-pop)', animation: 'var(--anim-pop)',
        }}
      >
        <strong style={{ fontSize: 15, marginBottom: 6 }}>{t('paired.title')}</strong>
        <div style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.7, marginBottom: 12 }}>{t('paired.desc')}</div>

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {loadError ? (
            <div style={{ fontSize: 12, color: '#ffb27a' }}>{t('paired.load_failed', { error: loadError })}</div>
          ) : list === null ? (
            <div style={{ fontSize: 12, opacity: 0.6 }}>{t('paired.loading')}</div>
          ) : list.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.6 }}>{t('paired.empty')}</div>
          ) : list.map((d) => (
            <div key={d.udid} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 6,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 9,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{nameOf(d)}</div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginTop: 4, fontSize: 10.5, opacity: 0.85 }}>
                  {d.usb && <span style={tagStyle('100, 170, 255')}>USB</span>}
                  {d.wifi && <span style={tagStyle('76, 175, 80')}>WiFi</span>}
                  {d.connected && <span style={tagStyle('255, 200, 90')}>{t('paired.connected')}</span>}
                  {d.last_used > 0 && (
                    <span style={{ opacity: 0.6 }}>
                      {t('paired.last_used', { date: new Date(d.last_used).toLocaleDateString() })}
                    </span>
                  )}
                </div>
                {d.name || knownNames[d.udid] ? (
                  <div style={{ fontFamily: 'monospace', fontSize: 9.5, opacity: 0.4, marginTop: 3, overflowWrap: 'anywhere' }}>{d.udid}</div>
                ) : null}
              </div>
              <button
                onClick={() => setConfirm(d)}
                disabled={busy}
                title={t('paired.unpair')}
                aria-label={t('paired.unpair')}
                style={{
                  flexShrink: 0, width: 28, height: 28, borderRadius: 7, cursor: busy ? 'default' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  border: '1px solid rgba(244, 67, 54, 0.45)', background: 'rgba(244, 67, 54, 0.08)', color: '#f44336',
                  opacity: busy && busyUdid !== d.udid ? 0.4 : 1,
                }}
              >
                {busyUdid === d.udid ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                    <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="16" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                    <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                )}
              </button>
            </div>
          ))}
        </div>

        {confirm && (
          <div style={{
            marginTop: 8, padding: '10px 12px', borderRadius: 9,
            background: 'rgba(244, 67, 54, 0.08)', border: '1px solid rgba(244, 67, 54, 0.35)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{t('paired.confirm', { name: nameOf(confirm) })}</div>
            {confirm.connected && (
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>{t('paired.confirm_connected')}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button
                onClick={() => setConfirm(null)}
                style={{ padding: '5px 14px', fontSize: 12, borderRadius: 5, background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: 'pointer' }}
              >{t('paired.cancel')}</button>
              <button
                onClick={() => doUnpair(confirm)}
                style={{ padding: '5px 14px', fontSize: 12, borderRadius: 5, background: '#e53935', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}
              >{t('paired.confirm_ok')}</button>
            </div>
          </div>
        )}

        {msg && (
          <div style={{ fontSize: 12, lineHeight: 1.55, marginTop: 10, color: msg.ok ? '#7ee2a4' : '#ffb27a' }}>{msg.text}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5, background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: busy ? 'default' : 'pointer' }}
          >{t('paired.close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default PairedDevicesDialog;
