import React, { useState, useEffect } from 'react'
import * as api from '../services/api'
import { useI18n } from '../i18n'

interface Entry { lat: number; lng: number; ts: number; name: string }
interface Props {
  onJump?: (lat: number, lng: number) => void
  /** Bump this counter from the parent after a teleport completes so the
   *  history list refreshes automatically instead of showing stale entries
   *  until the user manually collapses/expands the panel. */
  refreshKey?: number
}

// Locale picked from the active i18n language so timestamps are formatted
// consistently with the rest of the UI (zh-TW vs en-US).
function fmtTime(ts: number, lang: 'zh' | 'en') {
  const locale = lang === 'zh' ? 'zh-TW' : 'en-US'
  return new Date(ts * 1000).toLocaleString(locale, { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })
}

const HistoryPanel: React.FC<Props> = ({ onJump, refreshKey = 0 }) => {
  const { t, lang } = useI18n()
  const [entries, setEntries] = useState<Entry[]>([])
  const [expanded, setExpanded] = useState(false)

  const load = () => api.getHistory().then(r => setEntries(r.entries)).catch(() => {})

  useEffect(() => { load() }, [])

  // Auto-reload when parent signals a new teleport. Skip when collapsed
  // (the list isn't visible anyway and we'd just waste an API call).
  useEffect(() => {
    if (refreshKey > 0 && expanded) load()
  }, [refreshKey, expanded])

  const handleClear = async () => {
    await api.clearHistory()
    setEntries([])
  }

  const countUnit = t('history.count_unit')

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
           onClick={() => { setExpanded(e => !e); if (!expanded) load() }}>
        <span style={{ fontSize: 16 }}>📍</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{t('history.title')}</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>
          {entries.length}{countUnit ? ` ${countUnit}` : ''} {expanded ? '▲' : '▼'}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 6 }}>
          {entries.length === 0
            ? <div style={{ fontSize: 12, color: '#64748b' }}>{t('history.empty')}</div>
            : <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {entries.map((e, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6,
                    background: 'rgba(255,255,255,0.04)', borderRadius: 5, padding: '4px 8px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{fmtTime(e.ts, lang)}</div>
                      <div style={{ fontSize: 12, color: '#e2e8f0' }}>
                        {e.lat.toFixed(5)}, {e.lng.toFixed(5)}
                      </div>
                    </div>
                    <button className="btn btn-sm" onClick={() => onJump?.(e.lat, e.lng)}
                      title={t('history.jump_tooltip')}
                      style={{ fontSize: 10, padding: '2px 6px', background: 'rgba(99,102,241,0.2)',
                        border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc', borderRadius: 4 }}>
                      {t('history.jump')}
                    </button>
                  </div>
                ))}
              </div>
          }
          {entries.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                className="btn btn-sm"
                onClick={() => window.open(api.exportHistoryGpxUrl(), '_blank')}
                style={{
                  flex: 1, fontSize: 11,
                  background: 'rgba(34,197,94,0.12)',
                  border: '1px solid rgba(34,197,94,0.35)',
                  color: '#86efac', borderRadius: 4, cursor: 'pointer',
                }}
              >{t('history.export_gpx')}</button>
              <button className="btn btn-sm btn-danger" onClick={handleClear}
                style={{ flex: 1, fontSize: 11 }}>{t('history.clear')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
export default HistoryPanel
