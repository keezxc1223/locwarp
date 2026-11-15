import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  wifiDiagnose, wifiFirewallRepair,
  type WifiDiagnoseCheck, type WifiDiagnoseResult,
} from '../services/api';
import { useT, type StringKey } from '../i18n';

interface Props {
  /** The IP in the tunnel form when the dialog was opened; may be empty. */
  ip: string;
  onClose: () => void;
  /** Put an iPhone the diagnosis found into the tunnel form. */
  onUseDevice: (ip: string, port: number) => void;
}

type T = ReturnType<typeof useT>;

const STATUS_STYLE: Record<WifiDiagnoseCheck['status'], { mark: string; color: string }> = {
  ok: { mark: '✓', color: '#4caf50' },
  warn: { mark: '!', color: '#ffc107' },
  fail: { mark: '✕', color: '#f44336' },
  skip: { mark: '-', color: 'rgba(255,255,255,0.35)' },
};

const PROFILE_KEY: Record<string, StringKey> = {
  Public: 'wifi.diag_profile_public',
  Private: 'wifi.diag_profile_private',
  Domain: 'wifi.diag_profile_domain',
};

function deviceList(check: WifiDiagnoseCheck): string {
  return (check.data.devices || []).map((d) => d.ip).join(', ');
}

/** The one-line finding shown next to a check. */
function describe(check: WifiDiagnoseCheck, t: T): string {
  const d = check.data;
  switch (check.id) {
    case 'adapter': {
      if (check.status === 'fail') return t('wifi.diag_adapter_fail');
      const vars = { name: d.name || '?', ip: d.ip || '' };
      if (d.vpn) return t('wifi.diag_adapter_vpn', vars);
      if (d.others?.length) return t('wifi.diag_adapter_others', { ...vars, others: d.others.join(', ') });
      return t('wifi.diag_adapter_ok', vars);
    }
    case 'subnet':
      if (check.status === 'skip') return t('wifi.diag_need_ip');
      if (check.status === 'ok') return t('wifi.diag_subnet_ok', { network: d.network || '' });
      if (check.status === 'warn') return t('wifi.diag_subnet_via', { via: d.via || '' });
      return t('wifi.diag_subnet_fail', { network: d.network || d.local_ip || '', ip: d.ip || '' });
    case 'reach':
      if (check.status === 'skip') return t('wifi.diag_need_ip');
      if (check.status === 'ok') return t('wifi.diag_reach_ok');
      if (d.state === 'open') return t('wifi.diag_reach_open', { ip: d.ip || '' });
      if (d.ping) return t('wifi.diag_reach_other_device', { ip: d.ip || '' });
      return t('wifi.diag_reach_closed', { ip: d.ip || '' });
    case 'pair':
      if (check.status === 'skip') return t('wifi.diag_unknown');
      return check.status === 'ok'
        ? t('wifi.diag_pair_ok', { count: d.count ?? 0 })
        : t('wifi.diag_pair_fail');
    case 'firewall': {
      if (check.status === 'skip') return t('wifi.diag_unknown');
      if (d.state === 'off') return t('wifi.diag_firewall_off');
      if (check.status === 'ok') return t('wifi.diag_firewall_ok');
      const bad = (d.networks || []).filter((n) => n.status === 'blocked' || n.status === 'missing');
      const profile = [...new Set(bad.map((n) => t(PROFILE_KEY[n.profile] || 'wifi.diag_profile_public')))].join(', ');
      return t(d.state === 'blocked' ? 'wifi.diag_firewall_blocked' : 'wifi.diag_firewall_missing', { profile });
    }
    case 'mdns_send':
      return t(check.status === 'ok' ? 'wifi.diag_send_ok' : 'wifi.diag_send_fail');
    case 'mdns_browse':
      if (check.status === 'ok') return t('wifi.diag_browse_ok', { list: deviceList(check) });
      if (check.status === 'warn') return t('wifi.diag_browse_other', { list: deviceList(check) });
      return t('wifi.diag_browse_fail');
    default:
      return '';
  }
}

/** The conclusion's advice, with the specifics of this run filled in. */
function advice(result: WifiDiagnoseResult, t: T): string {
  const byId = Object.fromEntries(result.checks.map((c) => [c.id, c])) as Record<string, WifiDiagnoseCheck>;
  const adapter = byId.adapter?.data || {};
  const subnet = byId.subnet?.data || {};
  const vars = {
    name: adapter.name || '?',
    network: subnet.network || subnet.local_ip || '',
    ip: result.ip || '',
  };
  let text = t(`wifi.diag_v_${result.verdict}_body` as StringKey, vars);
  if (result.verdict === 'firewall_blocked') {
    text = t(result.admin ? 'wifi.diag_v_firewall_blocked_admin' : 'wifi.diag_v_firewall_blocked_noadmin') + '\n' + text;
  }
  if (result.verdict === 'mdns_no_reply' && adapter.others?.length) {
    text += '\n' + t('wifi.diag_v_try_close_vpn', { others: adapter.others.join(', ') });
  }
  return text;
}

const VERDICT_OK = new Set(['all_ok']);

const WifiDiagnoseDialog: React.FC<Props> = ({ ip, onClose, onUseDevice }) => {
  const t = useT();
  const [targetIp, setTargetIp] = useState(ip.trim());
  const [result, setResult] = useState<WifiDiagnoseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Only the newest run may write its result (re-run, repair, "use this IP").
  const runSeq = useRef(0);

  const run = useCallback(async (forIp: string) => {
    const seq = ++runSeq.current;
    setRunning(true);
    setError(null);
    setCopied(false);
    try {
      const res = await wifiDiagnose(forIp);
      if (seq === runSeq.current) setResult(res);
    } catch (err: any) {
      if (seq === runSeq.current) {
        setResult(null);
        setError(err?.message || t('wifi.diag_failed'));
      }
    } finally {
      if (seq === runSeq.current) setRunning(false);
    }
  }, [t]);

  useEffect(() => {
    run(targetIp);
    return () => { runSeq.current++; };
    // Runs once on open; later runs are started by the buttons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const repairFirewall = async () => {
    setRepairing(true);
    setRepairError(null);
    try {
      await wifiFirewallRepair();
      await run(targetIp);
    } catch (err: any) {
      setRepairError(err?.message || t('wifi.diag_repair_failed'));
    } finally {
      setRepairing(false);
    }
  };

  const pickDevice = (devIp: string, port: number) => {
    onUseDevice(devIp, port);
    setTargetIp(devIp);
    run(devIp);
  };

  const copyResult = async () => {
    if (!result) return;
    const lines = [
      `LocWarp WiFi ${t('wifi.diag_title')}`,
      `${t(`wifi.diag_v_${result.verdict}_title` as StringKey)} [${result.verdict}]`,
      `PC ${result.local_ip || '-'} / iPhone ${result.ip || '-'} (${result.ip_source || '-'})`,
      ...result.checks.map((c) => (
        `[${STATUS_STYLE[c.status].mark}] ${t(`wifi.diag_c_${c.id}` as StringKey)}: ${describe(c, t)}`
      )),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
    } catch { /* clipboard unavailable: nothing to report */ }
  };

  const ok = result ? VERDICT_OK.has(result.verdict) : false;
  const accent = ok ? '#4caf50' : '#ffc107';
  const btn: React.CSSProperties = {
    padding: '7px 16px', fontSize: 12, borderRadius: 5, cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.85)',
  };

  return createPortal(
    <div
      onClick={onClose}
      className="anim-fade-in"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(8, 10, 20, 0.55)',
        backdropFilter: 'blur(4px)', animation: 'var(--anim-scrim)', WebkitBackdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="anim-scale-in"
        style={{
          background: 'var(--glass-pop)',
          backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
          border: '1px solid rgba(var(--accent-rgb), 0.2)', borderRadius: 14,
          padding: 24, maxWidth: 540, width: '100%',
          maxHeight: '86vh', overflowY: 'auto',
          color: '#e8e8e8',
          boxShadow: 'var(--shadow-pop)', animation: 'var(--anim-pop)',
        }}
      >
        <strong style={{ fontSize: 16 }}>{t('wifi.diag_title')}</strong>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4, marginBottom: 14 }}>
          {running
            ? t('wifi.diag_running')
            : result?.ip
              ? t(result.ip_source === 'mdns' ? 'wifi.diag_target_mdns' : 'wifi.diag_target', { ip: result.ip })
              : result ? t('wifi.diag_target_none') : ''}
        </div>

        {error && (
          <div style={{ fontSize: 12, color: '#f44336', padding: '8px 10px', background: 'rgba(244,67,54,0.1)', borderRadius: 5 }}>
            {error}
          </div>
        )}

        {result && (
          <div style={{ opacity: running ? 0.45 : 1, transition: 'opacity 0.15s' }}>
            <div style={{
              padding: '12px 14px', borderRadius: 8, marginBottom: 14,
              background: ok ? 'rgba(76,175,80,0.1)' : 'rgba(255,193,7,0.08)',
              border: `1px solid ${ok ? 'rgba(76,175,80,0.4)' : 'rgba(255,193,7,0.4)'}`,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: accent, marginBottom: 6 }}>
                {t(`wifi.diag_v_${result.verdict}_title` as StringKey)}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-line', opacity: 0.92 }}>
                {advice(result, t)}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {result.checks.map((c) => {
                const st = STATUS_STYLE[c.status];
                const others = c.id === 'mdns_browse' && c.status === 'warn' ? (c.data.devices || []) : [];
                return (
                  <div key={c.id} style={{ display: 'flex', gap: 10, padding: '7px 2px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                    <span style={{
                      flexShrink: 0, width: 18, height: 18, borderRadius: '50%', marginTop: 1,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 700, color: st.color,
                      border: `1px solid ${st.color}`,
                    }}>{st.mark}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{t(`wifi.diag_c_${c.id}` as StringKey)}</div>
                      <div style={{ fontSize: 11, opacity: 0.75, overflowWrap: 'anywhere', lineHeight: 1.5 }}>
                        {describe(c, t)}
                      </div>
                      {others.map((d) => (
                        <button
                          key={`${d.ip}:${d.port}`}
                          onClick={() => pickDevice(d.ip, d.port)}
                          disabled={running}
                          style={{ ...btn, padding: '3px 10px', fontSize: 11, marginTop: 5, marginRight: 6 }}
                        >{t('wifi.diag_use_ip', { ip: d.ip })}</button>
                      ))}
                      {c.id === 'firewall' && c.status === 'fail' && (
                        <div style={{ marginTop: 5 }}>
                          <button
                            onClick={repairFirewall}
                            disabled={repairing || running}
                            style={{
                              ...btn, padding: '4px 12px', fontSize: 11,
                              border: '1px solid rgba(255,193,7,0.45)', background: 'rgba(255,193,7,0.1)', color: '#ffc107',
                              cursor: repairing ? 'wait' : 'pointer',
                            }}
                          >{repairing ? t('wifi.diag_repairing') : t('wifi.diag_repair')}</button>
                          {repairError && (
                            <div style={{ fontSize: 11, color: '#f44336', marginTop: 4 }}>{repairError}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          {result && (
            <button onClick={copyResult} style={btn}>
              {copied ? t('wifi.diag_copied') : t('wifi.diag_copy')}
            </button>
          )}
          <button onClick={() => run(targetIp)} disabled={running} style={{ ...btn, opacity: running ? 0.5 : 1 }}>
            {t('wifi.diag_rerun')}
          </button>
          <button
            onClick={onClose}
            style={{ ...btn, background: 'var(--accent-blue)', color: '#fff', border: 'none', fontWeight: 600 }}
          >{t('wifi.diag_close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default WifiDiagnoseDialog;
