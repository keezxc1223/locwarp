import React, { useState, useEffect, useCallback } from 'react'
import * as api from '../services/api'

interface AdbDevice {
  serial: string
  name: string
  type: 'emulator' | 'device'
}

interface Props {
  onConnected?: (serial: string, name: string) => void
  onDisconnected?: () => void
}

const BlueStacksPanel: React.FC<Props> = ({ onConnected, onDisconnected }) => {
  const [devices, setDevices] = useState<AdbDevice[]>([])
  const [connectedSerial, setConnectedSerial] = useState<string | null>(null)
  const [connectedName, setConnectedName] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.getAdbStatus()
      if (res.connected) {
        setConnectedSerial(res.serial)
      } else {
        setConnectedSerial(null)
      }
    } catch {
      setConnectedSerial(null)
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  const handleScan = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.listAdbDevices()
      setDevices(res.devices)
      setExpanded(true)
      if (res.devices.length === 0) {
        setError('找不到裝置，請確認 BlueStacks ADB 已開啟')
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleConnect = async (dev: AdbDevice) => {
    setConnecting(dev.serial)
    setError(null)
    try {
      await api.connectAdb(dev.serial)
      setConnectedSerial(dev.serial)
      setConnectedName(dev.name)
      onConnected?.(dev.serial, dev.name)
      setExpanded(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setConnecting(null)
    }
  }

  const handleDisconnect = async () => {
    setError(null)
    try {
      await api.disconnectAdb()
      setConnectedSerial(null)
      setConnectedName(null)
      onDisconnected?.()
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16 }}>🤖</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>BlueStacks / Android</span>
        {connectedSerial ? (
          <span style={{ fontSize: 11, color: '#4ade80' }}>● 已連線</span>
        ) : (
          <span style={{ fontSize: 11, color: '#6b7280' }}>○ 未連線</span>
        )}
      </div>

      {/* Connected info */}
      {connectedSerial && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span style={{ fontSize: 12, color: '#e2e8f0', flex: 1 }}>
            {connectedName ?? connectedSerial}
            <span style={{ color: '#94a3b8', marginLeft: 4 }}>{connectedSerial}</span>
          </span>
          <button
            className="btn btn-sm btn-danger"
            onClick={handleDisconnect}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            斷線
          </button>
        </div>
      )}

      {/* Scan button */}
      {!connectedSerial && (
        <div style={{ marginTop: 6 }}>
          <button
            className="btn btn-sm btn-primary"
            onClick={handleScan}
            disabled={loading}
            style={{ fontSize: 12, width: '100%' }}
          >
            {loading ? '掃描中…' : '掃描 Android 裝置'}
          </button>
        </div>
      )}

      {/* Device list */}
      {expanded && devices.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {devices.map(dev => (
            <div key={dev.serial} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(255,255,255,0.05)', borderRadius: 6,
              padding: '6px 10px',
            }}>
              <span style={{ flex: 1, fontSize: 12 }}>
                <span style={{ marginRight: 4 }}>
                  {dev.type === 'emulator' ? '🖥️' : '📱'}
                </span>
                {dev.name}
                <span style={{ color: '#64748b', marginLeft: 4, fontSize: 11 }}>
                  {dev.serial}
                </span>
              </span>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => handleConnect(dev)}
                disabled={connecting === dev.serial}
                style={{ fontSize: 11, padding: '2px 8px' }}
              >
                {connecting === dev.serial ? '連線中…' : '連線'}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>{error}</div>
      )}
    </div>
  )
}

export default BlueStacksPanel
