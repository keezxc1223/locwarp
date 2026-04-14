import React, { useState, useEffect, useCallback } from 'react'
import * as api from '../services/api'
import type { WsMessage } from '../hooks/useWebSocket'

interface Props {
  currentPosition?: { lat: number; lng: number } | null
  wsMessage: WsMessage | null
  onGeofenceChange?: (gf: { lat: number; lng: number; radius_m: number } | null) => void
}

const GeofencePanel: React.FC<Props> = ({ currentPosition, wsMessage, onGeofenceChange }) => {
  const [expanded, setExpanded]     = useState(false)
  const [active, setActive]         = useState(false)
  const [center, setCenter]         = useState<{ lat: number; lng: number } | null>(null)
  const [radius, setRadius]         = useState(200)
  const [autoReturn, setAutoReturn] = useState(true)
  const [loading, setLoading]       = useState(false)
  const [toast, setToast]           = useState<string | null>(null)

  const showToast = (msg: string, ms = 2500) => {
    setToast(msg)
    setTimeout(() => setToast(null), ms)
  }

  // Load existing geofence on mount
  useEffect(() => {
    api.getGeofence().then((r: any) => {
      if (r.enabled) {
        setActive(true)
        setCenter({ lat: r.lat, lng: r.lng })
        setRadius(r.radius_m)
        setAutoReturn(r.auto_return)
        onGeofenceChange?.({ lat: r.lat, lng: r.lng, radius_m: r.radius_m })
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket events
  useEffect(() => {
    if (!wsMessage) return
    if (wsMessage.type === 'geofence_violated') {
      showToast('🚧 已離開圍欄範圍！', 4000)
    }
  }, [wsMessage])

  const handleSet = useCallback(async () => {
    const pos = currentPosition
    if (!pos) {
      showToast('請先取得當前位置')
      return
    }
    setLoading(true)
    try {
      await api.setGeofence(pos.lat, pos.lng, radius, autoReturn)
      setCenter(pos)
      setActive(true)
      onGeofenceChange?.({ lat: pos.lat, lng: pos.lng, radius_m: radius })
      showToast('✓ 圍欄已設定')
    } catch (e: any) {
      showToast(e.message)
    } finally {
      setLoading(false)
    }
  }, [currentPosition, radius, autoReturn, onGeofenceChange])

  const handleClear = useCallback(async () => {
    await api.clearGeofence().catch(() => {})
    setActive(false)
    setCenter(null)
    onGeofenceChange?.(null)
  }, [onGeofenceChange])

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        <span style={{ fontSize: 16 }}>🔵</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>地理圍欄</span>
        {active && (
          <span style={{
            fontSize: 10, color: '#67e8f9',
            background: 'rgba(6,182,212,0.15)', padding: '1px 6px', borderRadius: 8,
          }}>啟用中</span>
        )}
        <span style={{ fontSize: 11, color: '#64748b' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {active && center ? (
            <div style={{
              marginBottom: 10, background: 'rgba(6,182,212,0.06)',
              border: '1px solid rgba(6,182,212,0.2)', borderRadius: 6, padding: '6px 10px',
            }}>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                中心：{center.lat.toFixed(5)}, {center.lng.toFixed(5)}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                半徑 {radius} m　超出：{autoReturn ? '自動回中心' : '發出警告'}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
              將以當前位置為圍欄中心
            </div>
          )}

          {/* Radius input */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, width: 36 }}>半徑</span>
            <input
              type="number" min={50} max={10000}
              value={radius}
              onChange={e => setRadius(Math.max(50, parseInt(e.target.value) || 200))}
              style={{
                flex: 1, fontSize: 12, padding: '3px 6px',
                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 5, color: '#e2e8f0',
              }}
            />
            <span style={{ fontSize: 11, color: '#64748b' }}>m</span>
          </div>

          {/* Auto-return toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 12, flex: 1 }}>超出自動回中心</span>
            <button
              onClick={() => setAutoReturn(v => !v)}
              style={{
                padding: '2px 12px', fontSize: 11, borderRadius: 10, cursor: 'pointer',
                background: autoReturn ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${autoReturn ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.12)'}`,
                color: autoReturn ? '#86efac' : '#94a3b8',
              }}
            >
              {autoReturn ? '開' : '關'}
            </button>
          </div>

          {active ? (
            <button
              className="btn btn-sm btn-danger"
              onClick={handleClear}
              style={{ width: '100%', fontSize: 12 }}
            >
              解除圍欄
            </button>
          ) : (
            <button
              onClick={handleSet}
              disabled={loading || !currentPosition}
              style={{
                width: '100%', fontSize: 12, padding: '5px 0', borderRadius: 6, cursor: 'pointer',
                background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.35)',
                color: '#67e8f9', opacity: (!currentPosition || loading) ? 0.5 : 1,
              }}
            >
              {loading ? '設定中…' : '以當前位置設定圍欄'}
            </button>
          )}

          {toast && (
            <div style={{
              marginTop: 6, fontSize: 12, padding: '5px 8px', borderRadius: 5,
              color: toast.includes('🚧') ? '#f87171' : '#86efac',
              background: toast.includes('🚧') ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.08)',
            }}>
              {toast}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default GeofencePanel
