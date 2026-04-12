import React from 'react';
import { useT } from '../i18n';

interface EtaBarProps {
  state: string;
  progress: number; // 0 to 1
  remainingDistance: number; // meters
  traveledDistance: number; // meters
  eta: number; // seconds remaining
}

const ACTIVE_STATES = ['navigating', 'looping', 'multi_stop', 'random_walk'];

function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const EtaBar: React.FC<EtaBarProps> = ({
  state,
  progress,
  remainingDistance,
  traveledDistance,
  eta,
}) => {
  const t = useT();
  if (!ACTIVE_STATES.includes(state)) return null;

  const percent = Math.min(Math.max(progress * 100, 0), 100);

  return (
    <div
      className="eta-bar"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 900,
        background: 'rgba(30, 30, 40, 0.85)',
        backdropFilter: 'blur(4px)',
        padding: '6px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        fontSize: 12,
        color: '#e0e0e0',
      }}
    >
      {/* Progress bar */}
      <div
        style={{
          flex: 1,
          height: 4,
          borderRadius: 2,
          background: 'rgba(255,255,255,0.1)',
          overflow: 'hidden',
          minWidth: 80,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${percent}%`,
            borderRadius: 2,
            background: 'linear-gradient(90deg, #4285f4, #34a853)',
            transition: 'width 0.5s ease-out',
          }}
        />
      </div>

      {/* Percentage */}
      <span style={{ fontWeight: 600, minWidth: 38, textAlign: 'right' }}>
        {percent.toFixed(0)}%
      </span>

      {/* Separator */}
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />

      {/* Remaining distance */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12,6 12,12 16,14" />
        </svg>
        <span>{t('eta.remaining')} {formatDistance(remainingDistance)}</span>
      </div>

      {/* Separator */}
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />

      {/* ETA */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
          <path d="M5 12h14" />
          <path d="M12 5l7 7-7 7" />
        </svg>
        <span>{t('eta.eta')} {formatTime(eta)}</span>
      </div>

      {/* Separator */}
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />

      {/* Traveled distance */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: 0.7 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
          <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
        </svg>
        <span>{t('eta.traveled')} {formatDistance(traveledDistance)}</span>
      </div>
    </div>
  );
};

export default EtaBar;
