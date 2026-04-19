/**
 * useSavedRoutes — server-backed route CRUD with user-facing toasts.
 *
 * Owns: `routes` list state, initial fetch, and 6 mutating actions
 * (save / rename / delete / load / GPX import / GPX export). Each
 * mutation refreshes the list from the server — we don't mutate locally
 * because the server owns canonical state (IDs, timestamps, GPX
 * point-count on import).
 *
 * Toast emission is parameterised via `show` + `t` rather than reaching
 * into a global store, so the hook stays testable and the i18n/toast
 * subsystems can be swapped without touching this file.
 *
 * The `load` action returns the waypoint array; callers wire it into
 * their own state (usually `sim.setWaypoints`) — this keeps us free of
 * the simulation store.
 *
 * Extracted from App.tsx where 1 state + 6 handlers + i18n-sensitive
 * error messages cluttered the top-level component.
 */
import { useCallback, useEffect, useState } from 'react'
import * as api from '../services/api'
import { useT } from '../i18n'
import type { SavedRoute } from '../components/ControlPanel'
import type { LatLng, MoveMode } from './useSimulation'

type ToastFn = (msg: string, ms?: number) => void
// Bind to the exact translator shape `useT()` produces — avoids
// contravariance mismatches between the narrow StringKey union and a
// generic `string` parameter.
type TFn = ReturnType<typeof useT>

interface UseSavedRoutesReturn {
  routes: SavedRoute[]
  save: (name: string, waypoints: LatLng[], profile: MoveMode) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  load: (id: string) => LatLng[] | null
  importGpx: (file: File) => Promise<void>
  exportGpxUrl: (id: string) => string
}

export function useSavedRoutes(show: ToastFn, t: TFn): UseSavedRoutesReturn {
  const [routes, setRoutes] = useState<SavedRoute[]>([])

  // One-shot initial load. Subsequent refreshes happen after each mutation.
  useEffect(() => {
    api.getSavedRoutes().then(setRoutes).catch(() => { /* server may not be up yet */ })
  }, [])

  const refresh = useCallback(async () => {
    try {
      setRoutes(await api.getSavedRoutes())
    } catch { /* non-fatal — list will catch up on next mutation */ }
  }, [])

  const save = useCallback(async (name: string, waypoints: LatLng[], profile: MoveMode) => {
    if (waypoints.length === 0) {
      show(t('toast.route_need_waypoint'))
      return
    }
    try {
      await api.saveRoute({ name, waypoints, profile })
      await refresh()
      show(t('toast.route_saved', { name }))
    } catch (err) {
      show(t('toast.route_save_failed', { msg: api.errMsg(err) }))
    }
  }, [show, t, refresh])

  const rename = useCallback(async (id: string, name: string) => {
    try {
      await api.renameRoute(id, name)
      await refresh()
    } catch (err) {
      show(api.errMsg(err) || t('toast.route_rename_failed'))
    }
  }, [show, t, refresh])

  const remove = useCallback(async (id: string) => {
    try {
      await api.deleteRoute(id)
      await refresh()
      show(t('toast.route_deleted'))
    } catch (err) {
      show(api.errMsg(err) || t('toast.route_delete_failed'))
    }
  }, [show, t, refresh])

  // Pure lookup — caller decides what to do with the waypoints.
  // Returns null (not []) for "not found" so the caller can distinguish
  // "missing route" from "empty route" if that ever matters.
  const load = useCallback((id: string): LatLng[] | null => {
    const route = routes.find((r) => r.id === id)
    if (!route || !Array.isArray(route.waypoints)) return null
    return route.waypoints.map((w) => ({ lat: w.lat, lng: w.lng }))
  }, [routes])

  const importGpx = useCallback(async (file: File) => {
    try {
      const res = await api.importGpx(file)
      await refresh()
      show(t('toast.gpx_imported', { n: res.points }))
    } catch (err) {
      show(t('toast.gpx_import_failed', { msg: api.errMsg(err) }))
    }
  }, [show, t, refresh])

  return { routes, save, rename, remove, load, importGpx, exportGpxUrl: api.exportGpxUrl }
}
