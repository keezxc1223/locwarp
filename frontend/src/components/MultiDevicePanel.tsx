/**
 * MultiDevicePanel — GPS 多裝置同步
 *
 * Shows all discoverable iOS devices. The primary (currently driving
 * navigation) is marked. Any secondary USB-connected device can be added to
 * the sync group so it receives the exact same GPS coordinates in real-time.
 */
import React, { useState, useEffect, useCallback } from 'react'
import * as api from '../services/api'
import type { WsMessage } from '../hooks/useWebSocket'

interface SyncDevice {
  udid: string
  name: string
  is_primary: boolean
}

interface DiscoveredDevice {
  udid: string
  name: string
  ios_version: string
  connection_type: string
}

interface Props {
  wsMessage: WsMessage | null
}

const MultiDevicePanel: React.FC<Props> = ({ wsMessage }) => {
  const [expanded, setExpanded]     = useState(false)
  const [syncDevices, setSyncDevices]   = useState<SyncDevice[]>([])
  const [allDevices, setAllDevices]     = useState<DiscoveredDevice[]>([])
  const [scanning, setScanning]         = useState(false)
  const [loadingUdid, setLoadingUdid]   = useState<string | null>(null)
  const [toast, setToast]               = useState<string | null>(null)

  const showToast = (msg: string, ms = 2500) => {
    setToast(msg)
    setTimeout(() => setToast(null), ms)
  }

  const loadSync = useCallback(() => {
    api.getSyncDevices().then(r => setSyncDevices(r.devices)).catch(() => {})
  }, [])

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const devs = await api.listDevices()
      setAllDevices(devs)
      loadSync()
    } catch {
      showToast('掃描失敗')
    } finally {
      setScanning(false)
    }
  }, [loadSync])

  // Load on expand
  useEffect(() => {
    if (expanded) scan()
  }, [expanded]) // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket events
  useEffect(() => {
    if (!wsMessage) return
    if (wsMessage.type === 'sync_device_added') {
      const d = wsMessage.data as any
      showToast(`✓ ${d?.name || d?.udid} 已加入同步`)
      loadSync()
    } else if (wsMessage.type === 'sync_device_removed') {
      const d = wsMessage.data as any
      showToast(`${d?.name || d?.udid} 已移出同步`)
      loadSync()
    } else if (wsMessage.type === 'device_connected') {
      if (expanded) scan()
    }
  }, [wsMessage, loadSync, expanded, scan])

  const syncUdids = new Set(syncDevices.map(d => d.udid))
  const primaryUdid = syncDevices.find(d => d.is_primary)?.udid
  const syncCount = syncDevices.filter(d => !d.is_primary).length

  const handleAdd = useCallback(async (udid: string) => {
    setLoadingUdid(udid)
    try {
      await api.addSyncDevice(udid)
      await loadSync()
    } catch (e: any) {
      showToast(e.message || '加入失敗')
    } finally {
      setLoadingUdid(null)
    }
  }, [loadSync])

  const handleRemove = useCallback(async (udid: string) => {
    setLoadingUdid(udid)
    try {
      await api.removeSyncDevice(udid)
      setSyncDevices(d => d.filter(s => s.udid !== udid))
    } catch (e: any) {
      showToast(e.message || '移除失敗')
    } finally {
      setLoadingUdid(null)
    }
  }, [])

  // Merge all known devices (sync list + discovered)
  const knownUdids = new Set([
    ...syncDevices.map(d => d.udid),
    ...allDevices.map(d => d.udid),
  ])
  const mergedDevices = [...knownUdids].map(udid => {
    const disc  = allDevices.find(d => d.udid === udid)
    const syncd = syncDevices.find(d => d.udid === udid)
    return {
      udid,
      name: disc?.name || syncd?.name || udid,
      ios_version: disc?.ios_version || '',
      connection_type: disc?.connection_type || 'USB',
      is_primary: udid === primaryUdid,
      is_synced: syncUdids.has(udid),
    }
  })

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        <span style={{ fontSize: 16 }}>📱</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>多裝置同步</span>
        {syncCount > 0 && (
          <span style={{
            fontSize: 10, color: '#86efac',
            background: 'rgba(34,197,94,0.15)', padding: '1px 6px', borderRadius: 8,
          }}>
            +{syncCount} 同步中
          </span>
        )}
        <span style={{ fontSize: 11, color: '#64748b' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {/* Explanation */}
          <div style={{
            fontSize: 11, color: '#64748b', marginBottom: 10, lineHeight: 1.5,
            background: 'rgba(255,255,255,0.03)', borderRadius: 6, padding: '6px 8px',
          }}>
            將多支 iPhone 加入同步後，所有跳點 / 導航指令會<b style={{ color: '#a5b4fc' }}>同時發送</b>到每支手機
          </div>

          {/* Device list */}
          {mergedDevices.length === 0 ? (
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
              {scanning ? '掃描中…' : '未偵測到裝置，請透過 USB 連接 iPhone'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              {mergedDevices.map(dev => (
                <div key={dev.udid} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: dev.is_primary
                    ? 'rgba(108,140,255,0.1)'
                    : dev.is_synced
                      ? 'rgba(34,197,94,0.08)'
                      : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${
                    dev.is_primary ? 'rgba(108,140,255,0.25)'
                    : dev.is_synced ? 'rgba(34,197,94,0.2)'
                    : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 7, padding: '6px 10px',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13 }}>
                        {dev.connection_type === 'Network' ? '📶' : '🔌'}
                      </span>
                      <span style={{
                        fontSize: 12, fontWeight: 600,
                        color: dev.is_primary ? '#a5b4fc' : dev.is_synced ? '#86efac' : '#cbd5e1',
                      }}>
                        {dev.name}
                      </span>
                      {dev.is_primary && (
                        <span style={{
                          fontSize: 9, color: '#a5b4fc',
                          background: 'rgba(108,140,255,0.2)', padding: '1px 5px', borderRadius: 6,
                        }}>主要</span>
                      )}
                      {dev.is_synced && !dev.is_primary && (
                        <span style={{
                          fontSize: 9, color: '#86efac',
                          background: 'rgba(34,197,94,0.15)', padding: '1px 5px', borderRadius: 6,
                        }}>同步中</span>
                      )}
                    </div>
                    {dev.ios_version && (
                      <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>
                        iOS {dev.ios_version} · {dev.udid.slice(0, 8)}…
                      </div>
                    )}
                  </div>

                  {/* Action button */}
                  {dev.is_primary ? (
                    <span style={{ fontSize: 10, color: '#64748b' }}>控制端</span>
                  ) : dev.is_synced ? (
                    <button
                      onClick={() => handleRemove(dev.udid)}
                      disabled={loadingUdid === dev.udid}
                      style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
                        background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)',
                        color: '#f87171', opacity: loadingUdid === dev.udid ? 0.5 : 1,
                      }}
                    >
                      {loadingUdid === dev.udid ? '…' : '移除'}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleAdd(dev.udid)}
                      disabled={loadingUdid === dev.udid}
                      style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
                        background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
                        color: '#86efac', opacity: loadingUdid === dev.udid ? 0.5 : 1,
                      }}
                    >
                      {loadingUdid === dev.udid ? '加入中…' : '加入同步'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Scan button */}
          <button
            onClick={scan}
            disabled={scanning}
            style={{
              width: '100%', fontSize: 12, padding: '5px 0', borderRadius: 6, cursor: 'pointer',
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
              color: '#94a3b8', opacity: scanning ? 0.5 : 1,
            }}
          >
            {scanning ? '掃描中…' : '🔍 重新掃描裝置'}
          </button>

          {toast && (
            <div style={{
              marginTop: 6, fontSize: 12, padding: '5px 8px', borderRadius: 5,
              color: toast.startsWith('✓') ? '#86efac' : '#f87171',
              background: toast.startsWith('✓') ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
            }}>
              {toast}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default MultiDevicePanel
