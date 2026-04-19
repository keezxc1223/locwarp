import React, { useState, useEffect, useCallback } from 'react'
import * as api from '../services/api'
import type { WsMessage } from '../hooks/useWebSocket'

interface Props {
  wsMessage: WsMessage | null
  onExpired?: () => void
}

const PRESETS = [
  { label: '15 分', seconds: 15 * 60 },
  { label: '30 分', seconds: 30 * 60 },
  { label: '60 分', seconds: 60 * 60 },
  { label: '2 小時', seconds: 120 * 60 },
]

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const TimerPanel: React.FC<Props> = ({ wsMessage, onExpired }) => {
  const [active, setActive] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const [duration, setDuration] = useState(0)
  const [customMin, setCustomMin] = useState('')
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // Sync state from backend on mount
  useEffect(() => {
    api.timerStatus().then(res => {
      if (res.active) {
        setActive(true)
        setRemaining(res.remaining_seconds)
        setDuration(res.duration_seconds)
      }
    }).catch(() => {})
  }, [])

  // Local countdown tick
  useEffect(() => {
    if (!active || remaining <= 0) return
    const id = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(id); return 0 }
        return r - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [active, remaining])

  // WS event
  useEffect(() => {
    if (!wsMessage) return
    if (wsMessage.type === 'timer_expired') {
      setActive(false)
      setRemaining(0)
      setToast('⏰ 定時結束，已回到預設點')
      onExpired?.()
      setTimeout(() => setToast(null), 4000)
    }
  }, [wsMessage, onExpired])

  const handleStart = useCallback(async (seconds: number) => {
    setLoading(true)
    try {
      await api.timerStart(seconds)
      setActive(true)
      setRemaining(seconds)
      setDuration(seconds)
    } catch (e) {
      setToast(api.errMsg(e))
      setTimeout(() => setToast(null), 3000)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleCancel = useCallback(async () => {
    await api.timerCancel().catch(() => {})
    setActive(false)
    setRemaining(0)
  }, [])

  const handleCustom = () => {
    const m = parseInt(customMin)
    if (!m || m <= 0) return
    handleStart(m * 60)
    setCustomMin('')
  }

  const progress = duration > 0 ? (remaining / duration) : 0

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16 }}>⏱️</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>定時回家</span>
        {active && (
          <span style={{ fontSize: 12, color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>
            {fmtTime(remaining)}
          </span>
        )}
      </div>

      {/* Progress bar */}
      {active && (
        <div style={{ marginTop: 6, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
          <div style={{
            height: '100%', borderRadius: 2,
            background: remaining < 60 ? '#f87171' : '#fbbf24',
            width: `${progress * 100}%`,
            transition: 'width 1s linear',
          }} />
        </div>
      )}

      {/* Active state */}
      {active ? (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#94a3b8', flex: 1 }}>
            時間到自動回到預設點
          </span>
          <button
            className="btn btn-sm btn-danger"
            onClick={handleCancel}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            取消
          </button>
        </div>
      ) : (
        <>
          {/* Preset buttons */}
          <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
            {PRESETS.map(p => (
              <button
                key={p.seconds}
                className="btn btn-sm"
                onClick={() => handleStart(p.seconds)}
                disabled={loading}
                style={{
                  fontSize: 11, padding: '3px 10px',
                  background: 'rgba(251,191,36,0.15)',
                  border: '1px solid rgba(251,191,36,0.3)',
                  color: '#fbbf24', borderRadius: 6,
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom input */}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              type="number"
              min={1}
              placeholder="自訂分鐘"
              value={customMin}
              onChange={e => setCustomMin(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCustom()}
              style={{
                flex: 1, fontSize: 12, padding: '4px 8px',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 6, color: '#e2e8f0',
              }}
            />
            <button
              className="btn btn-sm btn-primary"
              onClick={handleCustom}
              disabled={!customMin || loading}
              style={{ fontSize: 11, padding: '4px 12px' }}
            >
              設定
            </button>
          </div>
        </>
      )}

      {toast && (
        <div style={{
          marginTop: 6, fontSize: 12, color: '#fbbf24',
          background: 'rgba(251,191,36,0.1)',
          padding: '6px 10px', borderRadius: 6,
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

export default TimerPanel
