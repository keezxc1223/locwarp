/**
 * TopBar — 36px persistent app header
 *
 * Shows only the app brand and the currently connected device.
 * All real-time operational data (coords, speed, cooldown, mode)
 * lives in the StatusBar below the map — not here.
 */
import React from 'react'

interface TopBarProps {
  isConnected: boolean
  deviceName: string
  iosVersion: string
  connectionType?: string
}

const TopBar: React.FC<TopBarProps> = ({
  isConnected,
  deviceName,
  iosVersion,
  connectionType,
}) => {
  return (
    <div className="top-bar">
      {/* Brand */}
      <div className="top-bar-brand">
        <span className="top-bar-logo">📍</span>
        <span className="top-bar-title">LocWarp</span>
      </div>

      <div className="top-bar-sep" />

      {/* Device */}
      <div className="top-bar-device">
        <span className={`top-bar-dot ${isConnected ? 'connected' : 'disconnected'}`} />
        {isConnected ? (
          <>
            <span className="top-bar-device-name">{deviceName}</span>
            {iosVersion && (
              <span className="top-bar-device-ver">iOS {iosVersion}</span>
            )}
            {connectionType && (
              <span
                className="top-bar-conn-type"
                title={connectionType}
              >
                {connectionType === 'Network' ? '📶' : '🔌'}
              </span>
            )}
          </>
        ) : (
          <span className="top-bar-device-name top-bar-no-device">
            未連線 — 請透過 USB 連接 iPhone
          </span>
        )}
      </div>

      {/* Right spacer */}
      <div className="top-bar-spacer" />
    </div>
  )
}

export default TopBar
