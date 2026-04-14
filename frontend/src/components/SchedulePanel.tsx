import React, { useState, useEffect, useCallback } from 'react'
import * as api from '../services/api'
import type { WsMessage } from '../hooks/useWebSocket'

interface Entry {
  id: string
  hour: number
  minute: number
  lat: number
  lng: number
  label: string
  enabled: boolean
  repeat_daily: boolean
}

interface Props {
  currentPosition?: { lat: number; lng: number } | null
  wsMessage: WsMessage | null
}

const pad2 = (n: number) => String(n).padStart(2, '0')

const SchedulePanel: React.FC<Props> = ({ currentPosition, wsMessage }) => {
  const [expanded, setExpanded]       = useState(false)
  const [entries, setEntries]         = useState<Entry[]>([])
  const [adding, setAdding]           = useState(false)
  const [newTime, setNewTime]         = useState('09:00')
  const [newLabel, setNewLabel]       = useState('')
  const [useCurrentPos, setUseCurrent] = useState(true)
  const [newLat, setNewLat]           = useState('')
  const [newLng, setNewLng]           = useState('')
  const [repeat, setRepeat]           = useState(true)
  const [saving, setSaving]           = useState(false)
  const [toast, setToast]             = useState<string | null>(null)

  const showToast = (msg: string, ms = 2500) => {
    setToast(msg)
    setTimeout(() => setToast(null), ms)
  }

  const load = useCallback(() => {
    api.getSchedule().then(r => setEntries(r.entries)).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  // WebSocket event: schedule triggered
  useEffect(() => {
    if (!wsMessage) return
    if (wsMessage.type === 'schedule_triggered') {
      const d = wsMessage.data as any
      showToast(`⏰ 排程跳點執行：${d?.label || ''}`, 4000)
      load() // Refresh to update last_run info
    }
  }, [wsMessage, load])

  const handleAdd = useCallback(async () => {
    const parts = newTime.split(':')
    const h = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10)
    if (isNaN(h) || isNaN(m)) { showToast('請輸入有效時間'); return }

    let lat: number, lng: number
    if (useCurrentPos) {
      if (!currentPosition) { showToast('請先取得當前位置'); return }
      lat = currentPosition.lat
      lng = currentPosition.lng
    } else {
      lat = parseFloat(newLat)
      lng = parseFloat(newLng)
      if (isNaN(lat) || isNaN(lng)) { showToast('請輸入有效座標'); return }
    }

    setSaving(true)
    try {
      await api.addSchedule({
        hour: h, minute: m, lat, lng,
        label: newLabel.trim() || `排程 ${pad2(h)}:${pad2(m)}`,
        repeat_daily: repeat,
      })
      load()
      setAdding(false)
      setNewLabel('')
      setNewLat('')
      setNewLng('')
      showToast('✓ 排程已新增')
    } catch (e: any) {
      showToast(e.message || '新增失敗')
    } finally {
      setSaving(false)
    }
  }, [newTime, newLabel, useCurrentPos, currentPosition, newLat, newLng, repeat, load])

  const handleToggle = async (id: string, enabled: boolean) => {
    await api.toggleSchedule(id, !enabled).catch(() => {})
    setEntries(es => es.map(e => e.id === id ? { ...e, enabled: !enabled } : e))
  }

  const handleDelete = async (id: string) => {
    await api.removeSchedule(id).catch(() => {})
    setEntries(es => es.filter(e => e.id !== id))
  }

  const activeCount = entries.filter(e => e.enabled).length

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => { setExpanded(e => !e); if (!expanded) load() }}
      >
        <span style={{ fontSize: 16 }}>📅</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>排程跳點</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>
          {activeCount}/{entries.length} {expanded ? '▲' : '▼'}
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {/* Entry list */}
          {entries.length === 0 ? (
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>尚無排程</div>
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 3,
              marginBottom: 8, maxHeight: 160, overflowY: 'auto',
            }}>
              {entries.map(e => (
                <div key={e.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: e.enabled ? 'rgba(108,140,255,0.08)' : 'rgba(255,255,255,0.03)',
                  borderRadius: 6, padding: '5px 8px',
                  border: `1px solid ${e.enabled ? 'rgba(108,140,255,0.2)' : 'rgba(255,255,255,0.06)'}`,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: e.enabled ? '#a5b4fc' : '#64748b' }}>
                      {pad2(e.hour)}:{pad2(e.minute)}
                      {e.label && <span style={{ fontWeight: 400, marginLeft: 6 }}>{e.label}</span>}
                      {e.repeat_daily && (
                        <span style={{
                          fontSize: 9, marginLeft: 5, color: '#60a5fa',
                          background: 'rgba(96,165,250,0.12)', padding: '1px 4px', borderRadius: 4,
                        }}>每日</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: '#475569' }}>
                      {e.lat.toFixed(5)}, {e.lng.toFixed(5)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleToggle(e.id, e.enabled)}
                    style={{
                      fontSize: 9, padding: '2px 6px', borderRadius: 8, cursor: 'pointer',
                      background: e.enabled ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.06)',
                      border: `1px solid ${e.enabled ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.1)'}`,
                      color: e.enabled ? '#86efac' : '#64748b',
                    }}
                  >{e.enabled ? 'ON' : 'OFF'}</button>
                  <button
                    onClick={() => handleDelete(e.id)}
                    style={{
                      fontSize: 10, padding: '2px 5px', borderRadius: 4, cursor: 'pointer',
                      background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)',
                      color: '#f87171',
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Add form */}
          {adding ? (
            <div style={{
              background: 'rgba(255,255,255,0.04)', borderRadius: 8,
              padding: 10, marginBottom: 6, border: '1px solid rgba(255,255,255,0.08)',
            }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input
                  type="time"
                  value={newTime}
                  onChange={e => setNewTime(e.target.value)}
                  style={{
                    flex: 1, fontSize: 12, padding: '4px 6px',
                    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 5, color: '#e2e8f0',
                  }}
                />
                <input
                  type="text"
                  placeholder="標籤（選填）"
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  style={{
                    flex: 1, fontSize: 12, padding: '4px 6px',
                    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 5, color: '#e2e8f0',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
                <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="checkbox" checked={useCurrentPos}
                    onChange={e => setUseCurrent(e.target.checked)}
                  />
                  使用當前位置
                </label>
                <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="checkbox" checked={repeat}
                    onChange={e => setRepeat(e.target.checked)}
                  />
                  每日重複
                </label>
              </div>

              {!useCurrentPos && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                  <input
                    type="number" step="any" placeholder="緯度" value={newLat}
                    onChange={e => setNewLat(e.target.value)}
                    style={{
                      flex: 1, fontSize: 11, padding: '3px 5px',
                      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: 5, color: '#e2e8f0',
                    }}
                  />
                  <input
                    type="number" step="any" placeholder="經度" value={newLng}
                    onChange={e => setNewLng(e.target.value)}
                    style={{
                      flex: 1, fontSize: 11, padding: '3px 5px',
                      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: 5, color: '#e2e8f0',
                    }}
                  />
                </div>
              )}

              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={handleAdd}
                  disabled={saving}
                  style={{
                    flex: 1, fontSize: 11, padding: '4px 0', borderRadius: 5, cursor: 'pointer',
                    background: 'rgba(108,140,255,0.2)', border: '1px solid rgba(108,140,255,0.4)',
                    color: '#a5b4fc', opacity: saving ? 0.6 : 1,
                  }}
                >
                  {saving ? '新增中…' : '確認新增'}
                </button>
                <button
                  onClick={() => setAdding(false)}
                  style={{
                    fontSize: 11, padding: '4px 12px', borderRadius: 5, cursor: 'pointer',
                    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                    color: '#94a3b8',
                  }}
                >取消</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              style={{
                width: '100%', fontSize: 12, padding: '5px 0', borderRadius: 6, cursor: 'pointer',
                background: 'rgba(255,255,255,0.05)', border: '1px dashed rgba(255,255,255,0.2)',
                color: '#94a3b8',
              }}
            >
              + 新增排程
            </button>
          )}

          {toast && (
            <div style={{
              marginTop: 6, fontSize: 12, padding: '4px 8px', borderRadius: 4,
              color: toast.startsWith('⏰') || toast.startsWith('✓') ? '#86efac' : '#f87171',
              background: toast.startsWith('⏰') || toast.startsWith('✓')
                ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
            }}>
              {toast}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default SchedulePanel
