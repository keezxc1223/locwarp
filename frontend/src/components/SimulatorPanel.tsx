import React, { useState, useEffect, useCallback } from 'react'
import * as api from '../services/api'
import { useT } from '../i18n'

interface Simulator {
  udid: string
  name: string
  state: string
  ios_version: string
}

interface Props {
  onConnected?: (udid: string, name: string) => void
  onDisconnected?: () => void
}

const SimulatorPanel: React.FC<Props> = ({ onConnected, onDisconnected }) => {
  const t = useT()
  const [simulators, setSimulators] = useState<Simulator[]>([])
  const [connectedUdid, setConnectedUdid] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.getSimulatorStatus()
      if (res.connected) {
        setConnectedUdid(res.udid)
      } else {
        setConnectedUdid(null)
      }
    } catch {
      setConnectedUdid(null)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleScan = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.listSimulators()
      setSimulators(res.simulators)
      setExpanded(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleConnect = async (sim: Simulator) => {
    setConnecting(sim.udid)
    setError(null)
    try {
      await api.connectSimulator(sim.udid)
      setConnectedUdid(sim.udid)
      onConnected?.(sim.udid, sim.name)
      setExpanded(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setConnecting(null)
    }
  }

  const handleDisconnect = async () => {
    if (!connectedUdid) return
    setError(null)
    try {
      await api.disconnectSimulator(connectedUdid)
      setConnectedUdid(null)
      onDisconnected?.()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const connectedSim = simulators.find(s => s.udid === connectedUdid)
  const isConnected = !!connectedUdid

  return (
    <div className="device-status" style={{ marginTop: 8 }}>
      {/* Header */}
      <div className="device-status-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16 }}>🖥️</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>iOS 模擬器</span>
        {isConnected ? (
          <span style={{ fontSize: 11, color: '#4ade80' }}>● 已連線</span>
        ) : (
          <span style={{ fontSize: 11, color: '#6b7280' }}>○ 未連線</span>
        )}
      </div>

      {/* Connected device info */}
      {isConnected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span style={{ fontSize: 12, color: '#e2e8f0', flex: 1 }}>
            {connectedSim?.name ?? connectedUdid?.slice(0, 8) + '…'}
            {connectedSim && (
              <span style={{ color: '#94a3b8', marginLeft: 4 }}>
                iOS {connectedSim.ios_version}
              </span>
            )}
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

      {/* Scan / List */}
      {!isConnected && (
        <div style={{ marginTop: 6 }}>
          <button
            className="btn btn-sm btn-primary"
            onClick={handleScan}
            disabled={loading}
            style={{ fontSize: 12, width: '100%' }}
          >
            {loading ? '掃描中…' : '掃描模擬器'}
          </button>
        </div>
      )}

      {/* Simulator list */}
      {expanded && simulators.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {simulators.map(sim => (
            <div
              key={sim.udid}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'rgba(255,255,255,0.05)', borderRadius: 6,
                padding: '6px 10px',
              }}
            >
              <span style={{ flex: 1, fontSize: 12 }}>
                <span style={{
                  color: sim.state === 'Booted' ? '#4ade80' : '#94a3b8',
                  marginRight: 4,
                }}>
                  {sim.state === 'Booted' ? '●' : '○'}
                </span>
                {sim.name}
                <span style={{ color: '#64748b', marginLeft: 4, fontSize: 11 }}>
                  iOS {sim.ios_version}
                </span>
              </span>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => handleConnect(sim)}
                disabled={connecting === sim.udid}
                style={{ fontSize: 11, padding: '2px 8px' }}
              >
                {connecting === sim.udid
                  ? (sim.state === 'Booted' ? '連線中…' : '開機中…')
                  : '連線'}
              </button>
            </div>
          ))}
        </div>
      )}

      {expanded && simulators.length === 0 && !loading && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
          找不到可用的 iOS 模擬器
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  )
}

export default SimulatorPanel
