/**
 * useCooldown — polls cooldown state from the backend every 2 s while the
 * WebSocket is connected, and exposes an enable/disable toggle.
 *
 * The backend owns cooldown truth (counts down across teleports, survives
 * across frontend restarts), so this hook is a pure read-mostly cache plus
 * an optimistic toggle that rolls back on API failure.
 *
 * `wsConnected` is the gate — when false we pause polling (no point asking
 * the server we can't reach). When the socket comes back, `useEffect`
 * re-fires and the interval resumes.
 *
 * Extracted from App.tsx where 3 state vars, 1 polling effect, and 1 toggle
 * handler were interleaved with unrelated UI concerns.
 */
import { useCallback, useEffect, useState } from 'react'
import * as api from '../services/api'

const POLL_INTERVAL_MS = 2000

interface UseCooldownReturn {
  remainingSeconds: number
  enabled: boolean
  distanceKm: number
  toggleEnabled: (next: boolean) => void
}

export function useCooldown(wsConnected: boolean): UseCooldownReturn {
  const [remainingSeconds, setRemainingSeconds] = useState(0)
  const [enabled, setEnabled] = useState(true)
  const [distanceKm, setDistanceKm] = useState(0)

  useEffect(() => {
    if (!wsConnected) return
    const id = setInterval(() => {
      api.getCooldownStatus().then((s: { remaining_seconds?: number; enabled?: boolean; distance_km?: number }) => {
        setRemainingSeconds(s.remaining_seconds ?? 0)
        if (typeof s.enabled === 'boolean') setEnabled(s.enabled)
        if (typeof s.distance_km === 'number') setDistanceKm(s.distance_km)
      }).catch(() => { /* polling is best-effort; a dropped probe is not worth surfacing */ })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [wsConnected])

  // Optimistic: flip the UI immediately so the toggle feels responsive,
  // roll back if the backend rejects (rare — only on transient network fault).
  const toggleEnabled = useCallback((next: boolean) => {
    setEnabled(next)
    api.setCooldownEnabled(next).catch(() => setEnabled((v) => !v))
  }, [])

  return { remainingSeconds, enabled, distanceKm, toggleEnabled }
}
