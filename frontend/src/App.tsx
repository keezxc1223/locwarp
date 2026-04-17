import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from './i18n'
import { useWebSocket } from './hooks/useWebSocket'
import { useDevice } from './hooks/useDevice'
import { useSimulation } from './hooks/useSimulation'
import { useJoystick } from './hooks/useJoystick'
import { useBookmarks } from './hooks/useBookmarks'
import UserAvatarPicker from './components/UserAvatarPicker'
import { UserAvatar, avatarToHtml, loadAvatar, saveAvatar, loadCustomPng, saveCustomPng } from './userAvatars'
import * as api from './services/api'

import MapView from './components/MapView'
import ControlPanel from './components/ControlPanel'
import DeviceStatus from './components/DeviceStatus'
import JoystickPad from './components/JoystickPad'
import EtaBar from './components/EtaBar'
import PauseControl from './components/PauseControl'
import StatusBar from './components/StatusBar'
import UpdateChecker from './components/UpdateChecker'
import { DeviceChipRow } from './components/DeviceChipRow'
import type { FanoutOutcome } from './hooks/useSimulation'

// Summarise a group fan-out result into a single toast string.
// Call from action handlers: showToast(toastForFanout(t, 'teleport', outcome, connectedDevices))
export function toastForFanout<T>(
  t: (k: any, v?: Record<string, string | number>) => string,
  action: string,
  outcome: FanoutOutcome<T>,
  devices: { udid: string }[],
): string {
  const total = outcome.ok.length + outcome.failed.length
  if (total === 0) return action
  if (outcome.failed.length === 0) return t('group.action_all_success', { action })
  if (outcome.ok.length === 0) return t('group.action_all_failed', { action })
  const statusFor = (udid: string) =>
    outcome.ok.some((o) => o.udid === udid) ? 'OK'
      : outcome.failed.find((f) => f.udid === udid)?.reason ?? 'error'
  return t('group.action_partial', {
    action,
    aStatus: devices[0] ? statusFor(devices[0].udid) : '-',
    bStatus: devices[1] ? statusFor(devices[1].udid) : '-',
  })
}

import { SimMode, MoveMode } from './hooks/useSimulation'

const SPEED_MAP: Record<MoveMode, number> = {
  walking: 5,
  running: 10,
  driving: 40,
}

const App: React.FC = () => {
  const t = useT()
  const ws = useWebSocket()
  const device = useDevice(ws.subscribe)
  // Pass primary-device udid into useSimulation so its legacy single-device
  // setters only react to the primary's WS events in dual-device mode,
  // stopping the map marker from ping-ponging between both devices'
  // independently-jittered positions.
  const sim = useSimulation(ws.subscribe, device.primaryDevice?.udid)
  const joystick = useJoystick(ws.sendMessage, sim.mode === SimMode.Joystick)
  const bm = useBookmarks()

  const [savedRoutes, setSavedRoutes] = useState<any[]>([])
  const [cooldown, setCooldown] = useState(0)
  const [cooldownEnabled, setCooldownEnabled] = useState(false)
  const [randomWalkRadius, setRandomWalkRadius] = useState(500)
  const [clickToAddWaypoint, setClickToAddWaypoint] = useState(false)
  const [showBookmarkPins, setShowBookmarkPinsRaw] = useState<boolean>(() => {
    try { return localStorage.getItem('locwarp.show_bookmark_pins') === '1' } catch { return false }
  })
  const setShowBookmarkPins = (v: boolean) => {
    setShowBookmarkPinsRaw(v)
    try { localStorage.setItem('locwarp.show_bookmark_pins', v ? '1' : '0') } catch { /* ignore */ }
  }
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  // Active avatar selection + persistent custom-PNG slot. Stored in two
  // separate localStorage keys so picking a preset doesn't drop the user's
  // uploaded image.
  const [userAvatar, setUserAvatar] = useState<UserAvatar>(() => loadAvatar())
  const [customPng, setCustomPng] = useState<string | null>(() => loadCustomPng())
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false)
  const handleAvatarSave = useCallback((next: UserAvatar, nextCustom: string | null) => {
    setUserAvatar(next)
    saveAvatar(next)
    setCustomPng(nextCustom)
    saveCustomPng(nextCustom)
  }, [])
  // Reverse-geo-derived state used by the status bar: country-code flag and
  // (later) timezone tag. Populated debounced from sim.currentPosition so we
  // don't hit Nominatim/Photon every position_update tick.
  const [locMeta, setLocMeta] = useState<{
    countryCode: string;
    timezoneZone: string | null;
    gmtOffsetSeconds: number | null;
    // Weather at the current virtual location. Fetched from Open-Meteo when
    // the position moves >=100m and the sim is quiescent (same gate as
    // reverse-geocode + timezone). Null = unknown / not yet fetched.
    weatherCode: number | null;
    tempC: number | null;
  }>({
    countryCode: '', timezoneZone: null, gmtOffsetSeconds: null,
    weatherCode: null, tempC: null,
  })
  // Most recently announced timezone diff so we only toast once per zone
  // change, not on every redundant lookup.
  const lastToastedZoneRef = useRef<string>('')
  // Last position we successfully looked up reverse-geo/timezone for. Used
  // to suppress redundant lookups when jitter nudges the coordinate but the
  // user hasn't actually moved.
  const lastLookedUpPosRef = useRef<{ lat: number; lng: number } | null>(null)

  const showToast = useCallback((msg: string, ms = 2000) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), ms)
  }, [])

  const handleRestore = useCallback(async () => {
    // The backend stop + DVT clear can take a few seconds, especially if
    // movement was active or the channel is flaky. Give the user a visible
    // "working on it" toast up front so the UI doesn't feel frozen.
    showToast(t('status.restore_in_progress'), 10000)
    const startedAt = Date.now()
    try {
      // Group mode: fan out restore to every connected device; fall back to
      // the legacy single-engine restore when no devices are tracked yet.
      const udids = device.connectedDevices.map((d) => d.udid)
      if (udids.length >= 2) {
        const outcome = await sim.restoreAll(udids)
        if (outcome.failed.length > 0 && outcome.ok.length === 0) {
          throw new Error(outcome.failed[0]?.reason ?? 'restore failed')
        }
      } else {
        await sim.restore()
      }
      // Keep the in-progress toast visible for at least 1.2 s — otherwise a
      // fast restore (sub-second) would overwrite it before the user even
      // noticed it appeared.
      const elapsed = Date.now() - startedAt
      if (elapsed < 1200) {
        await new Promise((r) => setTimeout(r, 1200 - elapsed))
      }
      showToast(t('status.restore_success_wait'))
    } catch {
      showToast(t('status.restore_failed'))
    }
  }, [showToast, t, sim, device])
  const [wpGenRadius, setWpGenRadius] = useState(300)
  const [wpGenCount, setWpGenCount] = useState(5)

  const generateWaypoints = useCallback((radius: number, count: number) => {
    if (!sim.currentPosition) {
      alert(t('toast.no_position_random'))
      return
    }
    const { lat, lng } = sim.currentPosition
    const latScale = 111320
    const lngScale = 111320 * Math.cos((lat * Math.PI) / 180)

    type Pt = { lat: number; lng: number; theta?: number }
    const pts: Pt[] = []
    for (let i = 0; i < count; i++) {
      const r = radius * Math.sqrt(Math.random())
      const theta = Math.random() * 2 * Math.PI
      pts.push({
        lat: lat + (r * Math.cos(theta)) / latScale,
        lng: lng + (r * Math.sin(theta)) / lngScale,
        theta,
      })
    }

    // Nearest-neighbor from current position → shorter total path
    const remaining = [...pts]
    const ordered: Pt[] = []
    let cx = lat, cy = lng
    while (remaining.length) {
      let bestIdx = 0, bestD = Infinity
      for (let i = 0; i < remaining.length; i++) {
        const dx = (remaining[i].lat - cx) * latScale
        const dy = (remaining[i].lng - cy) * lngScale
        const d = dx * dx + dy * dy
        if (d < bestD) { bestD = d; bestIdx = i }
      }
      const [next] = remaining.splice(bestIdx, 1)
      ordered.push(next)
      cx = next.lat; cy = next.lng
    }

    // Seed the list with the current position as index 0 so the start button
    // doesn't need to inject it later (and can't double-inject on re-click).
    sim.setWaypoints([
      { lat, lng },
      ...ordered.map(({ lat, lng }) => ({ lat, lng })),
    ])
  }, [sim, t])

  const handleGenerateRandomWaypoints = useCallback(() => {
    generateWaypoints(wpGenRadius, wpGenCount)
  }, [generateWaypoints, wpGenRadius, wpGenCount])

  const handleGenerateAllRandom = useCallback(() => {
    const radius = Math.floor(50 + Math.random() * 950)  // 50–1000 m
    const count = Math.floor(3 + Math.random() * 8)       // 3–10 點
    setWpGenRadius(radius)
    setWpGenCount(count)
    generateWaypoints(radius, count)
  }, [generateWaypoints])

  const handleToggleCooldown = useCallback((enabled: boolean) => {
    setCooldownEnabled(enabled)
    api.setCooldownEnabled(enabled).catch(() => setCooldownEnabled((v) => !v))
  }, [])

  // Load saved routes on mount
  useEffect(() => {
    api.getSavedRoutes().then(setSavedRoutes).catch(() => {})
  }, [])


  // Reverse-geocode + timezone lookup, tied to the current virtual location
  // but GATED so it only fires on discrete user-initiated moves (teleport,
  // bookmark tap, manual coord entry). During active navigate / loop /
  // multi-stop / random-walk the simulation engine emits a position update
  // every tick, which used to spam Nominatim + TimezoneDB every second and
  // contend with the USB DVT channel — contributed to users seeing random
  // walk 'freeze' (see backend log 2026-04-16 user report).
  //
  // Rule: only look up when the sim state is idle / teleporting / disconnected
  // (i.e. no route animation in flight), AND the position actually moved
  // >=100m from the last looked-up point.
  useEffect(() => {
    const pos = sim.currentPosition
    if (!pos) return
    const state = sim.status?.state ?? 'idle'
    const isQuiescent = state === 'idle' || state === 'teleporting' || state === 'disconnected'
    if (!isQuiescent) return
    // Skip redundant lookups when the user stays at the same spot (jitter
    // within 100m of the last resolved position).
    const last = lastLookedUpPosRef.current
    if (last) {
      const dLat = (pos.lat - last.lat) * 111320
      const dLng = (pos.lng - last.lng) * 111320 * Math.cos(pos.lat * Math.PI / 180)
      if (dLat * dLat + dLng * dLng < 100 * 100) return
    }
    let cancelled = false
    const tid = setTimeout(async () => {
      lastLookedUpPosRef.current = { lat: pos.lat, lng: pos.lng }
      try {
        const geo = await api.reverseGeocode(pos.lat, pos.lng)
        if (cancelled) return
        const cc = String(geo?.country_code ?? '').toLowerCase()
        setLocMeta((prev) => prev.countryCode === cc ? prev : { ...prev, countryCode: cc })
      } catch { /* offline / rate-limited — keep previous */ }
      try {
        const tz = await api.lookupTimezone(pos.lat, pos.lng)
        if (cancelled || !tz) return
        setLocMeta((prev) => ({ ...prev, timezoneZone: tz.zone, gmtOffsetSeconds: tz.gmt_offset_seconds }))
        // Compare against the user's local timezone offset. JS's
        // getTimezoneOffset returns minutes with INVERTED sign (UTC+8 → -480),
        // so negate it and convert to seconds before comparing.
        const localOffsetSec = -new Date().getTimezoneOffset() * 60
        const diffSec = Math.abs(tz.gmt_offset_seconds - localOffsetSec)
        if (diffSec >= 3600 && lastToastedZoneRef.current !== tz.zone) {
          lastToastedZoneRef.current = tz.zone
          const diffH = Math.round(diffSec / 3600)
          // Show the destination's current wall time for context.
          const destNow = new Date(tz.timestamp * 1000)
          const hh = String(destNow.getUTCHours()).padStart(2, '0')
          const mm = String(destNow.getUTCMinutes()).padStart(2, '0')
          // Localize the zone name via Intl so 'America/New_York' becomes
          // '北美東部夏令時間' for zh users / 'Eastern Daylight Time' for en.
          // Fall back to the raw IANA id if the runtime can't resolve it.
          let zoneLabel = tz.zone
          try {
            const lang = (typeof localStorage !== 'undefined' && localStorage.getItem('locwarp.lang') === 'en') ? 'en' : 'zh-TW'
            const parts = new Intl.DateTimeFormat(lang, { timeZone: tz.zone, timeZoneName: 'long' }).formatToParts(destNow)
            const named = parts.find((p) => p.type === 'timeZoneName')?.value
            if (named) zoneLabel = named
          } catch { /* keep IANA id */ }
          showToast(t('toast.timezone_diff').replace('{zone}', zoneLabel).replace('{hours}', String(diffH)).replace('{time}', `${hh}:${mm}`))
        }
      } catch { /* ignore */ }
      try {
        const wx = await api.lookupWeather(pos.lat, pos.lng)
        if (cancelled || !wx) return
        setLocMeta((prev) => prev.weatherCode === wx.code && prev.tempC === wx.tempC
          ? prev
          : { ...prev, weatherCode: wx.code, tempC: wx.tempC })
      } catch { /* ignore */ }
    }, 600)
    return () => { cancelled = true; clearTimeout(tid) }
  }, [sim.currentPosition?.lat, sim.currentPosition?.lng, sim.status?.state])

  // Auto-scan devices when WebSocket (re)connects (e.g. after backend restart)
  useEffect(() => {
    if (ws.connected) {
      device.scan()
    }
  }, [ws.connected])

  // Poll cooldown
  useEffect(() => {
    if (!ws.connected) return
    const id = setInterval(() => {
      api.getCooldownStatus().then((s: any) => {
        setCooldown(s.remaining_seconds ?? 0)
        if (typeof s.enabled === 'boolean') setCooldownEnabled(s.enabled)
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(id)
  }, [ws.connected])

  // -- Map handlers --
  const handleMapClick = useCallback((lat: number, lng: number) => {
    // When the "left-click to add waypoint" toggle is on AND we're in a
    // waypoint-based mode, append to the waypoint list. Otherwise a map
    // click is a no-op (teleport / navigate live on right-click menu).
    if (!clickToAddWaypoint) return
    if (sim.mode !== SimMode.Loop && sim.mode !== SimMode.MultiStop) return
    const nlat = clampLat(lat)
    const nlng = normalizeLng(lng)
    sim.setWaypoints((prev: any[]) => {
      if (prev.length === 0 && sim.currentPosition) {
        return [
          { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng },
          { lat: nlat, lng: nlng },
        ]
      }
      return [...prev, { lat: nlat, lng: nlng }]
    })
  }, [clickToAddWaypoint, sim])

  // Leaflet wraps the world horizontally at very low zoom levels; clicking on
  // a "second copy" of a country yields lng outside [-180, 180]. Backend's
  // pydantic TeleportRequest bounds lng to [-180, 180] so the raw click
  // would 422. Normalize at the handler entry so every downstream call sees
  // a single canonical coordinate.
  const normalizeLng = (lng: number): number => {
    const n = ((lng + 180) % 360 + 360) % 360 - 180
    // ((180 + 180) % 360 + 360) % 360 - 180 == -180, but 180 is also valid.
    // Keep +180 if the input was exactly +180.
    return lng === 180 ? 180 : n
  }
  const clampLat = (lat: number): number => Math.max(-90, Math.min(90, lat))

  const handleTeleport = useCallback(async (latIn: number, lngIn: number) => {
    const lat = clampLat(latIn)
    const lng = normalizeLng(lngIn)
    const udids = device.connectedDevices.map((d) => d.udid)
    if (udids.length >= 2) {
      // Pre-set the map's tracked position so pan-to-current fires immediately,
      // without waiting for the backend position_update event to arrive.
      sim.setCurrentPosition({ lat, lng })
      const outcome = await sim.teleportAll(udids, lat, lng)
      showToast(toastForFanout(t, t('mode.teleport'), outcome, device.connectedDevices))
    } else {
      sim.teleport(lat, lng)
    }
  }, [sim, device, t, showToast])

  const mapApiRef = useRef<{ panTo: (lat: number, lng: number, zoom?: number) => void } | null>(null)
  const handleMapPanOnly = useCallback((lat: number, lng: number) => {
    mapApiRef.current?.panTo(clampLat(lat), normalizeLng(lng))
  }, [])

  const handleNavigate = useCallback(async (latIn: number, lngIn: number) => {
    const lat = clampLat(latIn)
    const lng = normalizeLng(lngIn)
    const udids = device.connectedDevices.map((d) => d.udid)
    if (udids.length >= 2) {
      const outcome = await sim.navigateAll(udids, lat, lng)
      showToast(toastForFanout(t, t('mode.navigate'), outcome, device.connectedDevices))
    } else {
      sim.navigate(lat, lng)
    }
  }, [sim, device, t, showToast])

  const [addBmDialog, setAddBmDialog] = useState<{
    lat: number; lng: number; name: string; category: string;
    countryCode?: string; nameResolving?: boolean;
  } | null>(null)

  const handleAddBookmark = useCallback((lat: number, lng: number) => {
    setAddBmDialog({
      lat,
      lng,
      name: '',
      category: bm.categories[0]?.name || t('bm.default'),
      nameResolving: true,
    })
    // Reverse-geocode asynchronously to pre-fill the name + remember country.
    // User can still overwrite the suggestion. If the call fails we just leave
    // the field blank as before.
    ;(async () => {
      try {
        const geo = await api.reverseGeocode(lat, lng)
        if (!geo) {
          setAddBmDialog((prev) => prev ? { ...prev, nameResolving: false } : prev)
          return
        }
        const cc = String(geo.country_code ?? '').toLowerCase()
        // Backend now returns a clean `short_name` picked from POI / road /
        // area tags (ignoring noisy house-number leading segments like "6").
        // Fall back to first display_name segment only if short_name absent.
        const short = String(geo.short_name || '').trim()
          || String(geo.display_name || '').split(',')[0]?.trim()
          || ''
        setAddBmDialog((prev) => {
          if (!prev) return prev
          // Don't overwrite anything the user already typed.
          if (prev.name && prev.name.length > 0) {
            return { ...prev, countryCode: cc, nameResolving: false }
          }
          return { ...prev, name: short, countryCode: cc, nameResolving: false }
        })
      } catch {
        setAddBmDialog((prev) => prev ? { ...prev, nameResolving: false } : prev)
      }
    })()
  }, [bm.categories, t])

  const submitAddBookmark = useCallback(() => {
    if (!addBmDialog || !addBmDialog.name.trim()) return
    const cat = bm.categories.find(c => c.name === addBmDialog.category)
    bm.createBookmark({
      name: addBmDialog.name.trim(),
      lat: addBmDialog.lat,
      lng: addBmDialog.lng,
      category_id: cat?.id || 'default',
      country_code: addBmDialog.countryCode || '',
    } as any)
    setAddBmDialog(null)
  }, [addBmDialog, bm])

  const handleAddWaypoint = useCallback((lat: number, lng: number) => {
    // Seed the list with the current device position as the implicit start
    // point on the first add. This keeps backend route and UI list aligned
    // so waypoint-progress highlighting indexes correctly, and removes the
    // "start button injects current pos every click" footgun.
    const nlat = clampLat(lat)
    const nlng = normalizeLng(lng)
    sim.setWaypoints((prev: any[]) => {
      if (prev.length === 0 && sim.currentPosition) {
        return [
          { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng },
          { lat: nlat, lng: nlng },
        ]
      }
      return [...prev, { lat: nlat, lng: nlng }]
    })
  }, [sim])

  const handleClearWaypoints = useCallback(() => {
    sim.setWaypoints([])
  }, [sim])

  const handleRemoveWaypoint = useCallback((index: number) => {
    sim.setWaypoints((prev: any[]) => prev.filter((_: any, i: number) => i !== index))
  }, [sim])

  const handleStartWaypointRoute = useCallback(async () => {
    // UI waypoint list already includes the current position as index 0
    // (see handleAddWaypoint / generateWaypoints), so just hand it straight
    // to the backend. No more prepend-on-start, no more accidental re-inject
    // on repeated clicks.
    const route = sim.waypoints
    if (route.length < 2) {
      showToast(t('toast.no_waypoints'))
      return
    }
    const udids = device.connectedDevices.map((d) => d.udid)
    if (sim.mode === SimMode.Loop) {
      if (udids.length >= 2) {
        const outcome = await sim.startLoopAll(udids, route)
        showToast(toastForFanout(t, t('mode.loop'), outcome, device.connectedDevices))
      } else {
        sim.startLoop(route)
      }
    } else if (sim.mode === SimMode.MultiStop) {
      if (udids.length >= 2) {
        const outcome = await sim.multiStopAll(udids, route, 0, false)
        showToast(toastForFanout(t, t('mode.multi_stop'), outcome, device.connectedDevices))
      } else {
        sim.multiStop(route, 0, false)
      }
    }
  }, [sim, device, showToast, t])

  // -- ControlPanel handlers --
  const handleStart = useCallback(async () => {
    const udids = device.connectedDevices.map((d) => d.udid)
    if (sim.mode === SimMode.Joystick) {
      if (udids.length >= 2) {
        const outcome = await sim.joystickStartAll(udids)
        showToast(toastForFanout(t, t('mode.joystick'), outcome, device.connectedDevices))
      } else {
        sim.joystickStart()
      }
    } else if (sim.mode === SimMode.RandomWalk) {
      if (!sim.currentPosition) {
        showToast(t('toast.no_position_random'))
        return
      }
      if (udids.length >= 2) {
        const outcome = await sim.randomWalkAll(udids, sim.currentPosition, randomWalkRadius)
        showToast(toastForFanout(t, t('mode.random_walk'), outcome, device.connectedDevices))
      } else {
        sim.randomWalk(sim.currentPosition, randomWalkRadius)
      }
    } else if (sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop) {
      handleStartWaypointRoute()
    }
  }, [sim, device, randomWalkRadius, handleStartWaypointRoute, showToast, t])

  const handleStop = useCallback(async () => {
    // Stop the active movement only — keep the simulated location in place
    // so the device stays where the user paused it. Use the 一鍵還原 button
    // separately to clear the simulated location and restore real GPS.
    const udids = device.connectedDevices.map((d) => d.udid)
    if (sim.mode === SimMode.Joystick && udids.length >= 2) {
      const outcome = await sim.joystickStopAll(udids)
      showToast(toastForFanout(t, t('mode.joystick'), outcome, device.connectedDevices))
      return
    }
    if (udids.length >= 2) {
      const outcome = await sim.stopAll(udids)
      showToast(toastForFanout(t, 'stop', outcome, device.connectedDevices))
    } else {
      sim.stop()
    }
  }, [sim, device, t, showToast])

  const handleRouteLoad = useCallback((id: string) => {
    const route = savedRoutes.find((r) => r.id === id)
    if (!route || !Array.isArray(route.waypoints)) return
    sim.setWaypoints(route.waypoints.map((w: any) => ({ lat: w.lat, lng: w.lng })))
  }, [savedRoutes, sim])

  const handleRouteSave = useCallback(async (name: string) => {
    if (sim.waypoints.length === 0) {
      showToast(t('toast.route_need_waypoint'))
      return
    }
    try {
      await api.saveRoute({ name, waypoints: sim.waypoints, profile: sim.moveMode })
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.route_saved', { name }))
    } catch (err: any) {
      showToast(t('toast.route_save_failed', { msg: err.message || '' }))
    }
  }, [sim, showToast])

  const handleGpxImport = useCallback(async (file: File) => {
    try {
      const res = await api.importGpx(file)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.gpx_imported', { n: res.points }))
    } catch (err: any) {
      showToast(t('toast.gpx_import_failed', { msg: err.message || '' }))
    }
  }, [showToast])

  const handleGpxExport = useCallback((id: string) => {
    const url = api.exportGpxUrl(id)
    window.open(url, '_blank')
  }, [])

  const handleRoutesImportAll = useCallback(async (file: File) => {
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (!Array.isArray(data?.routes)) {
        throw new Error('invalid file: missing routes array')
      }
      const res = await api.importAllRoutes({ routes: data.routes })
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.routes_imported', { n: res.imported }))
    } catch (err: any) {
      showToast(t('toast.routes_import_failed', { msg: err.message || '' }))
    }
  }, [showToast])

  const handleApplySpeed = useCallback(async () => {
    const udids = device.connectedDevices.map((d) => d.udid)
    try {
      if (udids.length >= 2) {
        const outcome = await sim.applySpeedAll(udids)
        showToast(toastForFanout(t, t('panel.apply_speed_success'), outcome, device.connectedDevices))
      } else {
        await sim.applySpeed()
        showToast(t('panel.apply_speed_success'))
      }
    } catch (err: any) {
      showToast(t('panel.apply_speed_failed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [sim, device, showToast, t])

  const handlePause = useCallback(async () => {
    const udids = device.connectedDevices.map((d) => d.udid)
    if (udids.length >= 2) {
      const outcome = await sim.pauseAll(udids)
      showToast(toastForFanout(t, 'pause', outcome, device.connectedDevices))
    } else {
      sim.pause()
    }
  }, [sim, device, t, showToast])

  const handleResume = useCallback(async () => {
    const udids = device.connectedDevices.map((d) => d.udid)
    if (udids.length >= 2) {
      const outcome = await sim.resumeAll(udids)
      showToast(toastForFanout(t, 'resume', outcome, device.connectedDevices))
    } else {
      sim.resume()
    }
  }, [sim, device, t, showToast])

  const handleOpenLog = useCallback(async () => {
    try {
      // Open the folder, not the file — log can be large and copy/paste
      // from a multi-MB Notepad window is painful. Folder lets the user
      // attach the file directly to the Issue.
      await api.openLogFolder()
    } catch (err: any) {
      showToast(t('status.open_log_failed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [showToast, t])

  const handleBookmarkImport = useCallback(async (file: File) => {
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const res = await api.importBookmarks(data)
      await bm.refresh()
      showToast(t('bm.import_success', { n: res.imported }))
    } catch (err: any) {
      showToast(t('bm.import_failed', { error: err?.message || 'unknown' }))
    }
  }, [bm, showToast, t])

  const handleRouteRename = useCallback(async (id: string, name: string) => {
    try {
      await api.renameRoute(id, name)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
    } catch (err: any) {
      showToast(err.message || t('toast.route_rename_failed'))
    }
  }, [showToast])

  const handleRouteDelete = useCallback(async (id: string) => {
    try {
      await api.deleteRoute(id)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.route_deleted'))
    } catch (err: any) {
      showToast(err.message || t('toast.route_delete_failed'))
    }
  }, [showToast])

  // Build props for components
  const currentPos = sim.currentPosition
    ? { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng }
    : null

  const destPos = sim.destination
    ? { lat: sim.destination.lat, lng: sim.destination.lng }
    : null

  const speed = SPEED_MAP[sim.moveMode] || 5
  // Status-bar display: when a route is running, show what the backend is
  // *actually* executing (set when the route starts or applySpeed succeeds);
  // otherwise show the typed inputs as a preview.
  const fmtSpeedFromInputs = (kmh: number | null, lo: number | null, hi: number | null): number | string => {
    if (lo != null && hi != null) return `${Math.min(lo, hi)}~${Math.max(lo, hi)}`
    if (kmh != null) return kmh
    return speed
  }
  const displaySpeed: number | string = sim.status.running && sim.effectiveSpeed
    ? fmtSpeedFromInputs(sim.effectiveSpeed.kmh, sim.effectiveSpeed.min, sim.effectiveSpeed.max)
    : fmtSpeedFromInputs(sim.customSpeedKmh, sim.speedMinKmh, sim.speedMaxKmh)

  // Determine running/paused state from status
  const isRunning = sim.status.running
  const isPaused = sim.status.paused

  return (
    <div className="app-layout">
      <div className="noise-overlay" aria-hidden />
      <div className="sidebar">
        <div className="sidebar-content">
        <DeviceChipRow
          devices={device.connectedDevices}
          runtimes={sim.runtimes}
          onAdd={() => {
            if (device.connectedDevices.length >= 2) {
              setToastMsg(t('device.max_reached'))
              return
            }
            device.scan()
          }}
          onDisconnect={(udid) => { device.disconnect(udid) }}
          onRestoreOne={async (udid) => {
            try {
              await api.restoreSim(udid)
              setToastMsg(t('status.restore_success'))
            } catch (e: any) {
              setToastMsg(e?.message ?? 'restore failed')
            }
          }}
        />
        <DeviceStatus
          device={device.connectedDevice ? {
            id: device.connectedDevice.udid,
            name: device.connectedDevice.name,
            iosVersion: device.connectedDevice.ios_version,
            connectionType: device.connectedDevice.connection_type,
          } : null}
          devices={device.devices.map(d => ({
            id: d.udid,
            name: d.name,
            iosVersion: d.ios_version,
            connectionType: d.connection_type,
          }))}
          isConnected={device.connectedDevice !== null}
          onScan={() => { device.scan() }}
          onSelect={(id: string) => { device.connect(id) }}
          onStartWifiTunnel={device.startWifiTunnel}
          onStopTunnel={device.stopTunnel}
          tunnelStatus={device.tunnelStatus}
        />
        <ControlPanel
          simMode={sim.mode}
          moveMode={sim.moveMode}
          speed={speed}
          isRunning={isRunning}
          isPaused={isPaused}
          currentPosition={currentPos}
          onModeChange={sim.setMode}
          onSpeedChange={(s: number) => {
            if (s <= 5) sim.setMoveMode(MoveMode.Walking)
            else if (s <= 10) sim.setMoveMode(MoveMode.Running)
            else sim.setMoveMode(MoveMode.Driving)
          }}
          onMoveModeChange={sim.setMoveMode}
          customSpeedKmh={sim.customSpeedKmh}
          onCustomSpeedChange={sim.setCustomSpeedKmh}
          speedMinKmh={sim.speedMinKmh}
          onSpeedMinChange={sim.setSpeedMinKmh}
          speedMaxKmh={sim.speedMaxKmh}
          onSpeedMaxChange={sim.setSpeedMaxKmh}
          onStart={handleStart}
          onStop={handleStop}
          onPause={handlePause}
          onResume={handleResume}
          onRestore={handleRestore}
          onApplySpeed={handleApplySpeed}
          waypointProgress={sim.waypointProgress}
          onTeleport={handleTeleport}
          onNavigate={handleNavigate}
          bookmarks={bm.bookmarks.map((b: any) => ({
            id: b.id,
            name: b.name,
            lat: b.lat,
            lng: b.lng,
            category: bm.categories.find(c => c.id === b.category_id)?.name || t('bm.default'),
            country_code: b.country_code || '',
            created_at: b.created_at || '',
            last_used_at: b.last_used_at || '',
          }))}
          bookmarkCategories={bm.categories.map(c => c.name)}
          bookmarkCategoryColors={Object.fromEntries(bm.categories.map(c => [c.name, c.color || '']))}
          onBookmarkClick={(b: any) => handleTeleport(b.lat, b.lng)}
          onBookmarkAdd={(b: any) => {
            const cat = bm.categories.find(c => c.name === b.category)
            // Reverse-geocode first so custom-coordinate bookmarks also get a
            // country flag. If lookup fails or takes too long, save without
            // one so the user isn't blocked.
            ;(async () => {
              let cc = ''
              try {
                const geo = await Promise.race([
                  api.reverseGeocode(b.lat, b.lng),
                  new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
                ])
                if (geo && (geo as any).country_code) {
                  cc = String((geo as any).country_code).toLowerCase()
                }
              } catch { /* ignore */ }
              bm.createBookmark({
                name: b.name,
                lat: b.lat,
                lng: b.lng,
                category_id: cat?.id || 'default',
                country_code: cc,
              } as any)
            })()
          }}
          onBookmarkDelete={(id: string) => bm.deleteBookmark(id)}
          onBookmarkEdit={(id: string, data: any) => {
            // BookmarkList emits UI-shape patches ({name}, or {name,lat,lng,category}).
            // Backend PUT /api/bookmarks requires the full Bookmark schema with
            // category_id (not category name), so merge the patch onto the
            // original and translate category name -> id before sending.
            //
            // If orig is missing (bm.bookmarks briefly out of sync with a
            // background refresh), fall back to the patch data — the edit
            // dialog supplies a full bookmark via spread so we still have the
            // fields we need. This prevents the silent-noop save the user saw
            // after running Fix Flags.
            const orig = bm.bookmarks.find(b => b.id === id)
            const base: any = orig ? { ...orig } : { ...data, id }
            const patch: any = base
            if (data.name != null) patch.name = data.name
            if (data.lat != null) patch.lat = data.lat
            if (data.lng != null) patch.lng = data.lng
            if (data.category != null) {
              const cat = bm.categories.find(c => c.name === data.category)
              if (cat) patch.category_id = cat.id
            }
            // Flag-backfill-on-save: trigger reverse-geocode whenever we'd
            // benefit from a fresh country_code — i.e. coords moved (stale),
            // OR the bookmark never had a flag to begin with (legacy entry
            // from before the feature shipped). Runs in the background so
            // the save itself feels instant.
            const refLat = orig ? orig.lat : base.lat
            const refLng = orig ? orig.lng : base.lng
            const coordsChanged =
              (data.lat != null && data.lat !== refLat) ||
              (data.lng != null && data.lng !== refLng)
            const flagMissing = !base.country_code
            const needsGeocode = coordsChanged || flagMissing
            if (coordsChanged) {
              // Coordinates moved — clear the stale flag so UI doesn't show
              // the wrong country while the async lookup is in flight.
              patch.country_code = ''
            }
            if (needsGeocode) {
              ;(async () => {
                try {
                  const geo = await Promise.race([
                    api.reverseGeocode(patch.lat, patch.lng),
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
                  ])
                  const cc = geo && (geo as any).country_code
                    ? String((geo as any).country_code).toLowerCase()
                    : ''
                  if (cc) {
                    await bm.updateBookmark(id, { ...patch, country_code: cc } as any)
                  }
                } catch { /* ignore */ }
              })()
            }
            bm.updateBookmark(id, patch)
          }}
          onCategoryAdd={(name: string) => {
            // Pick a random preset color at creation so different categories
            // start visually distinct; the color is persisted and stays put
            // across rename (was previously hashed from name → jumped on rename).
            const palette = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b']
            const color = palette[Math.floor(Math.random() * palette.length)]
            bm.createCategory({ name, color })
          }}
          onCategoryDelete={(name: string) => {
            const cat = bm.categories.find(c => c.name === name)
            if (cat) bm.deleteCategory(cat.id)
          }}
          onCategoryRename={(oldName: string, newName: string) => {
            const cat = bm.categories.find(c => c.name === oldName)
            if (!cat) return
            // Default category is immutable (UI also hides the rename button
            // for it, but guard here too in case a stale UI ref slips past).
            if (cat.id === 'default') return
            // Backend PUT requires the full BookmarkCategory shape, keep color.
            bm.updateCategory(cat.id, { ...cat, name: newName })
          }}
          onCategoryRecolor={(name: string, color: string) => {
            const cat = bm.categories.find(c => c.name === name)
            if (!cat) return
            bm.updateCategory(cat.id, { ...cat, color })
          }}
          bookmarkShowOnMap={showBookmarkPins}
          onBookmarkShowOnMapChange={setShowBookmarkPins}
          onBookmarkImport={handleBookmarkImport}
          bookmarkExportUrl={api.bookmarksExportUrl()}
          savedRoutes={savedRoutes.map(r => ({ id: r.id, name: r.name, waypoints: r.waypoints ?? [] }))}
          onRouteGpxImport={handleGpxImport}
          onRouteGpxExport={handleGpxExport}
          onRoutesImportAll={handleRoutesImportAll}
          routesExportAllUrl={api.exportAllRoutesUrl()}
          onRouteRename={handleRouteRename}
          onRouteDelete={handleRouteDelete}
          onRouteLoad={handleRouteLoad}
          onRouteSave={handleRouteSave}
          randomWalkRadius={randomWalkRadius}
          pauseRandomWalk={sim.pauseRandomWalk}
          onPauseRandomWalkChange={sim.setPauseRandomWalk}
          onRandomWalkRadiusChange={setRandomWalkRadius}
          currentWaypointsCount={sim.waypoints.length}
          straightLine={sim.straightLine}
          onStraightLineChange={sim.setStraightLine}
          clickToAddWaypoint={clickToAddWaypoint}
          onClickToAddWaypointChange={setClickToAddWaypoint}
          modeExtraSection={(sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop) ? (
          <div className="section" style={{ margin: '0 0 8px 0' }}>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <line x1="12" y1="5" x2="12" y2="1" />
                <line x1="12" y1="23" x2="12" y2="19" />
              </svg>
              {t('panel.waypoints')} ({sim.waypoints.length})
              <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>{t('panel.waypoints_hint')}</span>
            </div>
            <div className="section-content">
              <PauseControl
                labelKey={sim.mode === SimMode.Loop ? 'pause.loop' : 'pause.multi_stop'}
                value={sim.mode === SimMode.Loop ? sim.pauseLoop : sim.pauseMultiStop}
                onChange={sim.mode === SimMode.Loop ? sim.setPauseLoop : sim.setPauseMultiStop}
              />
              <div style={{ marginBottom: 6, fontSize: 11 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ opacity: 0.7, width: 36 }}>{t('panel.waypoints_radius')}</span>
                  <input
                    type="number"
                    min={10}
                    value={wpGenRadius}
                    onChange={(e) => setWpGenRadius(Math.max(1, parseInt(e.target.value) || 0))}
                    style={{ flex: 1, padding: '2px 4px', fontSize: 11 }}
                  />
                  <span style={{ opacity: 0.5, width: 16 }}>m</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ opacity: 0.7, width: 36 }}>{t('panel.waypoints_count')}</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={wpGenCount}
                    onChange={(e) => setWpGenCount(Math.max(1, parseInt(e.target.value) || 0))}
                    style={{ flex: 1, padding: '2px 4px', fontSize: 11 }}
                  />
                  <span style={{ opacity: 0.5, width: 16 }}>{t('panel.points')}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="action-btn"
                    style={{ flex: 1, padding: '3px 8px', fontSize: 11 }}
                    onClick={handleGenerateRandomWaypoints}
                    title={t('panel.waypoints_gen_tooltip')}
                  >{t('panel.waypoints_generate')}</button>
                  <button
                    className="action-btn"
                    style={{ flex: 1, padding: '3px 8px', fontSize: 11 }}
                    onClick={handleGenerateAllRandom}
                    title={t('panel.waypoints_gen_all_tooltip')}
                  >{t('panel.waypoints_generate_all')}</button>
                </div>
              </div>
              {sim.waypoints.length === 0 && (
                <div style={{ fontSize: 12, opacity: 0.5, padding: '4px 0' }}>
                  {t('panel.waypoints_empty')}
                </div>
              )}
              {sim.waypoints.map((wp: any, i: number) => {
                // UI waypoints[0] = the implicit start position (current
                // device location at add-time). Backend seg_idx N = traveling
                // from waypoints[N] toward waypoints[N+1]; the *target* of
                // that segment is waypoints[N+1], so highlight i == seg+1.
                const seg = sim.waypointProgress?.current
                const approaching = seg != null && i === seg + 1
                const passed = seg != null && i <= seg
                const isStart = i === 0;
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', fontSize: 12,
                      borderRadius: 4, marginBottom: 2,
                      background: approaching ? 'rgba(255, 152, 0, 0.18)' : 'transparent',
                      border: approaching ? '1px solid rgba(255, 152, 0, 0.6)' : '1px solid transparent',
                      opacity: passed ? 0.4 : 1,
                      transition: 'background 0.25s, border-color 0.25s',
                      animation: approaching ? 'wp-pulse 1.4s ease-in-out infinite' : undefined,
                    }}
                  >
                    <span style={{ color: approaching ? '#ff9800' : passed ? '#666' : isStart ? '#4caf50' : '#ff9800', fontWeight: 600, width: 24, fontSize: isStart ? 10 : undefined }}>
                      {approaching ? '>' : passed ? 'OK' : isStart ? t('panel.waypoint_start') : `#${i}`}
                    </span>
                    <span style={{ flex: 1, opacity: 0.85 }}>{wp.lat.toFixed(5)}, {wp.lng.toFixed(5)}</span>
                    <button
                      className="action-btn"
                      style={{ padding: '2px 6px', fontSize: 10 }}
                      onClick={() => handleRemoveWaypoint(i)}
                      title={t('panel.waypoints_remove')}
                    >X</button>
                  </div>
                );
              })}
              {sim.waypoints.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    className="action-btn"
                    style={{ flex: 1 }}
                    onClick={handleClearWaypoints}
                    disabled={sim.status?.running}
                  >{t('generic.clear')}</button>
                  {sim.waypoints.length >= 3 && (
                    <button
                      className="action-btn"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        try {
                          const res = await api.routeOptimize(
                            sim.waypoints.map((w: any) => ({ lat: w.lat, lng: w.lng })),
                            'foot', true,
                          )
                          if (res?.waypoints?.length) {
                            sim.setWaypoints(res.waypoints)
                            showToast(t('toast.route_optimized').replace('{min}', String(Math.round(res.total_duration_s / 60))))
                          }
                        } catch (err: any) {
                          showToast(err?.message || t('toast.route_optimize_failed'))
                        }
                      }}
                      disabled={sim.status?.running}
                      title={t('panel.waypoints_optimize_tooltip')}
                    >{t('panel.waypoints_optimize')}</button>
                  )}
                </div>
              )}
            </div>
          </div>
          ) : null}
        />

        </div>
      </div>
      <div className="map-container">
        <EtaBar
          runtimes={sim.runtimes}
          state={sim.status?.state ?? 'idle'}
          progress={sim.progress}
          remainingDistance={sim.status?.distance_remaining ?? 0}
          traveledDistance={sim.status?.distance_traveled ?? 0}
          eta={sim.eta ?? 0}
        />
        {sim.ddiMounting && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10000,
              background: 'rgba(20, 22, 32, 0.85)',
              backdropFilter: 'blur(3px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'auto',
            }}
          >
            <div
              style={{
                background: '#23232a',
                border: '1px solid #3a3a42',
                borderRadius: 8,
                padding: '20px 28px',
                maxWidth: 420,
                textAlign: 'center',
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              }}
            >
              <svg
                width="32" height="32" viewBox="0 0 24 24" fill="none"
                stroke="#6c8cff" strokeWidth="2"
                style={{ animation: 'spin 1s linear infinite', margin: '0 auto 10px' }}
              >
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="16" />
              </svg>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                {t('ddi.mounting_title')}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
                {t('ddi.mounting_hint')}
              </div>
            </div>
          </div>
        )}
        {sim.pauseRemaining != null && sim.pauseRemaining > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 38,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 901,
              background: 'rgba(255, 152, 0, 0.95)',
              color: '#1a1a1a',
              padding: '6px 14px',
              borderRadius: 18,
              fontSize: 12,
              fontWeight: 600,
              boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
            {t('toast.pause_countdown', { n: sim.pauseRemaining })}
          </div>
        )}
        <MapView
          runtimes={sim.runtimes}
          devices={device.connectedDevices}
          currentPosition={currentPos}
          destination={destPos}
          waypoints={sim.waypoints.map((w, i) => ({ ...w, index: i }))}
          routePath={sim.routePath}
          randomWalkRadius={
            sim.mode === SimMode.RandomWalk ? randomWalkRadius :
            (sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop) ? wpGenRadius :
            null
          }
          onMapClick={handleMapClick}
          onTeleport={handleTeleport}
          onNavigate={handleNavigate}
          onAddBookmark={handleAddBookmark}
          onAddWaypoint={handleAddWaypoint}
          showWaypointOption={sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop || sim.mode === SimMode.Navigate}
          deviceConnected={device.connectedDevice !== null}
          onShowToast={showToast}
          userAvatarHtml={avatarToHtml(userAvatar, customPng)}
          bookmarkPins={bm.bookmarks.map((b: any) => ({
            id: b.id, name: b.name, lat: b.lat, lng: b.lng, country_code: b.country_code || '',
          }))}
          showBookmarkPins={showBookmarkPins}
          onMapReady={(api) => { mapApiRef.current = api }}
        />
        {avatarPickerOpen && (
          <UserAvatarPicker
            avatar={userAvatar}
            customPng={customPng}
            onSave={handleAvatarSave}
            onClose={() => setAvatarPickerOpen(false)}
            onShowToast={showToast}
          />
        )}
        {sim.mode === SimMode.Joystick && (
          <JoystickPad
            direction={joystick.direction}
            intensity={joystick.intensity}
            onMove={joystick.updateFromPad}
            onRelease={() => joystick.updateFromPad(0, 0)}
          />
        )}
        {addBmDialog && createPortal(
          <div
            onClick={(e) => e.stopPropagation()}
            className="anim-scale-in"
            style={{
              position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)',
              zIndex: 1000, background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)',
              borderRadius: 12, padding: 16, width: 300,
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('bm.add')}</div>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>
              {addBmDialog.lat.toFixed(5)}, {addBmDialog.lng.toFixed(5)}
            </div>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <input
                type="text"
                className="search-input"
                placeholder={addBmDialog.nameResolving ? t('bm.name_resolving') : t('bm.name_placeholder')}
                autoFocus
                value={addBmDialog.name}
                onChange={(e) => setAddBmDialog({ ...addBmDialog, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAddBookmark()
                  if (e.key === 'Escape') setAddBmDialog(null)
                }}
                style={{ width: '100%', paddingRight: addBmDialog.nameResolving ? 30 : 8 }}
              />
              {addBmDialog.nameResolving && (
                <span style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  fontSize: 10, color: '#9ac0ff', fontFamily: 'monospace',
                  animation: 'pulse 1.2s ease-in-out infinite',
                }}>
                  {t('bm.name_resolving_short')}
                </span>
              )}
              {addBmDialog.countryCode && !addBmDialog.nameResolving && (
                <img
                  src={`https://flagcdn.com/w20/${addBmDialog.countryCode}.png`}
                  alt={addBmDialog.countryCode.toUpperCase()}
                  width={16}
                  height={12}
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    borderRadius: 2, boxShadow: '0 0 0 1px rgba(255,255,255,0.15)',
                  }}
                />
              )}
            </div>
            <select
              value={addBmDialog.category}
              onChange={(e) => setAddBmDialog({ ...addBmDialog, category: e.target.value })}
              style={{
                width: '100%', marginBottom: 10, padding: '6px 8px',
                background: '#1e1e22', color: '#e0e0e0', border: '1px solid #444',
                borderRadius: 4, fontSize: 12,
              }}
            >
              {bm.categories.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="action-btn primary"
                style={{ flex: 1 }}
                disabled={!addBmDialog.name.trim()}
                onClick={submitAddBookmark}
              >{t('generic.add')}</button>
              <button className="action-btn" onClick={() => setAddBmDialog(null)}>{t('generic.cancel')}</button>
            </div>
          </div>,
          document.body,
        )}
        {sim.error && (
          <div
            style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
              zIndex: 2000, background: '#e53935', color: '#fff', padding: '8px 20px',
              borderRadius: 6, fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              cursor: 'pointer', maxWidth: '80%', textAlign: 'center',
            }}
            onClick={sim.clearError}
          >
            {sim.error}
          </div>
        )}
        <StatusBar
          runtimes={sim.runtimes}
          devices={device.connectedDevices}
          isConnected={device.connectedDevice !== null}
          deviceName={device.connectedDevice?.name ?? ''}
          iosVersion={device.connectedDevice?.ios_version ?? ''}
          currentPosition={currentPos}
          speed={displaySpeed}
          mode={sim.mode}
          cooldown={cooldown}
          cooldownEnabled={cooldownEnabled}
          onToggleCooldown={handleToggleCooldown}
          onRestore={handleRestore}
          onOpenLog={handleOpenLog}
          dualDevice={device.connectedDevices.length >= 2}
          countryCode={locMeta.countryCode}
          weatherCode={locMeta.weatherCode}
          tempC={locMeta.tempC}
          onOpenAvatarPicker={() => setAvatarPickerOpen((v) => !v)}
          onLocatePcFly={handleTeleport}
          onLocatePcPanOnly={handleMapPanOnly}
        />

        <UpdateChecker />

        {toastMsg && (
          <div
            key={toastMsg}
            className="anim-fade-slide-down"
            style={{
              position: 'fixed',
              top: 72,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 1500,
              background: 'rgba(26, 29, 39, 0.92)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              color: '#fff',
              padding: '10px 18px',
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '-0.005em',
              boxShadow: '0 10px 32px rgba(12, 18, 40, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
              border: '1px solid rgba(108, 140, 255, 0.3)',
              maxWidth: '70vw',
              textAlign: 'center',
            }}
          >
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
