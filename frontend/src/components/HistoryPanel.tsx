import React, { useState, useEffect } from 'react'
import * as api from '../services/api'

interface Entry { lat: number; lng: number; ts: number; name: string }
interface Props { onJump?: (lat: number, lng: number) => void }

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleString('zh-TW', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })
}

const HistoryPanel: React.FC<Props> = ({ onJump }) => {
  const [entries, setEntries] = useState<Entry[]>([])
  const [expanded, setExpanded] = useState(false)

  const load = () => api.getHistory().then(r => setEntries(r.entries)).catch(() => {})

  useEffect(() => { load() }, [])

  const handleClear = async () => {
    await api.clearHistory()
    setEntries([])
  }

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
           onClick={() => { setExpanded(e => !e); if (!expanded) load() }}>
        <span style={{ fontSize: 16 }}>📍</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>地點歷史</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{entries.length} 筆 {expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 6 }}>
          {entries.length === 0
            ? <div style={{ fontSize: 12, color: '#64748b' }}>尚無記錄</div>
            : <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {entries.map((e, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6,
                    background: 'rgba(255,255,255,0.04)', borderRadius: 5, padding: '4px 8px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{fmtTime(e.ts)}</div>
                      <div style={{ fontSize: 12, color: '#e2e8f0' }}>
                        {e.lat.toFixed(5)}, {e.lng.toFixed(5)}
                      </div>
                    </div>
                    <button className="btn btn-sm" onClick={() => onJump?.(e.lat, e.lng)}
                      style={{ fontSize: 10, padding: '2px 6px', background: 'rgba(99,102,241,0.2)',
                        border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc', borderRadius: 4 }}>
                      跳
                    </button>
                  </div>
                ))}
              </div>
          }
          {entries.length > 0 && (
            <button className="btn btn-sm btn-danger" onClick={handleClear}
              style={{ fontSize: 11, marginTop: 6, width: '100%' }}>清除歷史</button>
          )}
        </div>
      )}
    </div>
  )
}
export default HistoryPanel
