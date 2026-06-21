import { useState, useCallback, useEffect, useRef } from 'react'
import * as api from '../services/api'
import type { WsMessage } from './useWebSocket'
import { playCompletionAlert } from '../services/alertSound'

export enum SimMode {
  Teleport = 'teleport',
  Navigate = 'navigate',
  Loop = 'loop',
  Joystick = 'joystick',
  RandomWalk = 'randomwalk',
  GoldDitto = 'goldditto',
  Flower = 'flower',
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
  // Per-leg countdown (route_loop / multi_stop). Differs from
  // distance_remaining when there are still legs queued after this one,
  // so the EtaBar can show "next stop" alongside "whole lap/trip".
  leg_distance_remaining?: number
  leg_eta_seconds?: number
}

export type WsSubscribe = (fn: (m: WsMessage) => void) => () => void

// Mode → preset km/h. Kept in sync with ControlPanel's preset buttons
// so the status bar shows the correct "mode default" when the user
// applies a preset without a custom km/h.
const MODE_DEFAULT_KMH: Record<MoveMode, number> = {
  [MoveMode.Walking]: 10.8,
  [MoveMode.Running]: 19.8,
  [MoveMode.Driving]: 60,
}

// ── Per-device runtime state (group mode) ──────────────────────────────
export interface DeviceRuntime {
  udid: string
  state: string
  currentPos: LatLng | null
  destination: LatLng | null
  routePath: LatLng[]
  progress: number
  eta: number
  distanceRemaining: number
  distanceTraveled: number
  waypointIndex: number | null
  currentSpeedKmh: number
  error: string | null
  lapCount: number
  cooldown: number
}

export type RuntimesMap = Record<string, DeviceRuntime>

function emptyRuntime(udid: string): DeviceRuntime {
  return {
    udid,
    state: 'idle',
    currentPos: null,
    destination: null,
    routePath: [],
    progress: 0,
    eta: 0,
    distanceRemaining: 0,
    distanceTraveled: 0,
    waypointIndex: null,
    currentSpeedKmh: 0,
    error: null,
    lapCount: 0,
    cooldown: 0,
  }
}

// ── Fan-out helper ─────────────────────────────────────────────────────
export interface FanoutOutcome<T> {
  ok: Array<{ udid: string; value: T }>
  failed: Array<{ udid: string; reason: string }>
}

export function summarizeResults<T>(
  results: PromiseSettledResult<T>[],
  udids: string[],
  _action: string,
): FanoutOutcome<T> {
  const ok: FanoutOutcome<T>['ok'] = []
  const failed: FanoutOutcome<T>['failed'] = []
  results.forEach((r, i) => {
    const udid = udids[i]
    if (r.status === 'fulfilled') ok.push({ udid, value: r.value })
    else failed.push({ udid, reason: r.reason?.message ?? String(r.reason) })
  })
  return { ok, failed }
}

export function useSimulation(subscribe?: WsSubscribe, primaryUdid?: string | null) {
  // In dual-device mode every position_update carries a udid. Without a
  // filter, the legacy single-device setters below run for BOTH devices
  // and the global currentPosition ping-pongs between each device's
  // independently jittered coordinate, making the marker look stuttery.
  // Keep a ref so WS handler reads the latest primary synchronously.
  const primaryUdidRef = useRef<string | null>(primaryUdid ?? null)
  useEffect(() => { primaryUdidRef.current = primaryUdid ?? null }, [primaryUdid])
  const [mode, _setMode] = useState<SimMode>(SimMode.Teleport)
  // Persisted so the user's preferred default speed survives restarts,
  // instead of always falling back to walking.
  const [moveMode, setMoveModeRaw] = useState<MoveMode>(() => {
    try {
      const v = localStorage.getItem('locwarp.speed.mode')
      if (v === MoveMode.Walking || v === MoveMode.Running || v === MoveMode.Driving) {
        return v as MoveMode
      }
    } catch { /* ignore */ }
    return MoveMode.Walking
  })
  const setMoveMode = useCallback((m: MoveMode) => {
    setMoveModeRaw(m)
    try { localStorage.setItem('locwarp.speed.mode', m) } catch { /* ignore */ }
  }, [])
  const [status, setStatus] = useState<SimulationStatus>({
    running: false,
    paused: false,
    speed: 0,
  })
  // Mirror status into a ref so callbacks captured with empty deps
  // (e.g. setMode) can read the live value without re-binding.
  const statusRef = useRef(status)
  useEffect(() => { statusRef.current = status }, [status])
  const [currentPosition, setCurrentPosition] = useState<LatLng | null>(null)
  const [destination, setDestination] = useState<LatLng | null>(null)
  const [progress, setProgress] = useState(0)
  const [eta, setEta] = useState<number | null>(null)
  const [waypoints, setWaypoints] = useState<LatLng[]>([])
  const [routePath, setRoutePath] = useState<LatLng[]>([])
  const [customSpeedKmh, setCustomSpeedKmhRaw] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem('locwarp.speed.custom_kmh')
      if (v != null) { const n = parseFloat(v); if (Number.isFinite(n) && n > 0) return n }
    } catch { /* ignore */ }
    return null
  })
  const setCustomSpeedKmh = useCallback((v: number | null) => {
    setCustomSpeedKmhRaw(v)
    try {
      if (v == null) localStorage.removeItem('locwarp.speed.custom_kmh')
      else localStorage.setItem('locwarp.speed.custom_kmh', String(v))
    } catch { /* ignore */ }
  }, [])
  const [speedMinKmh, setSpeedMinKmh] = useState<number | null>(null)
  const [speedMaxKmh, setSpeedMaxKmh] = useState<number | null>(null)
  // Global "straight-line path" toggle. When on, all nav modes bypass OSRM
  // and move along densified straight segments between waypoints.
  const [straightLine, setStraightLineRaw] = useState<boolean>(() => {
    try { return localStorage.getItem('locwarp.straight_line') === '1' } catch { return false }
  })
  const setStraightLine = (v: boolean) => {
    setStraightLineRaw(v)
    try { localStorage.setItem('locwarp.straight_line', v ? '1' : '0') } catch { /* ignore */ }
  }

  // "Keep path points" toggle. When on, switching modes does NOT clear the
  // placed waypoints / route line, so the user can carry the same path
  // between multi-stop and route-loop modes. Persisted in localStorage.
  const [keepWaypoints, setKeepWaypointsRaw] = useState<boolean>(() => {
    try { return localStorage.getItem('locwarp.keep_waypoints') === '1' } catch { return false }
  })
  const keepWaypointsRef = useRef(keepWaypoints)
  useEffect(() => { keepWaypointsRef.current = keepWaypoints }, [keepWaypoints])
  const setKeepWaypoints = (v: boolean) => {
    setKeepWaypointsRaw(v)
    try { localStorage.setItem('locwarp.keep_waypoints', v ? '1' : '0') } catch { /* ignore */ }
  }

  // Random-walk circle centre mode. "fixed" pins the circle to the start
  // point (bounded walk); "follow" re-centres on the current position each
  // leg (free wander). Persisted in localStorage.
  const [randomWalkCenterMode, setRandomWalkCenterModeRaw] = useState<'fixed' | 'follow'>(() => {
    try { return localStorage.getItem('locwarp.rw_center_mode') === 'follow' ? 'follow' : 'fixed' } catch { return 'fixed' }
  })
  const setRandomWalkCenterMode = (v: 'fixed' | 'follow') => {
    setRandomWalkCenterModeRaw(v)
    try { localStorage.setItem('locwarp.rw_center_mode', v) } catch { /* ignore */ }
  }

  // Forward (correlated) random walk: directional persistence so the path
  // flows forward instead of doubling back onto the road just walked.
  interface ForwardWalk { enabled: boolean; turnDeg: number }
  const [forwardWalk, setForwardWalkRaw] = useState<ForwardWalk>(() => {
    try {
      const raw = localStorage.getItem('locwarp.rw_forward')
      if (raw) {
        const p = JSON.parse(raw)
        return { enabled: !!p.enabled, turnDeg: typeof p.turnDeg === 'number' ? p.turnDeg : 35 }
      }
    } catch { /* ignore */ }
    return { enabled: false, turnDeg: 35 }
  })
  const setForwardWalk = (v: ForwardWalk) => {
    setForwardWalkRaw(v)
    try { localStorage.setItem('locwarp.rw_forward', JSON.stringify(v)) } catch { /* ignore */ }
  }
  // Captured centre of the active random walk (the start point the backend
  // pins the sampling circle to). Lets the map circle freeze there in
  // "fixed" mode instead of drifting with the avatar.
  const [randomWalkCenter, setRandomWalkCenter] = useState<LatLng | null>(null)

  // Routing engine selection. Persisted in localStorage; backend default is
  // 'osrm' so omitting the field is equivalent to picking it explicitly.
  const ROUTE_ENGINES = ['osrm', 'osrm_fossgis', 'valhalla', 'brouter'] as const
  type RouteEngine = typeof ROUTE_ENGINES[number]
  const [routeEngine, setRouteEngineRaw] = useState<RouteEngine>(() => {
    try {
      const saved = localStorage.getItem('locwarp.route_engine')
      if (saved && (ROUTE_ENGINES as readonly string[]).includes(saved)) return saved as RouteEngine
    } catch { /* ignore */ }
    return 'osrm'
  })
  const setRouteEngine = (v: RouteEngine) => {
    setRouteEngineRaw(v)
    try { localStorage.setItem('locwarp.route_engine', v) } catch { /* ignore */ }
  }

  // Per-mode pause settings, persisted in localStorage.
  interface PauseSetting { enabled: boolean; min: number; max: number }
  const defaultPause: PauseSetting = { enabled: true, min: 5, max: 20 }
  const loadPause = (key: string): PauseSetting => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return defaultPause
      const p = JSON.parse(raw)
      return {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
        min: typeof p.min === 'number' ? p.min : 5,
        max: typeof p.max === 'number' ? p.max : 20,
      }
    } catch {
      return defaultPause
    }
  }
  const savePause = (key: string, v: PauseSetting) => {
    try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* ignore */ }
  }
  const [pauseLoop, setPauseLoopRaw] = useState<PauseSetting>(() => loadPause('locwarp.pause.loop'))
  const [pauseRandomWalk, setPauseRandomWalkRaw] = useState<PauseSetting>(() => loadPause('locwarp.pause.random_walk'))
  const setPauseLoop = (v: PauseSetting) => { setPauseLoopRaw(v); savePause('locwarp.pause.loop', v) }
  const setPauseRandomWalk = (v: PauseSetting) => { setPauseRandomWalkRaw(v); savePause('locwarp.pause.random_walk', v) }
  const [error, setError] = useState<string | null>(null)
  // Random-walk pause countdown (unix epoch seconds of when pause ends)
  const [pauseEndAt, setPauseEndAt] = useState<number | null>(null)
  const [pauseRemaining, setPauseRemaining] = useState<number | null>(null)
  const [ddiMounting, setDdiMounting] = useState(false)
  // Stage within the DDI mount pipeline. null when not mounting, else
  // one of the backend's stage names (starting / downloading / verifying
  // / signing / uploading / mounting). `elapsed` is seconds since the
  // mount started, used for a rough ETA estimate in the overlay.
  const [ddiStage, setDdiStage] = useState<{ stage: string; elapsed: number } | null>(null)
  const [waypointProgress, setWaypointProgress] = useState<{ current: number; next: number; total: number } | null>(null)
  // Loop lap tracker. `current` = laps completed so far; `total` = the
  // configured lap limit if the user asked for auto-stop, or null for an
  // unbounded loop. Updated on `lap_complete` WS events from the backend.
  const [lapProgress, setLapProgress] = useState<{ current: number; total: number | null } | null>(null)
  // User's preferred lap count for the Loop mode start button. Null / 0 = no limit.
  // 多點路徑 lap setting, three states:
  //   0    → single pass, original 多點導航 (routes to the multiStop backend)
  //   null → infinite loop
  //   N>0  → run N laps then stop
  // Default is 0 (single pass). 'inf' is the on-disk marker for the null state.
  const [loopLapCount, setLoopLapCountRaw] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('locwarp.loop.lap_count')
      if (raw == null) return 0
      if (raw === 'inf') return null
      const n = parseInt(raw, 10)
      return Number.isFinite(n) && n >= 0 ? n : 0
    } catch { return 0 }
  })
  const setLoopLapCount = useCallback((v: number | null) => {
    setLoopLapCountRaw(v)
    try {
      localStorage.setItem('locwarp.loop.lap_count', v == null ? 'inf' : String(v))
    } catch { /* ignore quota errors */ }
  }, [])

  // 種花模式 settings — all persisted so they survive a restart. Each
  // flower (waypoint) is circled at `flowerRadius` metres using
  // `flowerSegments` vertices, `flowerCircles` laps; the whole list runs
  // `flowerRounds` times. The device waits `flowerPreWait` before moving
  // to a flower and `flowerPostWait` after arriving. `flowerTeleport`
  // toggles teleport-between-flowers vs walking the route.
  const loadNum = (key: string, def: number, min: number): number => {
    try {
      const n = parseFloat(localStorage.getItem(key) || '')
      if (Number.isFinite(n) && n >= min) return n
    } catch { /* ignore */ }
    return def
  }
  const [flowerRadius, setFlowerRadiusRaw] = useState<number>(() => loadNum('locwarp.flower.radius', 30, 1))
  const setFlowerRadius = useCallback((v: number) => {
    const c = Number.isFinite(v) && v >= 1 ? v : 30
    setFlowerRadiusRaw(c)
    try { localStorage.setItem('locwarp.flower.radius', String(c)) } catch { /* ignore */ }
  }, [])
  const [flowerSegments, setFlowerSegmentsRaw] = useState<number>(() => loadNum('locwarp.flower.segments', 8, 2))
  const setFlowerSegments = useCallback((v: number) => {
    const c = Number.isFinite(v) ? Math.min(10, Math.max(2, Math.round(v))) : 8
    setFlowerSegmentsRaw(c)
    try { localStorage.setItem('locwarp.flower.segments', String(c)) } catch { /* ignore */ }
  }, [])
  const [flowerCircles, setFlowerCirclesRaw] = useState<number>(() => loadNum('locwarp.flower.circles', 1, 1))
  const setFlowerCircles = useCallback((v: number) => {
    const c = Number.isFinite(v) && v >= 1 ? Math.round(v) : 1
    setFlowerCirclesRaw(c)
    try { localStorage.setItem('locwarp.flower.circles', String(c)) } catch { /* ignore */ }
  }, [])
  const [flowerRounds, setFlowerRoundsRaw] = useState<number>(() => loadNum('locwarp.flower.rounds', 1, 1))
  const setFlowerRounds = useCallback((v: number) => {
    const c = Number.isFinite(v) && v >= 1 ? Math.round(v) : 1
    setFlowerRoundsRaw(c)
    try { localStorage.setItem('locwarp.flower.rounds', String(c)) } catch { /* ignore */ }
  }, [])
  const [flowerPreWait, setFlowerPreWaitRaw] = useState<number>(() => loadNum('locwarp.flower.pre_wait', 3, 0))
  const setFlowerPreWait = useCallback((v: number) => {
    const c = Number.isFinite(v) && v >= 0 ? v : 3
    setFlowerPreWaitRaw(c)
    try { localStorage.setItem('locwarp.flower.pre_wait', String(c)) } catch { /* ignore */ }
  }, [])
  const [flowerPostWait, setFlowerPostWaitRaw] = useState<number>(() => loadNum('locwarp.flower.post_wait', 3, 0))
  const setFlowerPostWait = useCallback((v: number) => {
    const c = Number.isFinite(v) && v >= 0 ? v : 3
    setFlowerPostWaitRaw(c)
    try { localStorage.setItem('locwarp.flower.post_wait', String(c)) } catch { /* ignore */ }
  }, [])
  const [flowerTeleport, setFlowerTeleportRaw] = useState<boolean>(() => {
    try { return localStorage.getItem('locwarp.flower.teleport') === '1' } catch { return false }
  })
  const setFlowerTeleport = useCallback((v: boolean) => {
    setFlowerTeleportRaw(v)
    try { localStorage.setItem('locwarp.flower.teleport', v ? '1' : '0') } catch { /* ignore */ }
  }, [])

  // Jump mode (point-to-point teleport with configurable pre / post
  // delays around each teleport). Persisted so the user's settings
  // survive a reload.
  const [jumpMode, setJumpModeRaw] = useState<boolean>(() => {
    try { return localStorage.getItem('locwarp.jump.mode') === '1' } catch { return false }
  })
  const setJumpMode = useCallback((v: boolean) => {
    setJumpModeRaw(v)
    try { localStorage.setItem('locwarp.jump.mode', v ? '1' : '0') } catch { /* ignore */ }
  }, [])
  const [jumpPreDelay, setJumpPreDelayRaw] = useState<number>(() => {
    try {
      const n = parseFloat(localStorage.getItem('locwarp.jump.pre_delay') || '2')
      return Number.isFinite(n) && n >= 0 ? n : 2
    } catch { return 2 }
  })
  const setJumpPreDelay = useCallback((v: number) => {
    const clamped = Number.isFinite(v) && v >= 0 ? v : 2
    setJumpPreDelayRaw(clamped)
    try { localStorage.setItem('locwarp.jump.pre_delay', String(clamped)) } catch { /* ignore */ }
  }, [])
  const [jumpPostDelay, setJumpPostDelayRaw] = useState<number>(() => {
    try {
      const n = parseFloat(localStorage.getItem('locwarp.jump.post_delay') || '4')
      return Number.isFinite(n) && n >= 0 ? n : 4
    } catch { return 4 }
  })
  const setJumpPostDelay = useCallback((v: number) => {
    const clamped = Number.isFinite(v) && v >= 0 ? v : 4
    setJumpPostDelayRaw(clamped)
    try { localStorage.setItem('locwarp.jump.post_delay', String(clamped)) } catch { /* ignore */ }
  }, [])
  // What's *actually* running on the device — set when a route handler
  // starts or when applySpeed succeeds. Used by the status bar so the
  // user doesn't see a typed-or-preset-selected speed before it has
  // been applied. Initialized to the walking default so the status bar
  // has something sensible to show before the first apply / start.
  const [effectiveSpeed, setEffectiveSpeed] = useState<
    { kmh: number | null; min: number | null; max: number | null } | null
  >({ kmh: MODE_DEFAULT_KMH.walking, min: null, max: null })

  // Per-device runtime map (group mode). Populated from WS events tagged with udid.
  const [runtimes, setRuntimes] = useState<RuntimesMap>({})
  const updateRuntime = useCallback((udid: string, patch: Partial<DeviceRuntime>) => {
    setRuntimes((prev) => {
      const cur = prev[udid] ?? emptyRuntime(udid)
      return { ...prev, [udid]: { ...cur, ...patch } }
    })
  }, [])

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

  // Process incoming WS messages via subscribe callback. The old
  // useState-based approach dropped messages when two arrived in the
  // same React tick; see useWebSocket.ts for details.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((wsMessage) => {
    // ── Group mode: mirror per-device state into `runtimes` map ────────
    const udid: string | undefined = wsMessage.data?.udid
    if (udid) {
      const d = wsMessage.data
      switch (wsMessage.type) {
        case 'position_update':
          updateRuntime(udid, {
            currentPos: (typeof d.lat === 'number' && typeof d.lng === 'number') ? { lat: d.lat, lng: d.lng } : undefined as any,
            progress: d.progress ?? undefined as any,
            eta: d.eta_seconds ?? d.eta ?? undefined as any,
            distanceRemaining: d.distance_remaining ?? undefined as any,
            distanceTraveled: d.distance_traveled ?? undefined as any,
            currentSpeedKmh: d.speed_mps != null ? d.speed_mps * 3.6 : undefined as any,
          })
          break
        case 'route_path':
          if (Array.isArray(d.coords)) {
            updateRuntime(udid, {
              routePath: d.coords.map((p: any) => ({ lat: p.lat ?? p[0], lng: p.lng ?? p[1] })),
            })
          }
          break
        case 'state_change':
          if (d.state) updateRuntime(udid, { state: d.state, ...(d.state === 'idle' || d.state === 'disconnected' ? { routePath: [] } : {}) })
          break
        case 'device_connected':
          setRuntimes((prev) => prev[udid] ? prev : { ...prev, [udid]: emptyRuntime(udid) })
          // A device reconnecting implicitly resolves any prior connection-
          // loss banner (watchdog auto-connect now broadcasts `device_connected`
          // rather than `device_reconnected`; the legacy case still handles
          // the latter).
          setError(null)
          break
        case 'device_disconnected':
          updateRuntime(udid, { state: 'disconnected' })
          break
        case 'simulation_complete':
          updateRuntime(udid, { progress: 1, state: 'idle' })
          break
        case 'waypoint_progress':
          if (typeof d.current_index === 'number') {
            updateRuntime(udid, { waypointIndex: d.current_index })
          }
          break
      }
    }
    // Dual-device filter: when a primary is set, only let events tagged
    // with the primary's udid update the global (single-device) state.
    // Untagged events still flow through (used by legacy test paths).
    const msgUdid: string | undefined = wsMessage.data?.udid
    const primary = primaryUdidRef.current
    if (primary && msgUdid && msgUdid !== primary) {
      return
    }
    switch (wsMessage.type) {
      case 'position_update': {
        const { lat, lng } = wsMessage.data
        if (typeof lat === 'number' && typeof lng === 'number') {
          setCurrentPosition({ lat, lng })
        }
        if (wsMessage.data.progress != null) {
          setProgress(wsMessage.data.progress)
        }
        {
          const etaVal = wsMessage.data.eta_seconds ?? wsMessage.data.eta
          if (etaVal != null) setEta(etaVal)
        }
        {
          const dr = wsMessage.data.distance_remaining
          const dt = wsMessage.data.distance_traveled
          const legDr = wsMessage.data.leg_distance_remaining
          const legEta = wsMessage.data.leg_eta_seconds
          if (dr != null || dt != null || legDr != null || legEta != null) {
            setStatus((prev) => ({
              ...prev,
              ...(dr != null ? { distance_remaining: dr } : {}),
              ...(dt != null ? { distance_traveled: dt } : {}),
              ...(legDr != null ? { leg_distance_remaining: legDr } : {}),
              ...(legEta != null ? { leg_eta_seconds: legEta } : {}),
            }))
          }
        }
        break
      }
      case 'simulation_state': {
        const d = wsMessage.data
        setStatus({
          running: !!d.running,
          paused: !!d.paused,
          speed: d.speed ?? 0,
          state: d.state,
          distance_remaining: d.distance_remaining,
          distance_traveled: d.distance_traveled,
        })
        if (d.mode) _setMode(d.mode)
        if (d.progress != null) setProgress(d.progress)
        if (d.eta != null) setEta(d.eta)
        if (d.destination) setDestination(d.destination)
        if (d.waypoints) setWaypoints(d.waypoints)
        break
      }
      case 'simulation_complete':
      case 'navigation_complete':
      case 'multi_stop_complete':
      case 'flower_complete':
      case 'loop_complete': {
        setStatus((prev) => ({ ...prev, running: false, paused: false }))
        setProgress(1)
        setEta(null)
        setPauseEndAt(null)
        setWaypointProgress(null)
        setLapProgress(null)
        setDestination(null)
        setRoutePath([])
        // Route reached its end naturally (vs user pressing stop). Fire
        // the user-toggleable cascading-bell alert; alertSound's setting
        // gate suppresses playback when disabled.
        playCompletionAlert()
        break
      }
      case 'waypoint_progress': {
        const d = wsMessage.data
        if (d && typeof d.current_index === 'number') {
          setWaypointProgress({
            current: d.current_index,
            next: d.next_index ?? d.current_index + 1,
            total: d.total ?? 0,
          })
        }
        break
      }
      case 'lap_complete': {
        const d = wsMessage.data
        if (d && typeof d.lap === 'number') {
          setLapProgress({
            current: d.lap,
            total: typeof d.total === 'number' && d.total > 0 ? d.total : null,
          })
        }
        break
      }
      case 'ddi_mounting': {
        setDdiMounting(true)
        const d = wsMessage.data
        if (d && typeof d.stage === 'string') {
          setDdiStage({ stage: d.stage, elapsed: typeof d.elapsed === 'number' ? d.elapsed : 0 })
        }
        break
      }
      case 'ddi_mounted':
      case 'ddi_mount_failed': {
        setDdiMounting(false)
        setDdiStage(null)
        break
      }
      case 'ddi_not_mounted': {
        // Backend reports the DDI isn't mounted. Silently dismiss the
        // mount-progress overlay; we no longer surface the hint as a
        // banner because most users on iOS 17+ have DDI auto-mounted by
        // a prior tool and the warning fires spuriously after every
        // reconnect. Users who genuinely lack DDI will see the failure
        // when an action (teleport / navigate) actually returns an
        // error from the device.
        setDdiMounting(false)
        setDdiStage(null)
        break
      }
      case 'tunnel_lost': {
        // Uses localStorage to get current language (hooks don't have i18n context easily here)
        setError((typeof localStorage !== 'undefined' && localStorage.getItem('locwarp.lang') === 'en')
          ? 'Wi-Fi tunnel dropped, please reconnect'
          : 'WiFi Tunnel 連線中斷,請重新建立')
        break
      }
      case 'device_disconnected': {
        // In dual-device mode we only show the full-screen banner when the
        // LAST connected device goes away. If another device is still alive
        // (remaining_count > 0), the sidebar chip already reflects the
        // per-device state; no need to nag the user. Backward compat: when
        // the broadcast omits remaining_count we default to 0 (old behaviour).
        const remaining = typeof wsMessage.data?.remaining_count === 'number'
          ? wsMessage.data.remaining_count : 0
        if (remaining === 0) {
          const isEn = typeof localStorage !== 'undefined' && localStorage.getItem('locwarp.lang') === 'en'
          setError(isEn
            ? 'Device disconnected (USB unplugged or tunnel died), please reconnect USB'
            : '裝置連線中斷(USB 拔除或 Tunnel 死亡),請重新插上 USB')
          setStatus((prev) => ({ ...prev, running: false, paused: false }))
        } else {
          // Clear any stale banner in case a previous lost-all event left it
          // visible; the fact that at least one device is still connected
          // means we're back to a healthy state.
          setError(null)
        }
        break
      }
      case 'device_reconnected': {
        // Auto-reconnected by the usbmux watchdog after a re-plug, clear
        // the banner; the success is already visible via DeviceStatus.
        setError(null)
        break
      }
      case 'pause_countdown':
      case 'random_walk_pause': {
        const dur = wsMessage.data?.duration_seconds
        if (typeof dur === 'number' && dur > 0) {
          setPauseEndAt(Date.now() + dur * 1000)
        }
        break
      }
      case 'pause_countdown_end':
      case 'random_walk_pause_end': {
        setPauseEndAt(null)
        break
      }
      case 'route_path': {
        const pts = wsMessage.data?.coords
        if (Array.isArray(pts)) {
          setRoutePath(pts.map((p: any) => ({ lat: p.lat ?? p[0], lng: p.lng ?? p[1] })))
        }
        break
      }
      case 'state_change': {
        const st = wsMessage.data?.state
        if (st === 'idle') {
          // User-initiated stop or natural sim completion: clear the
          // overlays so the map goes back to a clean state.
          setStatus((prev) => ({ ...prev, running: false, paused: false, state: st }))
          setRoutePath([])
          setDestination(null)
          setEta(null)
          setRandomWalkCenter(null)
        } else if (st === 'disconnected') {
          // USB unplug or tunnel death of THIS engine. In dual-device
          // mode the surviving device is still running the same sim, so
          // keep routePath / destination AND keep running/paused alone:
          // flipping running to false here would revert the toolbar's
          // 停止 button back to 開始 even though the other device is
          // still actively running the simulation. Just record the new
          // state for completeness; the global running flag is reset by
          // the device_disconnected handler when remaining_count hits 0.
          setStatus((prev) => ({ ...prev, state: st }))
        } else if (st === 'paused') {
          setStatus((prev) => ({ ...prev, paused: true, state: st }))
        } else if (st) {
          setStatus((prev) => ({ ...prev, running: true, paused: false, state: st }))
          // Random walk broadcasts the fixed sampling centre on start; keep
          // it so the map can pin the radius circle there (fixed mode).
          if (st === 'random_walk' && wsMessage.data?.center) {
            const c = wsMessage.data.center
            setRandomWalkCenter({ lat: c.lat, lng: c.lng })
          }
        }
        break
      }
      case 'simulation_error': {
        setError(wsMessage.data?.message ?? 'Simulation error')
        break
      }
    }
    })
  }, [subscribe, updateRuntime])

  const clearError = useCallback(() => setError(null), [])

  // Public mode setter: clears the destination marker + route path when the
  // user switches mode tabs. Internal handlers (teleport/navigate/loop/...)
  // still use _setMode directly so they can set destination in the same tick.
  // While a simulation is in progress, switching tabs is just a UI peek —
  // we keep the live route, destination, and waypoints on screen so the
  // user can come back to the running mode without losing context.
  const setMode = useCallback((next: SimMode) => {
    _setMode((prev) => {
      if (prev !== next && !statusRef.current.running && !statusRef.current.paused) {
        setDestination(null)
        setProgress(0)
        setEta(null)
        // When "keep path points" is on, retain the placed waypoints + route
        // line across mode switches so the user can reuse the same path in
        // another mode. Otherwise clear them as before.
        if (!keepWaypointsRef.current) {
          setRoutePath([])
          setWaypoints([])
        }
      }
      return next
    })
  }, [])

  // Load a saved route: switch into the route (Loop) mode AND populate the
  // waypoint list in one shot. Done directly (not via setMode) so the route
  // survives even when "keep path points" is off — setMode would otherwise
  // wipe the waypoints we just set. Fixes "press 開始 does nothing" when the
  // app was still in 瞬間移動 at the moment a route was loaded.
  const loadRoute = useCallback((wps: LatLng[]) => {
    _setMode(SimMode.Loop)
    setDestination(null)
    setProgress(0)
    setEta(null)
    setRoutePath([])
    setWaypoints(wps)
  }, [])

  const teleport = useCallback(async (lat: number, lng: number) => {
    setError(null)
    try {
      // Intentionally NOT calling _setMode here. Teleport is an ACTION
      // (right-click / bookmark / recent / address / locate-PC / coord
      // overlay all flow through here), not a mode switch. Mode change
      // only happens when the user explicitly clicks the Teleport tab in
      // ControlPanel, which goes through the separate setMode() path
      // that also wipes waypoints / destination / routePath. Previously,
      // this line flipped sim.mode to Teleport on every teleport action,
      // which was visible as "setting up Loop waypoints, right-clicking
      // to teleport, then finding waypoints gone" — the tab switch made
      // the Loop UI unmount its waypoint list. Removing this one line is
      // the entire fix.
      const res = await api.teleport(lat, lng)
      setCurrentPosition({ lat, lng })
      setDestination(null)
      setProgress(0)
      setEta(null)
      return res
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [])

  const navigate = useCallback(
    async (lat: number, lng: number) => {
      setError(null)
      try {
        _setMode(SimMode.Navigate)
        setDestination({ lat, lng })
        setProgress(0)
        const res = await api.navigate(lat, lng, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, undefined, straightLine, routeEngine)
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        setEffectiveSpeed({ kmh: customSpeedKmh ?? MODE_DEFAULT_KMH[moveMode], min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err: any) {
        setError(err.message)
        throw err
      }
    },
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseLoop, pauseRandomWalk, straightLine, routeEngine],
  )

  const startLoop = useCallback(
    async (wps: LatLng[]) => {
      setError(null)
      try {
        _setMode(SimMode.Loop)
        // Don't setWaypoints(wps) — wps is the route as sent to the backend
        // (already includes the start position from caller). Overwriting UI
        // waypoints here would prepend the start point on every restart,
        // and break the backend↔UI seg_idx mapping for highlighting.
        setProgress(0)
        setLapProgress(null)
        const res = await api.startLoop(wps, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseLoop.enabled, pause_min: pauseLoop.min, pause_max: pauseLoop.max }, undefined, straightLine, loopLapCount, routeEngine, { jump_mode: jumpMode, jump_pre_delay: jumpPreDelay, jump_post_delay: jumpPostDelay })
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        setEffectiveSpeed({ kmh: customSpeedKmh ?? MODE_DEFAULT_KMH[moveMode], min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err: any) {
        setError(err.message)
        throw err
      }
    },
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseLoop, pauseRandomWalk, straightLine, loopLapCount, routeEngine, jumpMode, jumpPreDelay, jumpPostDelay],
  )

  const multiStop = useCallback(
    async (wps: LatLng[], stopDuration: number, loop: boolean) => {
      setError(null)
      try {
        // 多點導航 is merged into the 路徑 (Loop) mode, so keep the UI mode on
        // Loop — this is just the single-pass backend path for "0 圈".
        _setMode(SimMode.Loop)
        // See startLoop — do not overwrite UI waypoints with the backend route.
        setProgress(0)
        const res = await api.multiStop(wps, moveMode, stopDuration, loop, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseLoop.enabled, pause_min: pauseLoop.min, pause_max: pauseLoop.max }, undefined, straightLine, routeEngine, { jump_mode: jumpMode, jump_pre_delay: jumpPreDelay, jump_post_delay: jumpPostDelay })
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        setEffectiveSpeed({ kmh: customSpeedKmh ?? MODE_DEFAULT_KMH[moveMode], min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err: any) {
        setError(err.message)
        throw err
      }
    },
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseLoop, pauseRandomWalk, straightLine, routeEngine, jumpMode, jumpPreDelay, jumpPostDelay],
  )

  const flower = useCallback(
    async (wps: LatLng[]) => {
      setError(null)
      try {
        _setMode(SimMode.Flower)
        setProgress(0)
        setLapProgress(null)
        const res = await api.flower(wps, moveMode, {
          radius_m: flowerRadius, segments: flowerSegments,
          circles: flowerCircles, rounds: flowerRounds,
          pre_wait: flowerPreWait, post_wait: flowerPostWait,
          teleport: flowerTeleport,
        }, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, undefined, straightLine, routeEngine)
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        setEffectiveSpeed({ kmh: customSpeedKmh ?? MODE_DEFAULT_KMH[moveMode], min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err: any) {
        setError(err.message)
        throw err
      }
    },
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, straightLine, routeEngine, flowerRadius, flowerSegments, flowerCircles, flowerRounds, flowerPreWait, flowerPostWait, flowerTeleport],
  )

  const randomWalk = useCallback(
    async (center: LatLng, radiusM: number) => {
      setError(null)
      try {
        _setMode(SimMode.RandomWalk)
        setProgress(0)
        const res = await api.randomWalk(center, radiusM, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseRandomWalk.enabled, pause_min: pauseRandomWalk.min, pause_max: pauseRandomWalk.max }, undefined, undefined, straightLine, routeEngine, randomWalkCenterMode, forwardWalk)
        setStatus((prev) => ({ ...prev, running: true, paused: false }))
        setEffectiveSpeed({ kmh: customSpeedKmh ?? MODE_DEFAULT_KMH[moveMode], min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err: any) {
        setError(err.message)
        throw err
      }
    },
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseLoop, pauseRandomWalk, straightLine, routeEngine, randomWalkCenterMode, forwardWalk],
  )

  const joystickStart = useCallback(async () => {
    setError(null)
    try {
      _setMode(SimMode.Joystick)
      const res = await api.joystickStart(moveMode)
      setStatus((prev) => ({ ...prev, running: true, paused: false }))
      return res
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [moveMode])

  const joystickStop = useCallback(async () => {
    setError(null)
    try {
      const res = await api.joystickStop()
      // leave mode as-is; status drives running state
      setStatus((prev) => ({ ...prev, running: false, paused: false }))
      return res
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [])

  const pause = useCallback(async () => {
    setError(null)
    try {
      const res = await api.pauseSim()
      setStatus((prev) => ({ ...prev, paused: true }))
      return res
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [])

  const resume = useCallback(async () => {
    setError(null)
    try {
      const res = await api.resumeSim()
      setStatus((prev) => ({ ...prev, paused: false }))
      return res
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [])

  const stop = useCallback(async () => {
    setError(null)
    try {
      const res = await api.stopSim()
      setStatus((prev) => ({ ...prev, running: false, paused: false }))
      setProgress(0)
      setEta(null)
      setRoutePath([])
      setWaypointProgress(null)
      setLapProgress(null)
      // Keep effectiveSpeed so status bar shows last-applied speed after stop/restore.
      // Clear the destination so the red "target" marker goes away —
      // lingering destination pin after Stop was a reported UX bug.
      setDestination(null)
      return res
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [])

  const goldDittoCycle = useCallback(async (lat: number, lng: number) => {
    setError(null)
    try {
      return await api.goldDittoCycle(lat, lng)
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [])

  const restore = useCallback(async () => {
    setError(null)
    try {
      const res = await api.restoreSim()
      // leave mode as-is; status drives running state
      setStatus({ running: false, paused: false, speed: 0 })
      setCurrentPosition(null)
      setDestination(null)
      setProgress(0)
      setEta(null)
      setWaypoints([])
      setRoutePath([])
      setWaypointProgress(null)
      setLapProgress(null)
      // Keep effectiveSpeed so status bar shows last-applied speed after stop/restore.
      return res
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [])

  const applySpeed = useCallback(async () => {
    setError(null)
    try {
      const res = await api.applySpeed(moveMode, {
        speed_kmh: customSpeedKmh,
        speed_min_kmh: speedMinKmh,
        speed_max_kmh: speedMaxKmh,
      })
      // Status bar should now reflect the just-applied values, not the
      // ones the route originally started with.
      setEffectiveSpeed({ kmh: customSpeedKmh ?? MODE_DEFAULT_KMH[moveMode], min: speedMinKmh, max: speedMaxKmh })
      return res
    } catch (err: any) {
      setError(err.message)
      throw err
    }
  }, [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh])

  // Fetch initial status on mount
  const initialFetched = useRef(false)
  useEffect(() => {
    if (initialFetched.current) return
    initialFetched.current = true
    api.getStatus().then((res) => {
      if (res.position) {
        setCurrentPosition({ lat: res.position.lat, lng: res.position.lng })
      }
      if (res.mode) _setMode(res.mode)
      if (res.running != null || res.paused != null) {
        setStatus({
          running: !!res.running,
          paused: !!res.paused,
          speed: res.speed ?? 0,
        })
      }
    }).catch(() => {
      // backend may not be running yet
    })
  }, [])

  // ── Group-mode fan-out helpers ──────────────────────────────────────
  // Each takes an explicit list of udids so the caller (App.tsx) decides
  // which devices to target. Returns a FanoutOutcome for toast summarisation.
  const fanout = useCallback(async <T,>(
    udids: string[],
    action: string,
    fn: (udid: string) => Promise<T>,
  ): Promise<FanoutOutcome<T>> => {
    if (udids.length === 0) {
      setError('No device connected')
      return { ok: [], failed: [] }
    }
    const results = await Promise.allSettled(udids.map((u) => fn(u)))
    return summarizeResults(results, udids, action)
  }, [])

  // Group-mode sync helper: before any action that depends on a common start
  // (navigate / loop / multistop / randomwalk / joystick), teleport every
  // target device to the primary's current position so both phones begin from
  // the same coordinate and follow identical paths.
  const preSyncStart = useCallback(async (udids: string[]) => {
    if (udids.length < 2) return
    const pos = currentPosition
    if (!pos) return
    try {
      await Promise.allSettled(udids.map((u) => api.teleport(pos.lat, pos.lng, u)))
      // Tiny settle delay so devices finalise the teleport before the next
      // command arrives.
      await new Promise((r) => setTimeout(r, 150))
    } catch {
      // Non-fatal: fall through to the primary action.
    }
  }, [currentPosition])

  const teleportAll = useCallback((udids: string[], lat: number, lng: number) =>
    fanout(udids, 'teleport', (u) => api.teleport(lat, lng, u)), [fanout])
  const navigateAll = useCallback(async (udids: string[], lat: number, lng: number) => {
    await preSyncStart(udids)
    return fanout(udids, 'navigate', (u) => api.navigate(lat, lng, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, u, straightLine, routeEngine))
  }, [fanout, preSyncStart, moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, straightLine, routeEngine])
  const startLoopAll = useCallback(async (udids: string[], wps: LatLng[]) => {
    await preSyncStart(udids)
    setLapProgress(null)
    return fanout(udids, 'loop', (u) => api.startLoop(wps, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseLoop.enabled, pause_min: pauseLoop.min, pause_max: pauseLoop.max }, u, straightLine, loopLapCount, routeEngine, { jump_mode: jumpMode, jump_pre_delay: jumpPreDelay, jump_post_delay: jumpPostDelay }))
  }, [fanout, preSyncStart, moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseLoop, straightLine, loopLapCount, routeEngine, jumpMode, jumpPreDelay, jumpPostDelay])
  const multiStopAll = useCallback(async (udids: string[], wps: LatLng[], dur: number, loop: boolean) => {
    await preSyncStart(udids)
    // Single-pass path of the merged 路徑 mode — use the shared pauseLoop setting.
    return fanout(udids, 'multistop', (u) => api.multiStop(wps, moveMode, dur, loop, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseLoop.enabled, pause_min: pauseLoop.min, pause_max: pauseLoop.max }, u, straightLine, routeEngine, { jump_mode: jumpMode, jump_pre_delay: jumpPreDelay, jump_post_delay: jumpPostDelay }))
  }, [fanout, preSyncStart, moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseLoop, straightLine, routeEngine, jumpMode, jumpPreDelay, jumpPostDelay])
  const flowerAll = useCallback(async (udids: string[], wps: LatLng[]) => {
    await preSyncStart(udids)
    setLapProgress(null)
    return fanout(udids, 'flower', (u) => api.flower(wps, moveMode, {
      radius_m: flowerRadius, segments: flowerSegments,
      circles: flowerCircles, rounds: flowerRounds,
      pre_wait: flowerPreWait, post_wait: flowerPostWait,
      teleport: flowerTeleport,
    }, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, u, straightLine, routeEngine))
  }, [fanout, preSyncStart, moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, straightLine, routeEngine, flowerRadius, flowerSegments, flowerCircles, flowerRounds, flowerPreWait, flowerPostWait, flowerTeleport])
  const randomWalkAll = useCallback(async (udids: string[], center: LatLng, r: number) => {
    await preSyncStart(udids)
    // Shared seed → both engines produce identical destination sequences.
    const seed = udids.length >= 2 ? Date.now() : null
    return fanout(udids, 'randomwalk', (u) => api.randomWalk(center, r, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseRandomWalk.enabled, pause_min: pauseRandomWalk.min, pause_max: pauseRandomWalk.max }, u, seed, straightLine, routeEngine, randomWalkCenterMode, forwardWalk))
  }, [fanout, preSyncStart, moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseRandomWalk, straightLine, routeEngine, randomWalkCenterMode, forwardWalk])
  const applySpeedAll = useCallback(async (udids: string[]) => {
    const outcome = await fanout(udids, 'apply-speed', (u) => api.applySpeed(moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, u))
    if (outcome.ok.length > 0) {
      setEffectiveSpeed({ kmh: customSpeedKmh ?? MODE_DEFAULT_KMH[moveMode], min: speedMinKmh, max: speedMaxKmh })
    }
    return outcome
  }, [fanout, moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh])
  const pauseAll = useCallback((udids: string[]) => fanout(udids, 'pause', (u) => api.pauseSim(u)), [fanout])
  const resumeAll = useCallback((udids: string[]) => fanout(udids, 'resume', (u) => api.resumeSim(u)), [fanout])
  const stopAll = useCallback((udids: string[]) => fanout(udids, 'stop', (u) => api.stopSim(u)), [fanout])
  const restoreAll = useCallback(async (udids: string[]) => {
    const outcome = await fanout(udids, 'restore', (u) => api.restoreSim(u))
    // Clear per-device runtime state (markers, routes) and legacy state so
    // the map immediately reflects the wipe without waiting for events.
    setRuntimes((prev) => {
      const next: RuntimesMap = { ...prev }
      for (const u of udids) {
        if (next[u]) {
          next[u] = { ...next[u], currentPos: null, destination: null, routePath: [], progress: 0, eta: 0, distanceRemaining: 0, distanceTraveled: 0, waypointIndex: null, state: 'idle' }
        }
      }
      return next
    })
    setCurrentPosition(null)
    setDestination(null)
    setProgress(0)
    setEta(null)
    setWaypoints([])
    setRoutePath([])
    setWaypointProgress(null)
    setLapProgress(null)
    // Keep effectiveSpeed so status bar shows last-applied speed after restore-all.
    return outcome
  }, [fanout])
  const goldDittoCycleAll = useCallback((udids: string[], lat: number, lng: number) =>
    fanout(udids, 'goldditto', (u) => api.goldDittoCycle(lat, lng, u)), [fanout])
  const joystickStartAll = useCallback(async (udids: string[]) => {
    await preSyncStart(udids)
    return fanout(udids, 'joystick-start', (u) => api.joystickStart(moveMode, u))
  }, [fanout, preSyncStart, moveMode])
  const joystickStopAll = useCallback((udids: string[]) =>
    fanout(udids, 'joystick-stop', (u) => api.joystickStop(u)), [fanout])

  // Derived: primary runtime for legacy single-device components.
  const primaryRuntime: DeviceRuntime | null = (() => {
    const keys = Object.keys(runtimes)
    return keys.length ? runtimes[keys[0]] : null
  })()
  const anyRunning = Object.values(runtimes).some((r) =>
    r.state && r.state !== 'idle' && r.state !== 'disconnected',
  )

  return {
    runtimes,
    primaryRuntime,
    anyRunning,
    teleportAll,
    navigateAll,
    startLoopAll,
    multiStopAll,
    flowerAll,
    randomWalkAll,
    applySpeedAll,
    pauseAll,
    resumeAll,
    stopAll,
    restoreAll,
    joystickStartAll,
    joystickStopAll,
    goldDittoCycle,
    goldDittoCycleAll,
    mode,
    setMode,
    loadRoute,
    moveMode,
    setMoveMode,
    status,
    currentPosition,
    setCurrentPosition,
    destination,
    progress,
    eta,
    waypoints,
    setWaypoints,
    routePath,
    customSpeedKmh,
    setCustomSpeedKmh,
    speedMinKmh,
    setSpeedMinKmh,
    speedMaxKmh,
    setSpeedMaxKmh,
    straightLine,
    setStraightLine,
    keepWaypoints,
    setKeepWaypoints,
    randomWalkCenterMode,
    setRandomWalkCenterMode,
    forwardWalk,
    setForwardWalk,
    randomWalkCenter,
    routeEngine,
    setRouteEngine,
    pauseLoop,
    setPauseLoop,
    pauseRandomWalk,
    setPauseRandomWalk,
    pauseRemaining,
    ddiMounting,
    ddiStage,
    waypointProgress,
    lapProgress,
    loopLapCount,
    setLoopLapCount,
    jumpMode,
    setJumpMode,
    jumpPreDelay,
    setJumpPreDelay,
    jumpPostDelay,
    setJumpPostDelay,
    effectiveSpeed,
    applySpeed,
    error,
    clearError,
    teleport,
    stop,
    navigate,
    startLoop,
    multiStop,
    flower,
    randomWalk,
    flowerRadius,
    setFlowerRadius,
    flowerSegments,
    setFlowerSegments,
    flowerCircles,
    setFlowerCircles,
    flowerRounds,
    setFlowerRounds,
    flowerPreWait,
    setFlowerPreWait,
    flowerPostWait,
    setFlowerPostWait,
    flowerTeleport,
    setFlowerTeleport,
    joystickStart,
    joystickStop,
    pause,
    resume,
    restore,
  }
}
