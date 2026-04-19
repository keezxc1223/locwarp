/**
 * useJoystick — manages joystick direction/intensity state and WS dispatch.
 *
 * Keyboard handling is intentionally delegated entirely to JoystickPad.tsx
 * (which also drives the visual handle).  This hook only owns:
 *   • direction/intensity React state (for display)
 *   • updateFromPad — called by JoystickPad on pointer AND keyboard events
 */
import { useState, useEffect, useCallback, useRef } from 'react'

// 搖桿輸入節流：限制 WS 訊息發送頻率，避免 pointermove 每秒數十次的過度廣播。
// 80ms ≈ 12.5 fps，足夠讓移動流暢，同時大幅降低後端處理壓力。
const JOYSTICK_THROTTLE_MS = 80

export function useJoystick(
  sendWsMessage: (type: string, data: any) => void,
  active: boolean,
) {
  const [direction, setDirection] = useState(0)
  const [intensity, setIntensity] = useState(0)
  const activeRef   = useRef(active)
  const sendRef     = useRef(sendWsMessage)
  const lastEmitRef = useRef(0)

  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => { sendRef.current  = sendWsMessage }, [sendWsMessage])

  const emitState = useCallback((dir: number, int: number) => {
    setDirection(dir)
    setIntensity(int)
    sendRef.current('joystick_input', { direction: dir, intensity: int })
  }, [])

  // Zero-out state when joystick deactivates
  useEffect(() => {
    if (!active) {
      setDirection(0)
      setIntensity(0)
    }
  }, [active])

  /**
   * Called by JoystickPad on every pointer-move or key change.
   * Guards against sending when the session hasn't started yet.
   * Throttled to JOYSTICK_THROTTLE_MS to avoid flooding the WebSocket.
   *
   * Stop signal (int=0) 永遠繞過節流：若在最後一次移動訊息的 80ms 內放開
   * 搖桿，stop 訊號原本會被丟棄，造成角色繼續移動直到下一次訊息才停下。
   */
  const updateFromPad = useCallback(
    (dir: number, int: number) => {
      if (!activeRef.current) return
      // Stop signal must always be delivered — bypass throttle and reset the
      // window so the next directional input fires without extra delay.
      if (int === 0) {
        lastEmitRef.current = 0
        emitState(0, 0)
        return
      }
      const now = Date.now()
      if (now - lastEmitRef.current < JOYSTICK_THROTTLE_MS) return
      lastEmitRef.current = now
      emitState(dir, Math.min(1, Math.max(0, int)))
    },
    [emitState],
  )

  return { direction, intensity, updateFromPad }
}
