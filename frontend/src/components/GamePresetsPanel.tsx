import React, { useState, useEffect, useCallback } from 'react'
import * as api from '../services/api'

interface Preset {
  label: string
  game: string
  speedKmh: number
  jitter: boolean
  icon: string
}

const PRESETS: Preset[] = [
  { label: '散步',     game: 'Pokemon GO', speedKmh: 4.5, jitter: true,  icon: '🚶' },
  { label: '腳踏車',  game: 'Pokemon GO', speedKmh: 14,  jitter: true,  icon: '🚴' },
  { label: '開車',    game: 'Pokemon GO', speedKmh: 28,  jitter: false, icon: '🚗' },
  { label: '步行',    game: 'Ingress',    speedKmh: 5,   jitter: true,  icon: '🏃' },
  { label: '腳踏車',  game: 'Ingress',    speedKmh: 15,  jitter: true,  icon: '🚴' },
  { label: '普通',    game: '通用',       speedKmh: 10,  jitter: true,  icon: '🎮' },
  { label: '快速',    game: '通用',       speedKmh: 50,  jitter: false, icon: '✈️' },
]

interface Props {
  onApplyPreset?: (speedKmh: number) => void
}

const GamePresetsPanel: React.FC<Props> = ({ onApplyPreset }) => {
  const [expanded, setExpanded]       = useState(false)
  const [jitter, setJitter]           = useState(true)
  const [activePreset, setActive]     = useState<string | null>(null)
  const [toast, setToast]             = useState<string | null>(null)

  useEffect(() => {
    api.getJitter().then(r => setJitter(r.jitter_enabled)).catch(() => {})
  }, [])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2000)
  }

  const applyPreset = useCallback(async (preset: Preset) => {
    try {
      await api.setJitter(preset.jitter)
      setJitter(preset.jitter)
      onApplyPreset?.(preset.speedKmh)
      setActive(preset.label + preset.game)
      showToast(`✓ ${preset.label} ${preset.speedKmh} km/h`)
    } catch {
      showToast('套用失敗')
    }
  }, [onApplyPreset])

  const toggleJitter = useCallback(async () => {
    const next = !jitter
    await api.setJitter(next).catch(() => {})
    setJitter(next)
  }, [jitter])

  const games = [...new Set(PRESETS.map(p => p.game))]

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
           onClick={() => setExpanded(e => !e)}>
        <span style={{ fontSize: 16 }}>🎮</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>遊戲速度預設</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {/* GPS Jitter toggle */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
            background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: '6px 10px',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12 }}>GPS 抖動偽裝</div>
              <div style={{ fontSize: 10, color: '#64748b' }}>模擬真實行走誤差</div>
            </div>
            <button
              onClick={toggleJitter}
              style={{
                padding: '3px 12px', fontSize: 11, borderRadius: 12, cursor: 'pointer',
                background: jitter ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.08)',
                border: `1px solid ${jitter ? 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.15)'}`,
                color: jitter ? '#86efac' : '#94a3b8',
              }}
            >
              {jitter ? '開啟' : '關閉'}
            </button>
          </div>

          {games.map(game => (
            <div key={game} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4, fontWeight: 600 }}>
                {game}
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {PRESETS.filter(p => p.game === game).map(preset => {
                  const key = preset.label + preset.game
                  const isActive = activePreset === key
                  return (
                    <button
                      key={key}
                      onClick={() => applyPreset(preset)}
                      style={{
                        fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                        background: isActive ? 'rgba(108,140,255,0.25)' : 'rgba(255,255,255,0.06)',
                        border: `1px solid ${isActive ? 'rgba(108,140,255,0.5)' : 'rgba(255,255,255,0.12)'}`,
                        color: isActive ? '#a5b4fc' : '#cbd5e1',
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}
                    >
                      <span>{preset.icon}</span>
                      <span>{preset.label}</span>
                      <span style={{ fontSize: 9, opacity: 0.6 }}>{preset.speedKmh}k</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}

          {toast && (
            <div style={{
              fontSize: 12, color: '#86efac', marginTop: 4,
              background: 'rgba(34,197,94,0.08)', padding: '4px 8px', borderRadius: 4,
            }}>
              {toast}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default GamePresetsPanel
