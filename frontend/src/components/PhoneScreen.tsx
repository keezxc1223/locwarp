import React, { useState, useEffect, useRef } from 'react'

interface PhoneScreenProps {
  udid: string
  onClose: () => void
}

export default function PhoneScreen({ udid, onClose }: PhoneScreenProps) {
  const [active, setActive] = useState(false)
  const [fps, setFps] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fpsCountRef = useRef(0)
  const fpsTimerRef = useRef<ReturnType<typeof setInterval>>()

  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 })
  const [pos, setPos] = useState({ x: window.innerWidth - 300, y: 60 })

  useEffect(() => {
    if (!active) {
      wsRef.current?.close()
      wsRef.current = null
      clearInterval(fpsTimerRef.current)
      setFps(0)
      return
    }

    setError(null)
    const wsUrl = `ws://localhost:8777/ws/device/${encodeURIComponent(udid)}/mirror`
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'blob'
    wsRef.current = ws

    fpsTimerRef.current = setInterval(() => {
      setFps(fpsCountRef.current)
      fpsCountRef.current = 0
    }, 1000)

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          if (msg.error) setError(msg.error)
        } catch {}
        return
      }
      // Binary frame — update image
      const url = URL.createObjectURL(e.data)
      if (imgRef.current) {
        const old = imgRef.current.src
        imgRef.current.src = url
        if (old.startsWith('blob:')) URL.revokeObjectURL(old)
      }
      fpsCountRef.current++
      setError(null)
    }

    ws.onerror = () => setError('WebSocket 連線失敗')
    ws.onclose = () => { if (active) setError('連線中斷') }

    return () => {
      ws.close()
      clearInterval(fpsTimerRef.current)
    }
  }, [active, udid])

  useEffect(() => {
    return () => wsRef.current?.close()
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging) return
      setPos({
        x: Math.max(0, dragRef.current.origX + e.clientX - dragRef.current.startX),
        y: Math.max(0, dragRef.current.origY + e.clientY - dragRef.current.startY),
      })
    }
    const onUp = () => { dragRef.current.dragging = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y, width: 260,
      background: 'linear-gradient(135deg, rgba(15,17,25,0.97), rgba(20,22,35,0.97))',
      border: '1px solid rgba(108,140,255,0.3)',
      borderRadius: 16,
      boxShadow: '0 12px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)',
      zIndex: 900, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      backdropFilter: 'blur(20px)',
    }}>
      {/* Header / drag handle */}
      <div
        onMouseDown={onMouseDown}
        style={{
          padding: '8px 10px', cursor: 'grab',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(108,140,255,0.1)',
          borderBottom: '1px solid rgba(108,140,255,0.15)',
          userSelect: 'none', gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13 }}>📱</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#9ac0ff' }}>手機畫面鏡像</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {active && <span style={{ fontSize: 10, color: '#4ade80', minWidth: 36 }}>{fps} fps</span>}
          <button
            onClick={() => { setError(null); setActive(v => !v) }}
            style={{
              padding: '2px 8px', fontSize: 10, borderRadius: 6, border: 'none',
              background: active ? 'rgba(239,68,68,0.8)' : 'rgba(34,197,94,0.8)',
              color: '#fff', cursor: 'pointer', fontWeight: 600,
            }}
          >{active ? '停止' : '開始'}</button>
          <button
            onClick={onClose}
            style={{
              width: 18, height: 18, borderRadius: '50%', border: 'none',
              background: 'rgba(255,255,255,0.08)', color: '#888',
              cursor: 'pointer', fontSize: 11,
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}
          >✕</button>
        </div>
      </div>

      {/* Screen area */}
      <div style={{ background: '#000', position: 'relative', aspectRatio: '9/19.5', minHeight: 200 }}>
        <img
          ref={imgRef}
          alt="iPhone Mirror"
          style={{
            width: '100%', height: '100%', objectFit: 'contain', display: 'block',
            opacity: active && !error ? 1 : 0,
          }}
        />
        {!active && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            color: '#555', fontSize: 12, gap: 8, padding: 16, textAlign: 'center',
          }}>
            <span style={{ fontSize: 28 }}>📵</span>
            <span>點「開始」啟動鏡像</span>
          </div>
        )}
        {error && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 14, textAlign: 'center',
          }}>
            <span style={{ fontSize: 10, color: '#ef4444', lineHeight: 1.7 }}>{error}</span>
          </div>
        )}
      </div>
    </div>
  )
}
