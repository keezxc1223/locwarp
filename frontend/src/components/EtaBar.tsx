import React from 'react';
import { useT } from '../i18n';
import type { RuntimesMap } from '../hooks/useSimulation';

interface EtaBarProps {
  state: string;
  progress: number; // 0 to 1
  remainingDistance: number; // meters — full lap / trip
  traveledDistance: number; // meters
  eta: number; // seconds remaining for full lap / trip
  legRemainingDistance?: number; // meters to next waypoint (multi_stop / loop)
  legEta?: number; // seconds to next waypoint
  runtimes?: RuntimesMap;
}

const ACTIVE_STATES = ['navigating', 'looping', 'multi_stop', 'random_walk', 'flower'];

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
  legRemainingDistance,
  legEta,
  runtimes,
}) => {
  const t = useT();

  // Group-mode aggregation: if 2+ device runtimes report an active state, use
  // the fleet's average progress / max ETA instead of the single-device props.
  const activeRuntimes = runtimes
    ? Object.values(runtimes).filter((r) => ACTIVE_STATES.includes(r.state))
    : [];
  const isGroup = activeRuntimes.length >= 2;

  if (!isGroup && !ACTIVE_STATES.includes(state)) return null;
  if (isGroup && activeRuntimes.length === 0) return null;

  const aggProgress = isGroup
    ? activeRuntimes.reduce((s, r) => s + (r.progress || 0), 0) / activeRuntimes.length
    : progress;
  const aggEta = isGroup
    ? Math.max(...activeRuntimes.map((r) => r.eta || 0))
    : eta;
  const aggRemaining = isGroup
    ? Math.max(...activeRuntimes.map((r) => r.distanceRemaining || 0))
    : remainingDistance;
  const aggTraveled = isGroup
    ? activeRuntimes.reduce((s, r) => s + (r.distanceTraveled || 0), 0)
    : traveledDistance;

  const percent = Math.min(Math.max(aggProgress * 100, 0), 100);

  // The "next stop" pair only shows up when the per-leg countdown is
  // meaningfully shorter than the whole lap / trip — i.e. multi_stop or
  // route_loop with legs still queued after the current one. Single-leg
  // modes (navigate / random_walk) emit equal values, and in that case we
  // collapse back to the original layout so the bar stays unchanged.
  const showLegPair = !isGroup
    && legRemainingDistance != null
    && legEta != null
    && aggRemaining - legRemainingDistance > 1;

  const separator = (
    <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />
  );

  const clockIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12,6 12,12 16,14" />
    </svg>
  );
  const arrowIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </svg>
  );
  const traveledIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
      <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
    </svg>
  );

  // Pick the label for the "whole" pair. Differs by mode so the user knows
  // whether the total is "lap" (close the loop) or "trip" (reach the last
  // waypoint). Falls back to the original "remaining" label otherwise.
  const totalLabel = state === 'looping'
    ? t('eta.lap')
    : (state === 'multi_stop' ? t('eta.trip') : t('eta.remaining'));

  return (
    <div
      className="eta-bar"
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        right: 10,
        zIndex: 850,
        background: 'rgba(18, 21, 32, 0.72)',
        backdropFilter: 'blur(24px) saturate(160%)',
        WebkitBackdropFilter: 'blur(24px) saturate(160%)',
        padding: '7px 18px',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        rowGap: 6,
        gap: 16,
        fontSize: 12,
        color: '#e8eaf0',
        border: '1px solid rgba(108, 140, 255, 0.18)',
        borderRadius: 18,
        boxShadow:
          '0 12px 32px rgba(12, 18, 40, 0.45), 0 2px 6px rgba(12, 18, 40, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
        letterSpacing: '-0.005em',
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

      {separator}

      {showLegPair ? (
        <>
          {/* Next-stop pair: distance · ETA */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {clockIcon}
            <span>
              {t('eta.next_stop')} {formatDistance(legRemainingDistance!)} · {formatTime(legEta!)}
            </span>
          </div>
          {separator}
          {/* Whole-lap / trip pair: distance · ETA */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {arrowIcon}
            <span>
              {totalLabel} {formatDistance(aggRemaining)} · {formatTime(aggEta)}
            </span>
          </div>
        </>
      ) : (
        <>
          {/* Single pair: remaining distance + ETA (navigate / random_walk) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {clockIcon}
            <span>{t('eta.remaining')} {formatDistance(aggRemaining)}</span>
          </div>
          {separator}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {arrowIcon}
            <span>{t('eta.eta')} {formatTime(aggEta)}</span>
          </div>
        </>
      )}

      {separator}

      {/* Traveled distance */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: 0.7 }}>
        {traveledIcon}
        <span>{t('eta.traveled')} {formatDistance(aggTraveled)}</span>
      </div>

      {isGroup && (
        <>
          {separator}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.85 }}>
            <span style={{ opacity: 0.6 }}>{t('eta.group_progress')}</span>
            {activeRuntimes.slice(0, 2).map((r, i) => (
              <span key={r.udid} style={{ color: i === 0 ? '#4285f4' : '#ff9800', fontWeight: 600 }}>
                {i === 0 ? 'A' : 'B'} {formatTime(r.eta || 0)}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default EtaBar;
