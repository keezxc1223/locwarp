import { useState, useCallback, useEffect, useRef } from 'react'
import * as api from '../services/api'
import { applyWsMessage } from '../services/simulation-ws-handler'
import type { WsMessage } from './useWebSocket'
import { usePauseSettings } from './usePauseSettings'

export enum SimMode {
  Teleport = 'teleport',
  Navigate = 'navigate',
  Loop = 'loop',
  Joystick = 'joystick',
  MultiStop = 'multistop',
  RandomWalk = 'randomwalk',
}

export enum MoveMode {
  Walking = 'walking',
  Running = 'running',
  Driving = 'driving',
}

export interface LatLng {
  lat: number
  lng: number
}

export interface SimulationStatus {
  running: boolean
  paused: boolean
  speed: number
  state?: string
  distance_remaining?: number
  distance_traveled?: number
}

export function useSimulation(wsMessage: WsMessage | null) {
  const [mode, setMode] = useState<SimMode>(SimMode.Teleport)
  const [moveMode, setMoveMode] = useState<MoveMode>(MoveMode.Walking)
  const [status, setStatus] = useState<SimulationStatus>({
    running: false,
    paused: false,
    speed: 0,
  })
  const [currentPosition, setCurrentPosition] = useState<LatLng | null>(null)
  const [destination, setDestination] = useState<LatLng | null>(null)
  const [progress, setProgress] = useState(0)
  const [eta, setEta] = useState<number | null>(null)
  const [waypoints, setWaypoints] = useState<LatLng[]>([])
  const [routePath, setRoutePath] = useState<LatLng[]>([])
  const [customSpeedKmh, setCustomSpeedKmh] = useState<number | null>(null)
  // 上下浮動 (±km/h)：自訂速度的隨機抖動量。設為 0 或 null = 固定速度。
  // 送到後端時會轉為 speed_min_kmh/speed_max_kmh（後端的 range 路徑）。
  const [customVarianceKmh, setCustomVarianceKmh] = useState<number | null>(null)

  // 將「自訂速度 + 浮動」轉成後端 SpeedOpts。
  // variance > 0 → 用 range（後端每趟隨機）；否則送 fixed speed_kmh。
  const buildSpeedOpts = useCallback((): { speed_kmh: number | null; speed_min_kmh: number | null; speed_max_kmh: number | null } => {
    if (customSpeedKmh != null && customVarianceKmh != null && customVarianceKmh > 0) {
      const lo = Math.max(0.1, customSpeedKmh - customVarianceKmh)
      const hi = customSpeedKmh + customVarianceKmh
      return { speed_kmh: null, speed_min_kmh: lo, speed_max_kmh: hi }
    }
    return { speed_kmh: customSpeedKmh, speed_min_kmh: null, speed_max_kmh: null }
  }, [customSpeedKmh, customVarianceKmh])

  // Per-mode pause settings, persisted in localStorage. See ./usePauseSettings.
  const {
    pauseMultiStop, setPauseMultiStop,
    pauseLoop, setPauseLoop,
    pauseRandomWalk, setPauseRandomWalk,
  } = usePauseSettings()
  const [error, setError] = useState<string | null>(null)
  // Random-walk pause countdown (unix epoch seconds of when pause ends)
  const [pauseEndAt, setPauseEndAt] = useState<number | null>(null)
  const [pauseRemaining, setPauseRemaining] = useState<number | null>(null)
  const [ddiMounting, setDdiMounting] = useState(false)

  // Tick the pause countdown at 1 Hz
  useEffect(() => {
    if (pauseEndAt == null) {
      setPauseRemaining(null)
      return
    }
    const tick = () => {
      const rem = Math.max(0, Math.round((pauseEndAt - Date.now()) / 1000))
      setPauseRemaining(rem)
      if (rem <= 0) setPauseEndAt(null)
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [pauseEndAt])

  // Process incoming WS messages — dispatch to a pure handler so the switch
  // is testable in isolation. See services/simulation-ws-handler.ts.
  useEffect(() => {
    if (!wsMessage) return
    applyWsMessage(wsMessage, {
      setCurrentPosition, setProgress, setEta, setStatus, setMode,
      setDestination, setWaypoints, setPauseEndAt, setRoutePath,
      setError, setDdiMounting,
    })
  }, [wsMessage])

  const clearError = useCallback(() => setError(null), [])

  const teleport = useCallback(async (lat: number, lng: number) => {
    setError(null)
    try {
      setMode(SimMode.Teleport)
      const res = await api.teleport(lat, lng)
      setCurrentPosition({ lat, lng })
      setDestination(null)
      setProgress(0)
      setEta(null)
      return res
    } catch (err) {
      setError(api.errMsg(err))
      throw err
    }
  }, [])

  const navigate = useCallback(
    async (lat: number, lng: number) => {
      setError(null)
      try {
        setMode(SimMode.Navigate)
        setDestination({ lat, lng })
        setProgress(0)
        const res = await api.navigate(lat, lng, moveMode, buildSpeedOpts())
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        return res
      } catch (err) {
        setError(api.errMsg(err))
        throw err
      }
    },
    [moveMode, buildSpeedOpts],
  )

  const startLoop = useCallback(
    async (wps: LatLng[]) => {
      setError(null)
      try {
        setMode(SimMode.Loop)
        setWaypoints(wps)
        setProgress(0)
        const res = await api.startLoop(wps, moveMode, buildSpeedOpts(), { pause_enabled: pauseLoop.enabled, pause_min: pauseLoop.min, pause_max: pauseLoop.max })
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        return res
      } catch (err) {
        setError(api.errMsg(err))
        throw err
      }
    },
    [moveMode, buildSpeedOpts, pauseLoop],
  )

  const multiStop = useCallback(
    async (wps: LatLng[], stopDuration: number, loop: boolean) => {
      setError(null)
      try {
        setMode(SimMode.MultiStop)
        setWaypoints(wps)
        setProgress(0)
        const res = await api.multiStop(wps, moveMode, stopDuration, loop, buildSpeedOpts(), { pause_enabled: pauseMultiStop.enabled, pause_min: pauseMultiStop.min, pause_max: pauseMultiStop.max })
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        return res
      } catch (err) {
        setError(api.errMsg(err))
        throw err
      }
    },
    [moveMode, buildSpeedOpts, pauseMultiStop],
  )

  const randomWalk = useCallback(
    async (center: LatLng, radiusM: number) => {
      setError(null)
      try {
        setMode(SimMode.RandomWalk)
        setProgress(0)
        const res = await api.randomWalk(center, radiusM, moveMode, buildSpeedOpts(), { pause_enabled: pauseRandomWalk.enabled, pause_min: pauseRandomWalk.min, pause_max: pauseRandomWalk.max })
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        return res
      } catch (err) {
        setError(api.errMsg(err))
        throw err
      }
    },
    [moveMode, buildSpeedOpts, pauseRandomWalk],
  )

  const joystickStart = useCallback(async () => {
    setError(null)
    try {
      setMode(SimMode.Joystick)
      const res = await api.joystickStart(moveMode, buildSpeedOpts())
      setStatus((prev) => ({ ...prev, running: true, paused: false }))
      return res
    } catch (err) {
      setError(api.errMsg(err))
      throw err
    }
  }, [moveMode, buildSpeedOpts])

  const joystickStop = useCallback(async () => {
    setError(null)
    try {
      const res = await api.joystickStop()
      // leave mode as-is; status drives running state
      setStatus((prev) => ({ ...prev, running: false, paused: false }))
      return res
    } catch (err) {
      setError(api.errMsg(err))
      throw err
    }
  }, [])

  const pause = useCallback(async () => {
    setError(null)
    try {
      const res = await api.pauseSim()
      setStatus((prev) => ({ ...prev, paused: true }))
      return res
    } catch (err) {
      setError(api.errMsg(err))
      throw err
    }
  }, [])

  const resume = useCallback(async () => {
    setError(null)
    try {
      const res = await api.resumeSim()
      setStatus((prev) => ({ ...prev, paused: false }))
      return res
    } catch (err) {
      setError(api.errMsg(err))
      throw err
    }
  }, [])

  const restore = useCallback(async () => {
    setError(null)
    try {
      const res = await api.restoreSim()
      // leave mode as-is; status drives running state
      setStatus({ running: false, paused: false, speed: 0 })
      setDestination(null)
      setProgress(0)
      setEta(null)
      setWaypoints([])
      setRoutePath([])
      // 清掉 currentPosition 給使用者視覺回饋：
      // 之前 map pin 停留在虛擬位置，讓使用者以為「還原沒作用」。
      // 實體 GPS 要 10~30s 才會重新取得，map 空白正好提示這個過渡狀態。
      setCurrentPosition(null)
      return res
    } catch (err) {
      setError(api.errMsg(err))
      throw err
    }
  }, [])

  // Fetch initial status on mount.
  // Two-phase: first try the live engine status; if no position is available
  // (device not yet connected), fall back to the startup position so the map
  // always opens on a meaningful location.
  const initialFetched = useRef(false)
  useEffect(() => {
    if (initialFetched.current) return
    initialFetched.current = true

    api.getStatus().then((res: any) => {
      // current_position (not position) is the backend field name
      if (res.current_position) {
        setCurrentPosition({ lat: res.current_position.lat, lng: res.current_position.lng })
      }
      if (res.state) {
        const running = !['idle', 'disconnected', 'teleporting'].includes(res.state)
        const paused = res.state === 'paused' || !!res.is_paused
        setStatus((prev) => ({
          ...prev,
          running,
          paused,
          state: res.state,
          // speed_mps → km/h for display
          speed: res.speed_mps != null ? Math.round(res.speed_mps * 3.6) : prev.speed,
          distance_remaining: res.distance_remaining ?? prev.distance_remaining,
          distance_traveled: res.distance_traveled ?? prev.distance_traveled,
        }))
      }
      if (res.progress != null) setProgress(res.progress)
      if (res.eta_seconds != null) setEta(res.eta_seconds)

      // If engine had no position (no device), load startup position for map centering
      if (!res.current_position) {
        api.getInitialPosition().then((pos) => {
          setCurrentPosition({ lat: pos.lat, lng: pos.lng })
        }).catch(() => {})
      }
    }).catch(() => {
      // Backend not running yet — try startup position directly
      api.getInitialPosition().then((pos) => {
        setCurrentPosition({ lat: pos.lat, lng: pos.lng })
      }).catch(() => {})
    })
  }, [])

  return {
    mode,
    setMode,
    moveMode,
    setMoveMode,
    status,
    currentPosition,
    destination,
    progress,
    eta,
    waypoints,
    setWaypoints,
    routePath,
    customSpeedKmh,
    setCustomSpeedKmh,
    customVarianceKmh,
    setCustomVarianceKmh,
    pauseMultiStop,
    setPauseMultiStop,
    pauseLoop,
    setPauseLoop,
    pauseRandomWalk,
    setPauseRandomWalk,
    pauseRemaining,
    ddiMounting,
    error,
    clearError,
    teleport,
    navigate,
    startLoop,
    multiStop,
    randomWalk,
    joystickStart,
    joystickStop,
    pause,
    resume,
    restore,
  }
}
