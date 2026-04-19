/**
 * usePauseSettings — localStorage-backed pause configuration per simulation mode.
 *
 * Each pause-capable mode (multistop / loop / random_walk) stores its own
 * `{ enabled, min, max }` triple under a distinct key so the UI can remember
 * different cadences per mode. Reads are lazy on first mount; writes go
 * through the returned setter and persist immediately.
 *
 * Extracted from useSimulation to (a) collapse 3 copy-pasted state+save pairs
 * into one declarative call, and (b) make the storage shape testable in
 * isolation later.
 */
import { useCallback, useState } from 'react'

export interface PauseSetting {
  enabled: boolean
  min: number
  max: number
}

export const DEFAULT_PAUSE: PauseSetting = { enabled: true, min: 5, max: 20 }

const STORAGE_KEYS = {
  multiStop:  'locwarp.pause.multi_stop',
  loop:       'locwarp.pause.loop',
  randomWalk: 'locwarp.pause.random_walk',
} as const

function loadPause(key: string): PauseSetting {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return DEFAULT_PAUSE
    const p = JSON.parse(raw)
    return {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_PAUSE.enabled,
      min:     typeof p.min === 'number'     ? p.min     : DEFAULT_PAUSE.min,
      max:     typeof p.max === 'number'     ? p.max     : DEFAULT_PAUSE.max,
    }
  } catch {
    return DEFAULT_PAUSE
  }
}

function savePause(key: string, value: PauseSetting): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* localStorage may be disabled in strict private modes — silently ignore */
  }
}

interface UsePauseSettingsReturn {
  pauseMultiStop: PauseSetting
  pauseLoop: PauseSetting
  pauseRandomWalk: PauseSetting
  setPauseMultiStop: (v: PauseSetting) => void
  setPauseLoop: (v: PauseSetting) => void
  setPauseRandomWalk: (v: PauseSetting) => void
}

export function usePauseSettings(): UsePauseSettingsReturn {
  const [pauseMultiStop,  setMultiStopRaw]  = useState<PauseSetting>(() => loadPause(STORAGE_KEYS.multiStop))
  const [pauseLoop,       setLoopRaw]       = useState<PauseSetting>(() => loadPause(STORAGE_KEYS.loop))
  const [pauseRandomWalk, setRandomWalkRaw] = useState<PauseSetting>(() => loadPause(STORAGE_KEYS.randomWalk))

  // Setters only depend on their raw counterpart (stable identity from useState),
  // so the useCallback identities are stable for the component's lifetime —
  // safe to pass to memoized children without triggering re-renders.
  const setPauseMultiStop = useCallback((v: PauseSetting) => {
    setMultiStopRaw(v); savePause(STORAGE_KEYS.multiStop, v)
  }, [])
  const setPauseLoop = useCallback((v: PauseSetting) => {
    setLoopRaw(v); savePause(STORAGE_KEYS.loop, v)
  }, [])
  const setPauseRandomWalk = useCallback((v: PauseSetting) => {
    setRandomWalkRaw(v); savePause(STORAGE_KEYS.randomWalk, v)
  }, [])

  return {
    pauseMultiStop, pauseLoop, pauseRandomWalk,
    setPauseMultiStop, setPauseLoop, setPauseRandomWalk,
  }
}
