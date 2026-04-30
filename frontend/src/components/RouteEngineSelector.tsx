import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

export type RouteEngine = 'osrm' | 'osrm_fossgis' | 'valhalla' | 'brouter';

interface Props {
  value: RouteEngine;
  onChange: (v: RouteEngine) => void;
  disabled?: boolean;
}

const ENGINE_META: Record<RouteEngine, { color: string; dot: string; label: string }> = {
  osrm:         { color: 'rgba(108, 140, 255, 0.18)', dot: '#6c8cff', label: 'OSRM demo' },
  osrm_fossgis: { color: 'rgba(108, 140, 255, 0.18)', dot: '#9ac0ff', label: 'OSRM FOSSGIS' },
  valhalla:     { color: 'rgba(255, 186, 107, 0.20)', dot: '#ffba6b', label: 'Valhalla' },
  brouter:      { color: 'rgba(140, 220, 140, 0.18)', dot: '#7fd17f', label: 'BRouter' },
};

const RouteEngineSelector: React.FC<Props> = ({ value, onChange, disabled }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const meta = ENGINE_META[value];

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={t('panel.route_engine_tooltip')}
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: disabled ? 'rgba(255, 255, 255, 0.04)' : meta.color,
          border: `1px solid ${disabled ? 'rgba(255, 255, 255, 0.10)' : 'rgba(108, 140, 255, 0.32)'}`,
          borderRadius: 6,
          color: disabled ? '#6e7180' : '#e8eaf0',
          fontSize: 11,
          fontWeight: 500,
          cursor: disabled ? 'not-allowed' : 'pointer',
          width: '100%',
          textAlign: 'left',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: meta.dot,
            boxShadow: disabled ? 'none' : `0 0 6px ${meta.dot}`,
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, lineHeight: 1.15 }}>
          {t('panel.route_engine')}
          <span style={{ marginLeft: 6, opacity: 0.8 }}>· {meta.label}</span>
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ opacity: 0.5 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && createPortal(
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9000,
            background: 'rgba(8, 11, 22, 0.6)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            className="anim-fade-slide-up"
            style={{
              width: 480, maxWidth: '100%',
              maxHeight: 'calc(100vh - 60px)',
              overflowY: 'auto',
              background: 'rgba(26, 29, 39, 0.97)',
              backdropFilter: 'blur(16px) saturate(160%)',
              WebkitBackdropFilter: 'blur(16px) saturate(160%)',
              border: '1px solid rgba(108, 140, 255, 0.32)',
              borderRadius: 12,
              padding: '20px 22px',
              color: '#e8eaf0',
              boxShadow: '0 24px 60px rgba(8, 11, 22, 0.7)',
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 14,
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#9ac0ff' }}>
                {t('panel.route_engine_title')}
              </div>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: 'transparent', border: 'none',
                  color: '#9499ac', fontSize: 20, lineHeight: 1,
                  padding: '4px 8px', cursor: 'pointer', borderRadius: 4,
                }}
                aria-label="close"
              >×</button>
            </div>

            {(['osrm', 'osrm_fossgis', 'valhalla', 'brouter'] as RouteEngine[]).map((eng) => {
              const m = ENGINE_META[eng];
              const active = value === eng;
              return (
                <label
                  key={eng}
                  onClick={() => { onChange(eng); }}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '12px 14px', borderRadius: 8, cursor: 'pointer',
                    background: active ? m.color : 'rgba(255, 255, 255, 0.02)',
                    border: `1px solid ${active ? 'rgba(108, 140, 255, 0.32)' : 'rgba(255, 255, 255, 0.06)'}`,
                    marginBottom: 10,
                    transition: 'all 0.16s',
                  }}
                >
                  <input
                    type="radio"
                    name="route-engine-modal"
                    checked={active}
                    onChange={() => onChange(eng)}
                    style={{ marginTop: 3, accentColor: '#6c8cff' }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontWeight: 700, fontSize: 13.5,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <span
                        style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: m.dot,
                          boxShadow: `0 0 6px ${m.dot}`,
                        }}
                      />
                      {m.label}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4, lineHeight: 1.55 }}>
                      {t(`panel.route_engine_${eng}_desc`)}
                    </div>
                  </div>
                </label>
              );
            })}

            <div style={{ marginTop: 6, textAlign: 'right' }}>
              <button
                onClick={() => setOpen(false)}
                className="action-btn"
                style={{ fontSize: 12, padding: '6px 18px' }}
              >
                {t('generic.confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default RouteEngineSelector;
