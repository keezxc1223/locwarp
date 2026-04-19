/**
 * applyWsMessage — pure dispatcher from a backend WS frame to React setters.
 *
 * Extracted from useSimulation so the 130-line switch can be reasoned about
 * (and unit-tested) without dragging in the rest of the hook. The function
 * takes a `WsMessage` plus a bag of setters and performs the right state
 * mutations; it has no side effects beyond calling those setters.
 *
 * Invariants this function relies on:
 *   - All setters are stable (React's useState setters are guaranteed stable).
 *   - Unknown `wsMessage.type` values are ignored, not thrown — the backend
 *     can introduce new event types without crashing older clients.
 */
import type { Dispatch, SetStateAction } from 'react'
import type { WsMessage } from '../hooks/useWebSocket'
import type { LatLng, SimMode, SimulationStatus } from '../hooks/useSimulation'

export interface SimulationStateSetters {
  setCurrentPosition: Dispatch<SetStateAction<LatLng | null>>
  setProgress: Dispatch<SetStateAction<number>>
  setEta: Dispatch<SetStateAction<number | null>>
  setStatus: Dispatch<SetStateAction<SimulationStatus>>
  setMode: Dispatch<SetStateAction<SimMode>>
  setDestination: Dispatch<SetStateAction<LatLng | null>>
  setWaypoints: Dispatch<SetStateAction<LatLng[]>>
  setPauseEndAt: Dispatch<SetStateAction<number | null>>
  setRoutePath: Dispatch<SetStateAction<LatLng[]>>
  setError: Dispatch<SetStateAction<string | null>>
  setDdiMounting: Dispatch<SetStateAction<boolean>>
}

// i18n shortcut — these two messages fire from background threads where we
// don't have the React i18n context. Falling back to localStorage matches the
// existing behavior; keep `'en'` in sync with i18n's language key.
function isEnglish(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem('locwarp.lang') === 'en'
}

export function applyWsMessage(msg: WsMessage, s: SimulationStateSetters): void {
  switch (msg.type) {
    case 'position_update': {
      const { lat, lng } = msg.data
      if (typeof lat === 'number' && typeof lng === 'number') {
        s.setCurrentPosition({ lat, lng })
      }
      if (msg.data.progress != null) {
        s.setProgress(msg.data.progress)
      }
      const etaVal = msg.data.eta_seconds ?? msg.data.eta
      if (etaVal != null) s.setEta(etaVal)

      const dr = msg.data.distance_remaining
      const dt = msg.data.distance_traveled
      // speed_kmh 來自後端 position_update，反映實際執行速度
      const spd = msg.data.speed_kmh != null
        ? Math.round(msg.data.speed_kmh)
        : msg.data.speed_mps != null
          ? Math.round(msg.data.speed_mps * 3.6)
          : null
      if (dr != null || dt != null || spd != null) {
        s.setStatus((prev) => ({
          ...prev,
          ...(dr  != null ? { distance_remaining: dr } : {}),
          ...(dt  != null ? { distance_traveled:  dt } : {}),
          ...(spd != null ? { speed: spd }              : {}),
        }))
      }
      break
    }

    case 'simulation_state': {
      const d = msg.data
      s.setStatus({
        running: !!d.running,
        paused: !!d.paused,
        speed: d.speed ?? 0,
        state: d.state,
        distance_remaining: d.distance_remaining,
        distance_traveled: d.distance_traveled,
      })
      if (d.mode) s.setMode(d.mode)
      if (d.progress != null) s.setProgress(d.progress)
      if (d.eta != null) s.setEta(d.eta)
      if (d.destination) s.setDestination(d.destination)
      if (d.waypoints) s.setWaypoints(d.waypoints)
      break
    }

    case 'simulation_complete': {
      s.setStatus((prev) => ({ ...prev, running: false, paused: false }))
      s.setProgress(1)
      s.setEta(null)
      s.setPauseEndAt(null)
      break
    }

    case 'ddi_mounting': {
      s.setDdiMounting(true)
      break
    }

    case 'ddi_mounted':
    case 'ddi_mount_failed': {
      s.setDdiMounting(false)
      break
    }

    case 'tunnel_lost': {
      s.setError(isEnglish()
        ? 'Wi-Fi tunnel dropped — please reconnect'
        : 'WiFi Tunnel 連線中斷,請重新建立')
      break
    }

    case 'device_disconnected': {
      s.setError(isEnglish()
        ? 'Device disconnected (USB unplugged or tunnel died), please reconnect USB'
        : '裝置連線中斷(USB 拔除或 Tunnel 死亡),請重新插上 USB')
      s.setStatus((prev) => ({ ...prev, running: false, paused: false }))
      break
    }

    case 'device_reconnected': {
      // Auto-reconnected by the usbmux watchdog after a re-plug — clear
      // the banner; the success is already visible via DeviceStatus.
      s.setError(null)
      break
    }

    case 'pause_countdown':
    case 'random_walk_pause': {
      const dur = msg.data?.duration_seconds
      if (typeof dur === 'number' && dur > 0) {
        s.setPauseEndAt(Date.now() + dur * 1000)
      }
      break
    }

    case 'pause_countdown_end':
    case 'random_walk_pause_end': {
      s.setPauseEndAt(null)
      break
    }

    case 'route_path': {
      const pts = msg.data?.coords
      if (Array.isArray(pts)) {
        s.setRoutePath(pts.map((p: any) => ({ lat: p.lat ?? p[0], lng: p.lng ?? p[1] })))
      }
      break
    }

    case 'state_change': {
      const st = msg.data?.state
      if (st === 'idle' || st === 'disconnected') {
        s.setStatus((prev) => ({ ...prev, running: false, paused: false, state: st }))
        s.setRoutePath([])
      } else if (st === 'paused') {
        s.setStatus((prev) => ({ ...prev, paused: true, state: st }))
      } else if (st) {
        s.setStatus((prev) => ({ ...prev, running: true, paused: false, state: st }))
      }
      break
    }

    case 'simulation_error': {
      s.setError(msg.data?.message ?? 'Simulation error')
      break
    }

    // Unknown types are intentionally ignored to allow forward compatibility
    // with backend additions.
  }
}
