import React, { useState, useCallback, useEffect } from 'react'
import { useT } from './i18n'
import { useWebSocket } from './hooks/useWebSocket'
import { useDevice } from './hooks/useDevice'
import { useSimulation } from './hooks/useSimulation'
import { useJoystick } from './hooks/useJoystick'
import { useBookmarks } from './hooks/useBookmarks'
import * as api from './services/api'

import MapView from './components/MapView'
import ControlPanel from './components/ControlPanel'
import DeviceStatus from './components/DeviceStatus'
import SimulatorPanel from './components/SimulatorPanel'
import BlueStacksPanel from './components/BlueStacksPanel'
import JoystickPad from './components/JoystickPad'
import EtaBar from './components/EtaBar'
import PauseControl from './components/PauseControl'
import StatusBar from './components/StatusBar'

import { SimMode, MoveMode } from './hooks/useSimulation'

const SPEED_MAP: Record<MoveMode, number> = {
  walking: 5,
  running: 10,
  driving: 40,
}

const App: React.FC = () => {
  const t = useT()
  const ws = useWebSocket()
  const device = useDevice(ws.lastMessage)
  const sim = useSimulation(ws.lastMessage)
  const joystick = useJoystick(ws.sendMessage, sim.mode === SimMode.Joystick)
  const bm = useBookmarks()

  const [savedRoutes, setSavedRoutes] = useState<any[]>([])
  const [cooldown, setCooldown] = useState(0)
  const [cooldownEnabled, setCooldownEnabled] = useState(true)
  const [randomWalkRadius, setRandomWalkRadius] = useState(500)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((msg: string, ms = 2000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToastMsg(msg)
    toastTimerRef.current = setTimeout(() => {
      setToastMsg(null)
      toastTimerRef.current = null
    }, ms)
  }, [])
  // Clear timer if App unmounts
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }, [])

  const handleRestore = useCallback(async () => {
    try {
      await sim.restore()
      showToast(t('status.restore_success'))
    } catch {
      showToast(t('status.restore_failed'))
    }
  }, [showToast, t, sim])
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

    sim.setWaypoints(ordered.map(({ lat, lng }) => ({ lat, lng })))
  }, [sim])

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
    // Just set as destination for now
  }, [])

  const handleTeleport = useCallback((lat: number, lng: number) => {
    sim.teleport(lat, lng)
  }, [sim])

  const handleNavigate = useCallback((lat: number, lng: number) => {
    sim.navigate(lat, lng)
  }, [sim])

  const [addBmDialog, setAddBmDialog] = useState<{ lat: number; lng: number; name: string; category: string } | null>(null)

  const handleAddBookmark = useCallback((lat: number, lng: number) => {
    setAddBmDialog({
      lat,
      lng,
      name: '',
      category: bm.categories[0]?.name || t('bm.default'),
    })
  }, [bm.categories])

  const submitAddBookmark = useCallback(() => {
    if (!addBmDialog || !addBmDialog.name.trim()) return
    const cat = bm.categories.find(c => c.name === addBmDialog.category)
    bm.createBookmark({
      name: addBmDialog.name.trim(),
      lat: addBmDialog.lat,
      lng: addBmDialog.lng,
      category_id: cat?.id || 'default',
    })
    setAddBmDialog(null)
  }, [addBmDialog, bm])

  const handleAddWaypoint = useCallback((lat: number, lng: number) => {
    sim.setWaypoints((prev) => [...prev, { lat, lng }])
  }, [sim])

  const handleClearWaypoints = useCallback(() => {
    sim.setWaypoints([])
  }, [sim])

  const handleRemoveWaypoint = useCallback((index: number) => {
    sim.setWaypoints((prev) => prev.filter((_, i) => i !== index))
  }, [sim])

  const handleStartWaypointRoute = useCallback(() => {
    if (sim.waypoints.length < 1) {
      showToast(t('toast.no_waypoints'))
      return
    }
    const route = sim.currentPosition
      ? [{ lat: sim.currentPosition.lat, lng: sim.currentPosition.lng }, ...sim.waypoints]
      : sim.waypoints
    if (route.length < 2) {
      showToast(t('toast.no_waypoints'))
      return
    }
    if (sim.mode === SimMode.Loop) {
      sim.startLoop(route)
    } else if (sim.mode === SimMode.MultiStop) {
      sim.multiStop(route, 0, false)
    }
  }, [sim, showToast, t])

  // -- ControlPanel handlers --
  const handleStart = useCallback(() => {
    if (sim.mode === SimMode.Joystick) {
      sim.joystickStart()
    } else if (sim.mode === SimMode.RandomWalk) {
      if (!sim.currentPosition) {
        showToast(t('toast.no_position_random'))
        return
      }
      sim.randomWalk(sim.currentPosition, randomWalkRadius)
    } else if (sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop) {
      handleStartWaypointRoute()
    }
  }, [sim, randomWalkRadius, handleStartWaypointRoute, showToast, t])

  const handleStop = useCallback(() => {
    sim.restore()
  }, [sim])

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
  // Status-bar display: range > custom > mode default. Backend re-picks per
  // leg when a range is set, so show "min~max" as an indicator.
  const displaySpeed: number | string = (sim.speedMinKmh != null && sim.speedMaxKmh != null)
    ? `${Math.min(sim.speedMinKmh, sim.speedMaxKmh)}~${Math.max(sim.speedMinKmh, sim.speedMaxKmh)}`
    : (sim.customSpeedKmh ?? speed)

  // Determine running/paused state from status
  const isRunning = sim.status.running
  const isPaused = sim.status.paused

  return (
    <div className="app-layout">
      <div className="sidebar">
        <div className="sidebar-content">
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
          onWifiConnect={device.connectWifi}
          onStopTunnel={device.stopTunnel}
          tunnelStatus={device.tunnelStatus}
        />
        <SimulatorPanel />
        <BlueStacksPanel />
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
          onPause={sim.pause}
          onResume={sim.resume}
          onRestore={handleRestore}
          onTeleport={handleTeleport}
          onNavigate={handleNavigate}
          bookmarks={bm.bookmarks.map(b => ({
            id: b.id,
            name: b.name,
            lat: b.lat,
            lng: b.lng,
            category: bm.categories.find(c => c.id === b.category_id)?.name || t('bm.default'),
          }))}
          bookmarkCategories={bm.categories.map(c => c.name)}
          onBookmarkClick={(b: any) => handleTeleport(b.lat, b.lng)}
          onBookmarkAdd={(b: any) => {
            const cat = bm.categories.find(c => c.name === b.category)
            bm.createBookmark({ name: b.name, lat: b.lat, lng: b.lng, category_id: cat?.id || 'default' })
          }}
          onBookmarkDelete={(id: string) => bm.deleteBookmark(id)}
          onBookmarkEdit={(id: string, data: any) => bm.updateBookmark(id, data)}
          onCategoryAdd={(name: string) => bm.createCategory({ name, color: '#6c8cff' })}
          onCategoryDelete={(name: string) => {
            const cat = bm.categories.find(c => c.name === name)
            if (cat) bm.deleteCategory(cat.id)
          }}
          savedRoutes={savedRoutes.map(r => ({ id: r.id, name: r.name, waypoints: r.waypoints ?? [] }))}
          onRouteGpxImport={handleGpxImport}
          onRouteGpxExport={handleGpxExport}
          onRouteRename={handleRouteRename}
          onRouteDelete={handleRouteDelete}
          onRouteLoad={handleRouteLoad}
          onRouteSave={handleRouteSave}
          randomWalkRadius={randomWalkRadius}
          pauseRandomWalk={sim.pauseRandomWalk}
          onPauseRandomWalkChange={sim.setPauseRandomWalk}
          onRandomWalkRadiusChange={setRandomWalkRadius}
          currentWaypointsCount={sim.waypoints.length}
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
              {sim.waypoints.map((wp: any, i: number) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12 }}>
                  <span style={{ color: '#ff9800', fontWeight: 600, width: 20 }}>#{i + 1}</span>
                  <span style={{ flex: 1, opacity: 0.8 }}>{wp.lat.toFixed(5)}, {wp.lng.toFixed(5)}</span>
                  <button
                    className="action-btn"
                    style={{ padding: '2px 6px', fontSize: 10 }}
                    onClick={() => handleRemoveWaypoint(i)}
                    title={t('panel.waypoints_remove')}
                  >✕</button>
                </div>
              ))}
              {sim.waypoints.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    className="action-btn primary"
                    style={{ flex: 1 }}
                    onClick={handleStartWaypointRoute}
                    disabled={sim.waypoints.length < 1 || !sim.currentPosition}
                  >
                    {sim.mode === SimMode.Loop ? t('panel.waypoints_start_loop') : sim.mode === SimMode.MultiStop ? t('panel.waypoints_start_multi') : t('panel.waypoints_start_navigate')}
                  </button>
                  <button className="action-btn" onClick={handleClearWaypoints}>{t('generic.clear')}</button>
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
        />
        {sim.mode === SimMode.Joystick && (
          <JoystickPad
            direction={joystick.direction}
            intensity={joystick.intensity}
            onMove={joystick.updateFromPad}
            onRelease={() => joystick.updateFromPad(0, 0)}
          />
        )}
        {addBmDialog && (
          <div
            style={{
              position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)',
              zIndex: 2500, background: '#23232a', border: '1px solid #3a3a42',
              borderRadius: 8, padding: 14, width: 300,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('bm.add')}</div>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>
              {addBmDialog.lat.toFixed(5)}, {addBmDialog.lng.toFixed(5)}
            </div>
            <input
              type="text"
              className="search-input"
              placeholder={t('bm.name_placeholder')}
              autoFocus
              value={addBmDialog.name}
              onChange={(e) => setAddBmDialog({ ...addBmDialog, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAddBookmark()
                if (e.key === 'Escape') setAddBmDialog(null)
              }}
              style={{ width: '100%', marginBottom: 8 }}
            />
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
          </div>
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
        />

        {toastMsg && (
          <div
            style={{
              position: 'fixed',
              top: 70,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10001,
              background: 'rgba(40, 44, 60, 0.95)',
              color: '#fff',
              padding: '10px 20px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              border: '1px solid rgba(108, 140, 255, 0.4)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
