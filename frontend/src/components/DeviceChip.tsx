import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import type { DeviceInfo } from '../hooks/useDevice'
import type { DeviceRuntime } from '../hooks/useSimulation'

import { DEVICE_COLORS, type DeviceLetter } from '../deviceSlots'

export { DEVICE_COLORS, type DeviceLetter }

interface Props {
  letter: DeviceLetter
  device: DeviceInfo
  runtime?: DeviceRuntime
  onDisconnect: () => void
  onRestoreOne: () => void
  onEnableDev?: () => void
}

function stateKind(state?: string): 'idle' | 'running' | 'paused' | 'error' | 'disconnected' {
  if (!state) return 'idle'
  if (state === 'paused') return 'paused'
  if (state === 'disconnected') return 'disconnected'
  if (state === 'idle') return 'idle'
  return 'running'
}

export function DeviceChip({ letter, device, runtime, onDisconnect, onRestoreOne, onEnableDev }: Props) {
  const t = useT()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  const kind = stateKind(runtime?.state)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const dotColor = {
    idle: '#4ecdc4',
    running: '#6c8cff',
    paused: '#ffb627',
    error: '#ff6b6b',
    disconnected: '#ff6b6b',
  }[kind]

  const label = {
    idle: t('device.chip_state_idle'),
    running: t('device.chip_state_running'),
    paused: t('device.chip_state_paused'),
    error: t('device.chip_state_error'),
    disconnected: t('device.chip_state_disconnected'),
  }[kind]

  const accent = DEVICE_COLORS[letter]
  const fullName = device.name || 'iPhone'

  return (
    <>
      <div
        ref={ref}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        style={{
          // The full device name always shows: it wraps onto a second line
          // instead of being cut off, so the chip grows rather than hides.
          display: 'inline-flex', alignItems: 'center', gap: 6,
          minHeight: 24, padding: '4px 9px',
          borderRadius: 12,
          background: 'rgba(255,255,255,0.06)',
          backdropFilter: 'var(--glass-blur)',
          WebkitBackdropFilter: 'var(--glass-blur)',
          border: '1px solid rgba(var(--accent-rgb), 0.18)',
          fontSize: 11,
          color: 'rgba(255,255,255,0.9)',
          cursor: 'context-menu',
          maxWidth: '100%',
          lineHeight: 1.3,
        }}
        title={`${letter} · ${device.name}`}
      >
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: dotColor,
            boxShadow: kind === 'running' ? `0 0 6px ${dotColor}` : 'none',
            animation: kind === 'running' ? 'chip-pulse 1.6s ease-in-out infinite' : undefined,
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600, color: accent, flexShrink: 0 }}>{letter}</span>
        <span style={{ opacity: 0.9, minWidth: 0, overflowWrap: 'anywhere' }}>{fullName}</span>
        <span style={{ opacity: 0.6, marginLeft: 2, flexShrink: 0, whiteSpace: 'nowrap' }}>· {label}</span>
      </div>
      {menu && createPortal(
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: menu.x, top: menu.y,
            background: 'var(--glass-pop)',
            backdropFilter: 'var(--glass-blur)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8, padding: 4, minWidth: 160,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            zIndex: 9999, fontSize: 12, color: '#eaeaea',
          }}
        >
          <MenuItem onClick={() => { setMenu(null); onRestoreOne() }}>{t('device.chip_restore')}</MenuItem>
          {onEnableDev && <MenuItem onClick={() => { setMenu(null); onEnableDev() }}>{t('device.chip_enable_dev')}</MenuItem>}
          <MenuItem onClick={() => { setMenu(null); onDisconnect() }}>{t('device.chip_disconnect')}</MenuItem>
        </div>,
        document.body,
      )}
    </>
  )
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '6px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        background: hover ? 'rgba(var(--accent-rgb),0.18)' : 'transparent',
      }}
    >
      {children}
    </div>
  )
}
