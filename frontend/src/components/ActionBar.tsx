/**
 * ActionBar — 52px persistent control bar
 *
 * Primary simulation control buttons (Start / Pause / Resume / Stop / Restore)
 * plus an inline ETA strip that only appears while a route is active.
 * Drawing-mode toggle is also here (only in waypoint modes).
 *
 * Always visible regardless of which side panel is open.
 */
import React from 'react'
import { useT } from '../i18n'
import { SimMode } from '../hooks/useSimulation'

const ACTIVE_STATES = ['navigating', 'looping', 'multi_stop', 'random_walk']

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

function formatTime(s: number): string {
  if (s <= 0) return '0s'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

interface ActionBarProps {
  simMode: SimMode
  isRunning: boolean
  isPaused: boolean
  deviceConnected: boolean
  state: string
  progress: number        // 0–1
  eta: number             // seconds
  remainingDistance: number
  traveledDistance: number
  drawingMode: boolean
  showDrawingToggle: boolean
  onDrawingToggle: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onRestore: () => void
}

// Modes where Start button makes sense (not Teleport / Navigate — those trigger on map click)
const START_MODES: SimMode[] = [SimMode.Joystick, SimMode.Loop, SimMode.MultiStop, SimMode.RandomWalk]

const ActionBar: React.FC<ActionBarProps> = ({
  simMode,
  isRunning,
  isPaused,
  deviceConnected,
  state,
  progress,
  eta,
  remainingDistance,
  drawingMode,
  showDrawingToggle,
  onDrawingToggle,
  onStart,
  onPause,
  onResume,
  onStop,
  onRestore,
}) => {
  const t = useT()
  const percent = Math.min(Math.max(progress * 100, 0), 100)
  const showEta = ACTIVE_STATES.includes(state)

  return (
    <div className="action-bar">
      <div className="action-bar-btns">

        {/* Drawing mode toggle */}
        {showDrawingToggle && (
          <button
            className={`action-bar-btn action-bar-btn--draw${drawingMode ? ' active' : ''}`}
            onClick={onDrawingToggle}
            title={drawingMode ? '關閉繪圖模式' : '開啟繪圖模式（點地圖新增航點）'}
          >
            ✏️
            <span className="action-bar-btn-label">{drawingMode ? '繪圖中' : '繪圖'}</span>
          </button>
        )}

        {/* Restore */}
        <button
          className="action-bar-btn action-bar-btn--restore"
          onClick={onRestore}
          disabled={!deviceConnected}
          title={t('status.restore_tooltip')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="1,4 1,10 7,10" />
            <path d="M3.51 15a9 9 0 1 0 .49-4.5" />
          </svg>
          <span className="action-bar-btn-label">{t('status.restore')}</span>
        </button>

        {/* Stop */}
        {(isRunning || isPaused) && (
          <button
            className="action-bar-btn action-bar-btn--stop"
            onClick={onStop}
            title={t('generic.stop')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
            <span className="action-bar-btn-label">{t('generic.stop')}</span>
          </button>
        )}

        {/* Pause */}
        {isRunning && !isPaused && (
          <button
            className="action-bar-btn action-bar-btn--pause"
            onClick={onPause}
            title={t('generic.pause')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
            <span className="action-bar-btn-label">{t('generic.pause')}</span>
          </button>
        )}

        {/* Resume */}
        {isPaused && (
          <button
            className="action-bar-btn action-bar-btn--resume"
            onClick={onResume}
            title={t('generic.resume')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            <span className="action-bar-btn-label">{t('generic.resume')}</span>
          </button>
        )}

        {/* Start — only shown for modes that need an explicit Start click */}
        {!isRunning && !isPaused && START_MODES.includes(simMode) && (
          <button
            className="action-bar-btn action-bar-btn--start"
            onClick={onStart}
            disabled={!deviceConnected}
            title={t('generic.start')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            <span className="action-bar-btn-label">{t('generic.start')}</span>
          </button>
        )}

        {/* ETA inline (only while route active) */}
        {showEta && (
          <>
            <div className="action-bar-btn-vsep" />

            {/* Progress track */}
            <div className="action-bar-eta-inline">
              <div className="action-bar-eta-track">
                <div className="action-bar-eta-fill" style={{ width: `${percent}%` }} />
              </div>
              <span className="action-bar-eta-pct">{percent.toFixed(0)}%</span>
            </div>

            <div className="action-bar-btn-vsep" />

            <div className="action-bar-eta-stat">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity={0.5}>
                <circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" />
              </svg>
              <span>{formatDistance(remainingDistance)}</span>
            </div>

            <div className="action-bar-btn-vsep" />

            <div className="action-bar-eta-stat action-bar-eta-stat--time">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity={0.5}>
                <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
              </svg>
              <span>{formatTime(eta)}</span>
            </div>
          </>
        )}

        {/* Spacer pushes nothing (we keep buttons left-aligned) */}
      </div>
    </div>
  )
}

export default ActionBar
