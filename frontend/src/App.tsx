import React, { useState, useCallback, useEffect } from 'react'
import { useT } from './i18n'
import { useWebSocket } from './hooks/useWebSocket'
import { useDevice } from './hooks/useDevice'
import { useSimulation } from './hooks/useSimulation'
import { useJoystick } from './hooks/useJoystick'
import { useBookmarks } from './hooks/useBookmarks'
import * as api from './services/api'

import MapView from './components/MapView'
import ControlPanel, { SavedRoute } from './components/ControlPanel'
import DeviceStatus from './components/DeviceStatus'
import TimerPanel from './components/TimerPanel'
import HistoryPanel from './components/HistoryPanel'
import MultiDevicePanel from './components/MultiDevicePanel'
import JoystickPad from './components/JoystickPad'
import PauseControl from './components/PauseControl'
import StatusBar from './components/StatusBar'
import TopBar from './components/TopBar'
import ActivityRail, { PanelId } from './components/ActivityRail'
import ActionBar from './components/ActionBar'

import { SimMode, MoveMode } from './hooks/useSimulation'

// 砍掉預設速度按鈕後仍需一個 fallback 顯示值（自訂速度留白時用）
const DEFAULT_SPEED_KMH: Record<MoveMode, number> = {
  walking: 5,
  running: 18,
  driving: 100,
}

const App: React.FC = () => {
  const t = useT()
  const ws = useWebSocket()
  const device = useDevice(ws.lastMessage)
  const sim = useSimulation(ws.lastMessage)
  const joystick = useJoystick(ws.sendMessage, sim.status.running && sim.mode === SimMode.Joystick)
  const bm = useBookmarks()

  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [cooldown, setCooldown] = useState(0)
  const [cooldownEnabled, setCooldownEnabled] = useState(true)
  const [randomWalkRadius, setRandomWalkRadius] = useState(500)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [drawingMode, setDrawingMode] = useState(false)
  const [activePanel, setActivePanel] = useState<PanelId | null>('control')
  const [cooldownDistanceKm, setCooldownDistanceKm] = useState(0)
  // Bumped after every teleport so HistoryPanel can auto-refresh its list
  // instead of relying on the user to manually collapse/expand the panel.
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)
  const lastTeleportPosRef = React.useRef<{ lat: number; lng: number } | null>(null)
  const [dragWpIdx, setDragWpIdx]   = useState<number | null>(null)
  const [dragWpOver, setDragWpOver] = useState<number | null>(null)

  // ── Joystick auto-start/stop on mode change ────────────────────────────
  const prevModeRef = React.useRef<SimMode>(sim.mode)
  useEffect(() => {
    const prev = prevModeRef.current
    prevModeRef.current = sim.mode

    if (sim.mode === SimMode.Joystick && prev !== SimMode.Joystick) {
      // Switched into Joystick mode → auto-start if we have a position
      if (!sim.status.running && sim.currentPosition) {
        sim.joystickStart().catch(() => {})
      }
    } else if (prev === SimMode.Joystick && sim.mode !== SimMode.Joystick) {
      // Switched away from Joystick mode → auto-stop
      if (sim.status.running) {
        sim.joystickStop().catch(() => {})
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.mode])

  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((msg: string, ms = 2000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToastMsg(msg)
    toastTimerRef.current = setTimeout(() => {
      setToastMsg(null)
      toastTimerRef.current = null
    }, ms)
  }, [])
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }, [])

  // Toggle panel: clicking active panel closes it
  const handlePanelToggle = useCallback((panel: PanelId) => {
    setActivePanel(prev => prev === panel ? null : panel)
  }, [])

  const handleRestore = useCallback(async () => {
    try {
      await sim.restore()
      showToast(t('status.restore_success'))
    } catch {
      showToast(t('status.restore_failed'))
    }
  }, [showToast, t, sim])

  const handleToggleCooldown = useCallback((enabled: boolean) => {
    setCooldownEnabled(enabled)
    api.setCooldownEnabled(enabled).catch(() => setCooldownEnabled((v) => !v))
  }, [])

  const handleDrawingToggle = useCallback(() => {
    setDrawingMode(v => !v)
  }, [])

  useEffect(() => {
    api.getSavedRoutes().then(setSavedRoutes).catch(() => {})
  }, [])

  useEffect(() => {
    if (ws.connected) {
      device.scan()
    }
  }, [ws.connected])

  useEffect(() => {
    if (!ws.connected) return
    const id = setInterval(() => {
      api.getCooldownStatus().then((s: any) => {
        setCooldown(s.remaining_seconds ?? 0)
        if (typeof s.enabled === 'boolean') setCooldownEnabled(s.enabled)
        if (typeof s.distance_km === 'number') setCooldownDistanceKm(s.distance_km)
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(id)
  }, [ws.connected])

  const handleMapClick = useCallback((_lat: number, _lng: number) => {}, [])

  const handleTeleport = useCallback((lat: number, lng: number) => {
    lastTeleportPosRef.current = sim.currentPosition
      ? { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng }
      : null
    sim.teleport(lat, lng).then(
      () => setHistoryRefreshKey(k => k + 1),
      () => { /* sim.teleport already surfaces the error via sim.error */ },
    )
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
    // `t` is included so the fallback "Default/預設" label respects the
    // current language even if the user switches mid-session.
  }, [bm.categories, t])

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

  const handleWpDrop = useCallback((targetIdx: number) => {
    if (dragWpIdx === null || dragWpIdx === targetIdx) {
      setDragWpIdx(null); setDragWpOver(null); return
    }
    sim.setWaypoints((prev: any[]) => {
      const arr = [...prev]
      const [item] = arr.splice(dragWpIdx, 1)
      arr.splice(targetIdx, 0, item)
      return arr
    })
    setDragWpIdx(null)
    setDragWpOver(null)
  }, [dragWpIdx, sim])

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
    sim.setWaypoints(route.waypoints.map((w) => ({ lat: w.lat, lng: w.lng })))
  }, [savedRoutes, sim])

  // Toast-emitting callbacks must depend on `t` — without it React caches the
  // closure with the previous language's translator and toasts come out in
  // the wrong language after the user switches via LangToggle.
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
    } catch (err) {
      showToast(t('toast.route_save_failed', { msg: api.errMsg(err) }))
    }
  }, [sim, showToast, t])

  const handleGpxImport = useCallback(async (file: File) => {
    try {
      const res = await api.importGpx(file)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.gpx_imported', { n: res.points }))
    } catch (err) {
      showToast(t('toast.gpx_import_failed', { msg: api.errMsg(err) }))
    }
  }, [showToast, t])

  const handleGpxExport = useCallback((id: string) => {
    window.open(api.exportGpxUrl(id), '_blank')
  }, [])

  const handleRouteRename = useCallback(async (id: string, name: string) => {
    try {
      await api.renameRoute(id, name)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
    } catch (err) {
      showToast(api.errMsg(err) || t('toast.route_rename_failed'))
    }
  }, [showToast, t])

  const handleRouteDelete = useCallback(async (id: string) => {
    try {
      await api.deleteRoute(id)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      showToast(t('toast.route_deleted'))
    } catch (err) {
      showToast(api.errMsg(err) || t('toast.route_delete_failed'))
    }
  }, [showToast, t])

  // Derived values
  const currentPos = sim.currentPosition
    ? { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng }
    : null

  const destPos = sim.destination
    ? { lat: sim.destination.lat, lng: sim.destination.lng }
    : null

  const defaultSpeed = DEFAULT_SPEED_KMH[sim.moveMode] || 5
  // 靜止時顯示設定速度（或浮動範圍），移動中改顯示後端回報的即時速度
  const _configSpeed: number | string =
    sim.customSpeedKmh != null && sim.customVarianceKmh != null && sim.customVarianceKmh > 0
      ? `${Math.max(0.1, sim.customSpeedKmh - sim.customVarianceKmh).toFixed(0)}~${(sim.customSpeedKmh + sim.customVarianceKmh).toFixed(0)}`
      : (sim.customSpeedKmh ?? defaultSpeed)
  const displaySpeed: number | string =
    sim.status.running && sim.status.speed > 0
      ? sim.status.speed
      : _configSpeed

  const isRunning = sim.status.running
  const isPaused  = sim.status.paused
  const isConnected = device.connectedDevice !== null

  const showWaypointModes = sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  // Space = pause / resume   Esc = dismiss dialog / error / stop   R = restore
  // Esc 採階層處理：先關對話框、再清錯誤、最後才停止模擬，避免一次 Esc
  // 連鎖關掉不該關的東西。R 鍵只在有進行中的模擬時生效，防止誤觸清除位置。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (target?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          if (isRunning && !isPaused) sim.pause()
          else if (isPaused) sim.resume()
          break
        case 'Escape':
          if (addBmDialog) {
            setAddBmDialog(null)
          } else if (sim.error) {
            sim.clearError()
          } else if (isRunning || isPaused) {
            handleStop()
          }
          break
        case 'r':
        case 'R':
          if (isRunning || isPaused) handleRestore()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isRunning, isPaused, sim, handleStop, handleRestore, addBmDialog])

  return (
    <div className="app-layout">

      {/* ── Top bar ── */}
      <TopBar
        isConnected={isConnected}
        deviceName={device.connectedDevice?.name ?? ''}
        iosVersion={device.connectedDevice?.ios_version ?? ''}
        connectionType={device.connectedDevice?.connection_type}
      />

      {/* ── Body row: rail + side panel + map ── */}
      <div className="app-body">

        {/* Activity rail */}
        <ActivityRail
          activePanel={activePanel}
          onToggle={handlePanelToggle}
          deviceConnected={isConnected}
        />

        {/* Sliding side panel */}
        <div className={`side-panel${activePanel ? ' side-panel--open' : ''}`}>
          <div className="side-panel-content">

            {/* ── 控制 ── */}
            {activePanel === 'control' && (
              <ControlPanel
                simMode={sim.mode}
                defaultSpeed={defaultSpeed}
                isRunning={isRunning}
                isPaused={isPaused}
                currentPosition={currentPos}
                onModeChange={sim.setMode}
                customSpeedKmh={sim.customSpeedKmh}
                onCustomSpeedChange={sim.setCustomSpeedKmh}
                customVarianceKmh={sim.customVarianceKmh}
                onCustomVarianceChange={sim.setCustomVarianceKmh}
                onStart={handleStart}
                onStop={handleStop}
                onPause={sim.pause}
                onResume={sim.resume}
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
                onBookmarkClick={(b: any) =>
                  sim.mode === SimMode.Teleport
                    ? handleTeleport(b.lat, b.lng)
                    : handleNavigate(b.lat, b.lng)
                }
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
                modeExtraSection={showWaypointModes ? (
                  <div className="section" style={{ margin: '0 0 8px 0', padding: '0 0 2px 0' }}>
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
                      {sim.waypoints.length === 0 && (
                        <div style={{ fontSize: 12, opacity: 0.5, padding: '4px 0' }}>
                          {t('panel.waypoints_empty')}
                        </div>
                      )}
                      {sim.waypoints.map((wp: any, i: number) => (
                        <div
                          key={`${wp.lat.toFixed(6)}_${wp.lng.toFixed(6)}_${i}`}
                          draggable
                          onDragStart={() => setDragWpIdx(i)}
                          onDragOver={e => { e.preventDefault(); setDragWpOver(i) }}
                          onDragEnd={() => { setDragWpIdx(null); setDragWpOver(null) }}
                          onDrop={() => handleWpDrop(i)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '3px 4px', fontSize: 12, borderRadius: 4,
                            background: dragWpOver === i && dragWpIdx !== i
                              ? 'rgba(108,140,255,0.18)' : 'transparent',
                            cursor: 'grab', transition: 'background 0.1s',
                            outline: dragWpOver === i && dragWpIdx !== i
                              ? '1px solid rgba(108,140,255,0.4)' : 'none',
                          }}
                        >
                          <span style={{ color: '#64748b', opacity: 0.45, fontSize: 14, lineHeight: 1 }}>⠿</span>
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
                            {sim.mode === SimMode.Loop
                              ? t('panel.waypoints_start_loop')
                              : sim.mode === SimMode.MultiStop
                                ? t('panel.waypoints_start_multi')
                                : t('panel.waypoints_start_navigate')}
                          </button>
                          <button className="action-btn" onClick={handleClearWaypoints}>{t('generic.clear')}</button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              />
            )}

            {/* ── 裝置 ── */}
            {activePanel === 'device' && (
              <>
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
                  isConnected={isConnected}
                  onScan={() => { device.scan() }}
                  onSelect={(id: string) => { device.connect(id) }}
                  onStartWifiTunnel={device.startWifiTunnel}
                  onWifiConnect={device.connectWifi}
                  onStopTunnel={device.stopTunnel}
                  tunnelStatus={device.tunnelStatus}
                />
                <MultiDevicePanel wsMessage={ws.lastMessage} />
              </>
            )}

            {/* ── 工具 ── */}
            {activePanel === 'tools' && (
              <>
                <TimerPanel wsMessage={ws.lastMessage} />
                <HistoryPanel onJump={handleTeleport} refreshKey={historyRefreshKey} />
              </>
            )}

          </div>
        </div>

        {/* ── Map area ── */}
        <div className="map-area">
          {/* DDI mounting overlay */}
          {sim.ddiMounting && (
            <div className="ddi-overlay">
              <div className="ddi-modal">
                <svg
                  width="32" height="32" viewBox="0 0 24 24" fill="none"
                  stroke="var(--accent-blue)" strokeWidth="2"
                  className="spin"
                  style={{ display: 'block', margin: '0 auto 10px' }}
                >
                  <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="16" />
                </svg>
                <div className="ddi-modal-title">{t('ddi.mounting_title')}</div>
                <div className="ddi-modal-hint">{t('ddi.mounting_hint')}</div>
              </div>
            </div>
          )}

          {/* Pause countdown */}
          {sim.pauseRemaining != null && sim.pauseRemaining > 0 && (
            <div className="pause-countdown-banner">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
              {t('toast.pause_countdown', { n: sim.pauseRemaining })}
            </div>
          )}

          {/* Drawing mode banner */}
          {drawingMode && showWaypointModes && (
            <div className="drawing-mode-banner">
              ✏️ 繪圖模式：點擊地圖新增航點
            </div>
          )}

          <MapView
            currentPosition={currentPos}
            destination={destPos}
            waypoints={sim.waypoints.map((w, i) => ({ ...w, index: i }))}
            routePath={sim.routePath}
            randomWalkRadius={sim.mode === SimMode.RandomWalk ? randomWalkRadius : null}
            onMapClick={handleMapClick}
            onTeleport={handleTeleport}
            onNavigate={handleNavigate}
            onAddBookmark={handleAddBookmark}
            onAddWaypoint={handleAddWaypoint}
            showWaypointOption={showWaypointModes || sim.mode === SimMode.Navigate}
            deviceConnected={isConnected}
            drawingMode={drawingMode && showWaypointModes}
            cooldownCircle={
              cooldown > 0 && cooldownDistanceKm > 1 && lastTeleportPosRef.current
                ? { lat: lastTeleportPosRef.current.lat, lng: lastTeleportPosRef.current.lng,
                    distanceKm: cooldownDistanceKm, remainingSeconds: cooldown }
                : null
            }
            bookmarkMarkers={bm.bookmarks.map(b => ({
              id: b.id,
              lat: b.lat,
              lng: b.lng,
              name: b.name,
              category: bm.categories.find(c => c.id === b.category_id)?.name,
            }))}
          />

          {sim.mode === SimMode.Joystick && (
            <JoystickPad
              direction={joystick.direction}
              intensity={joystick.intensity}
              active={isRunning}
              onMove={joystick.updateFromPad}
              onRelease={() => joystick.updateFromPad(0, 0)}
            />
          )}

          {/* Add bookmark dialog */}
          {addBmDialog && (
            <div className="bm-add-dialog">
              <div className="bm-add-dialog-title">{t('bm.add')}</div>
              <div className="bm-add-dialog-coords">
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
                  background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)', fontSize: 12,
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

          {/* Sim error toast */}
          {sim.error && (
            <div className="map-error-toast" onClick={sim.clearError}>
              {sim.error}
            </div>
          )}

          {/* Global toast */}
          {toastMsg && (
            <div className="global-toast">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {toastMsg}
            </div>
          )}
        </div>
      </div>

      {/* ── Action bar ── */}
      <ActionBar
        simMode={sim.mode}
        isRunning={isRunning}
        isPaused={isPaused}
        deviceConnected={isConnected}
        state={sim.status?.state ?? 'idle'}
        progress={sim.progress}
        eta={sim.eta ?? 0}
        remainingDistance={sim.status?.distance_remaining ?? 0}
        traveledDistance={sim.status?.distance_traveled ?? 0}
        drawingMode={drawingMode}
        showDrawingToggle={showWaypointModes}
        onDrawingToggle={handleDrawingToggle}
        onStart={handleStart}
        onPause={sim.pause}
        onResume={sim.resume}
        onStop={handleStop}
        onRestore={handleRestore}
      />

      {/* ── Status bar ── */}
      <StatusBar
        isConnected={isConnected}
        deviceName={device.connectedDevice?.name ?? ''}
        iosVersion={device.connectedDevice?.ios_version ?? ''}
        currentPosition={currentPos}
        speed={displaySpeed}
        mode={sim.mode}
        cooldown={cooldown}
        cooldownEnabled={cooldownEnabled}
        cooldownDistanceKm={cooldownDistanceKm}
        onToggleCooldown={handleToggleCooldown}
        onRestore={handleRestore}
      />

    </div>
  )
}

export default App
