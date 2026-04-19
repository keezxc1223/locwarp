/**
 * WaypointList — drag-reorderable list of waypoints with per-mode pause
 * controls and a start/clear row.
 *
 * Previously lived as 70 lines of inline JSX passed via the
 * `modeExtraSection` prop on ControlPanel. That hid state (dragWpIdx /
 * dragWpOver) and a fair chunk of logic inside App.tsx's render tree,
 * which made the parent harder to scan.
 *
 * The drag-drop state is local — no other component cares whether a row
 * is currently being dragged, so there's no reason to lift it.
 *
 * The component stays presentational: all mutations go through the
 * passed-in `onReorder` / `onRemove` / `onClear` / `onStart` callbacks.
 */
import React, { useState } from 'react'
import { useT } from '../i18n'
import { SimMode } from '../hooks/useSimulation'
import PauseControl from './PauseControl'
import type { LatLng } from '../hooks/useSimulation'
import type { PauseSetting } from '../hooks/usePauseSettings'

interface WaypointListProps {
  mode: SimMode
  waypoints: LatLng[]
  hasCurrentPosition: boolean
  pauseLoop: PauseSetting
  setPauseLoop: (v: PauseSetting) => void
  pauseMultiStop: PauseSetting
  setPauseMultiStop: (v: PauseSetting) => void
  onReorder: (from: number, to: number) => void
  onRemove: (index: number) => void
  onClear: () => void
  onStart: () => void
}

const WaypointList: React.FC<WaypointListProps> = ({
  mode, waypoints, hasCurrentPosition,
  pauseLoop, setPauseLoop, pauseMultiStop, setPauseMultiStop,
  onReorder, onRemove, onClear, onStart,
}) => {
  const t = useT()
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const handleDrop = (targetIdx: number) => {
    if (dragIdx === null || dragIdx === targetIdx) {
      setDragIdx(null); setDragOver(null); return
    }
    onReorder(dragIdx, targetIdx)
    setDragIdx(null); setDragOver(null)
  }

  const isLoop = mode === SimMode.Loop

  return (
    <div className="section" style={{ margin: '0 0 8px 0', padding: '0 0 2px 0' }}>
      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="5" x2="12" y2="1" />
          <line x1="12" y1="23" x2="12" y2="19" />
        </svg>
        {t('panel.waypoints')} ({waypoints.length})
        <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>{t('panel.waypoints_hint')}</span>
      </div>
      <div className="section-content">
        <PauseControl
          labelKey={isLoop ? 'pause.loop' : 'pause.multi_stop'}
          value={isLoop ? pauseLoop : pauseMultiStop}
          onChange={isLoop ? setPauseLoop : setPauseMultiStop}
        />
        {waypoints.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.5, padding: '4px 0' }}>
            {t('panel.waypoints_empty')}
          </div>
        )}
        {waypoints.map((wp, i) => (
          <div
            key={`${wp.lat.toFixed(6)}_${wp.lng.toFixed(6)}_${i}`}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => { e.preventDefault(); setDragOver(i) }}
            onDragEnd={() => { setDragIdx(null); setDragOver(null) }}
            onDrop={() => handleDrop(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '3px 4px', fontSize: 12, borderRadius: 4,
              background: dragOver === i && dragIdx !== i
                ? 'rgba(108,140,255,0.18)' : 'transparent',
              cursor: 'grab', transition: 'background 0.1s',
              outline: dragOver === i && dragIdx !== i
                ? '1px solid rgba(108,140,255,0.4)' : 'none',
            }}
          >
            <span style={{ color: '#64748b', opacity: 0.45, fontSize: 14, lineHeight: 1 }}>⠿</span>
            <span style={{ color: '#ff9800', fontWeight: 600, width: 20 }}>#{i + 1}</span>
            <span style={{ flex: 1, opacity: 0.8 }}>{wp.lat.toFixed(5)}, {wp.lng.toFixed(5)}</span>
            <button
              className="action-btn"
              style={{ padding: '2px 6px', fontSize: 10 }}
              onClick={() => onRemove(i)}
              title={t('panel.waypoints_remove')}
            >✕</button>
          </div>
        ))}
        {waypoints.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              className="action-btn primary"
              style={{ flex: 1 }}
              onClick={onStart}
              disabled={waypoints.length < 1 || !hasCurrentPosition}
            >
              {isLoop
                ? t('panel.waypoints_start_loop')
                : mode === SimMode.MultiStop
                  ? t('panel.waypoints_start_multi')
                  : t('panel.waypoints_start_navigate')}
            </button>
            <button className="action-btn" onClick={onClear}>{t('generic.clear')}</button>
          </div>
        )}
      </div>
    </div>
  )
}

export default WaypointList
