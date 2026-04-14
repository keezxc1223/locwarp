import { useState, useEffect, useRef, useCallback } from 'react'

export interface WsMessage {
  type: string
  data: any
}

// Mirror the host from window.location so WebSocket works from any network address
const WS_HOST = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1'
const WS_URL = `ws://${WS_HOST}:8777/ws/status`
const RECONNECT_INTERVAL = 3000
const MAX_RECONNECT_INTERVAL = 30000

export function useWebSocket() {
  const [connected, setConnected] = useState(false)
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelay = useRef(RECONNECT_INTERVAL)
  const mountedRef = useRef(true)

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
  }, [])

  const connect = useCallback(() => {
    if (!mountedRef.current) return
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close()
          return
        }
        setConnected(true)
        reconnectDelay.current = RECONNECT_INTERVAL
      }

      ws.onmessage = (event) => {
        if (!mountedRef.current) return
        try {
          const msg: WsMessage = JSON.parse(event.data)
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }))
            return
          }
          setLastMessage(msg)
        } catch {
          // ignore malformed messages
        }
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        setConnected(false)
        wsRef.current = null
        scheduleReconnect()
      }

      ws.onerror = () => {
        // onclose will fire after onerror, triggering reconnect
        ws.close()
      }
    } catch {
      scheduleReconnect()
    }
  }, [])

  const scheduleReconnect = useCallback(() => {
    cleanup()
    if (!mountedRef.current) return
    reconnectTimer.current = setTimeout(() => {
      reconnectDelay.current = Math.min(
        reconnectDelay.current * 1.5,
        MAX_RECONNECT_INTERVAL,
      )
      connect()
    }, reconnectDelay.current)
  }, [connect, cleanup])

  const sendMessage = useCallback((type: string, data: any = {}) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, data }))
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    connect()

    return () => {
      mountedRef.current = false
      cleanup()
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
      setConnected(false)
    }
  }, [connect, cleanup])

  return { connected, lastMessage, sendMessage }
}
