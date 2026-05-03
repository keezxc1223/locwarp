const API = 'http://127.0.0.1:8777'

// Connection-refused means backend isn't up yet, retry with backoff.
// Other HTTP errors (4xx/5xx) are real errors and propagate immediately.
async function fetchWithRetry(url: string, opts: RequestInit, maxAttempts = 15): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fetch(url, opts)
    } catch (e) {
      lastErr = e
      const delay = Math.min(500 + i * 300, 2000)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr ?? new Error('fetch failed')
}

// Bilingual backend error code → user-facing message.
// Looks up the currently selected language from localStorage (set by i18n/index.ts).
const ERROR_I18N: Record<string, { zh: string; en: string }> = {
  python313_missing: { zh: '需要 Python 3.13+ 才能啟動 WiFi Tunnel', en: 'Python 3.13+ is required to start the Wi-Fi tunnel' },
  tunnel_script_missing: { zh: '找不到 wifi_tunnel.py 腳本', en: 'wifi_tunnel.py script not found' },
  tunnel_spawn_failed: { zh: '無法啟動 Tunnel 進程', en: 'Failed to spawn tunnel process' },
  tunnel_exited: { zh: 'Tunnel 進程異常結束', en: 'Tunnel process exited unexpectedly' },
  tunnel_timeout: { zh: 'Tunnel 啟動逾時,請確認 iPhone 解鎖且與電腦同網段', en: 'Tunnel startup timed out, ensure iPhone is unlocked and on the same subnet' },
  no_device: { zh: '尚未連接任何 iOS 裝置,請先透過 USB 連線', en: 'No iOS device connected, connect via USB first' },
  no_position: { zh: '尚未取得目前位置,請先跳點到一個座標', en: 'No current position, teleport to a coordinate first' },
  tunnel_lost: { zh: 'WiFi Tunnel 連線中斷,請重新建立', en: 'Wi-Fi tunnel dropped, please reconnect' },
  cooldown_active: { zh: '冷卻中,請等待後再跳點', en: 'Cooldown active, wait before teleporting' },
  repair_needs_usb: { zh: '重新配對需要 USB, 請先用線連接 iPhone', en: 'Re-pair needs USB, please connect the iPhone first' },
  usbmux_unavailable: { zh: '無法列出 USB 裝置,請確認驅動與 Apple Mobile Device Service 是否正常', en: 'Cannot list USB devices, check iTunes/Apple Mobile Device Service' },
  trust_failed: { zh: 'USB 信任失敗, 請在 iPhone 上點「信任」後再試', en: 'USB trust failed, tap Trust on the iPhone and retry' },
  remote_pair_failed: { zh: 'RemotePairing 記錄重建失敗, 請以系統管理員身分重啟 LocWarp', en: 'RemotePairing record rebuild failed, restart LocWarp as Administrator' },
  device_lost: { zh: '裝置連線中斷(USB 拔除或 Tunnel 死亡),請重新插上 USB 後再操作', en: 'Device connection lost (USB unplugged or tunnel died), please reconnect USB and try again' },
  max_devices_reached: {
    zh: '已連接最多 3 台裝置',
    en: 'Maximum 3 devices connected',
  },
  ios_unsupported: {
    zh: '裝置 iOS 版本過舊,LocWarp 僅支援 iOS 16 以上。請升級 iOS 後再試。',
    en: 'This device runs an unsupported iOS version. LocWarp requires iOS 16 or later. Please update and try again.',
  },
}

function currentLang(): 'zh' | 'en' {
  try {
    const v = localStorage.getItem('locwarp.lang')
    if (v === 'en' || v === 'zh') return v
  } catch { /* ignore */ }
  return (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

// Tack a "did you forget Developer Mode?" hint onto any error mentioning
// pymobiledevice3's InvalidService — that's almost always the cause of
// that exception (Developer Mode disabled / not visible on the iPhone).
function maybeAttachDevModeHint(msg: string): string {
  if (/InvalidService/i.test(msg)) {
    const hint = currentLang() === 'zh'
      ? ' (請檢查 iPhone 開發者模式是否已啟用:設定 → 隱私權與安全性 → 開發者模式)'
      : ' (Check that Developer Mode is enabled on the iPhone: Settings → Privacy & Security → Developer Mode)'
    return msg + hint
  }
  return msg
}

function formatError(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return maybeAttachDevModeHint(detail)
  if (detail && typeof detail === 'object') {
    const d = detail as { code?: string; message?: string }
    if (d.code && ERROR_I18N[d.code]) return ERROR_I18N[d.code][currentLang()]
    if (d.message) return maybeAttachDevModeHint(d.message)
  }
  return maybeAttachDevModeHint(fallback)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetchWithRetry(`${API}${path}`, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(formatError(err.detail, res.statusText))
  }
  return res.json()
}

// Device
export const listDevices = () => request<any[]>('GET', '/api/device/list')
export const connectDevice = (udid: string) => request<any>('POST', `/api/device/${udid}/connect`)
export const disconnectDevice = (udid: string) => request<any>('DELETE', `/api/device/${udid}/connect`)
export const wifiConnect = (ip: string) => request<any>('POST', '/api/device/wifi/connect', { ip })
export const wifiScan = () => request<any[]>('GET', '/api/device/wifi/scan')
export const wifiTunnelStartAndConnect = (ip: string, port = 49152, udid?: string) =>
  request<any>('POST', '/api/device/wifi/tunnel/start-and-connect', { ip, port, ...(udid ? { udid } : {}) })
export interface TunnelInfo { udid: string; rsd_address?: string; rsd_port?: number; interface?: string; protocol?: string }
export const wifiTunnelStatus = () =>
  request<{ tunnels: TunnelInfo[]; running: boolean; rsd_address?: string; rsd_port?: number }>(
    'GET', '/api/device/wifi/tunnel/status',
  )
export const wifiTunnelDiscover = () => request<{ devices: { ip: string; port: number; host: string; name: string }[] }>('GET', '/api/device/wifi/tunnel/discover')
// udid: stop one specific tunnel; omit to stop all (legacy stop-all)
export const wifiTunnelStop = (udid?: string) =>
  request<{ status: string; udid?: string; udids?: string[] }>(
    'POST', '/api/device/wifi/tunnel/stop', udid ? { udid } : {},
  )
export const wifiRepair = () => request<{ status: string; udid: string; name: string; ios_version: string; remote_record_regenerated: boolean }>('POST', '/api/device/wifi/repair')
export const amfiRevealDeveloperMode = (udid: string) =>
  request<{ status: string }>('POST', `/api/device/${encodeURIComponent(udid)}/amfi/reveal-developer-mode`)

// Bookmark UI state (expand/collapse per category, persisted in settings.json)
export const getBookmarkUiState = () =>
  request<{ expanded_categories: string[] | null }>('GET', '/api/bookmarks/ui-state')
export const setBookmarkUiState = (expanded_categories: string[]) =>
  request<{ status: string; expanded_categories: string[] }>('POST', '/api/bookmarks/ui-state', { expanded_categories })

// Location simulation
// Every action accepts an optional `udid` so the caller can target a specific
// device in group mode. When omitted, the backend routes to the primary engine.
const ud = (udid?: string | null) => (udid ? { udid } : {})
const qs = (udid?: string | null) => (udid ? `?udid=${encodeURIComponent(udid)}` : '')

export const teleport = (lat: number, lng: number, udid?: string) =>
  request<any>('POST', '/api/location/teleport', { lat, lng, ...ud(udid) })
export interface SpeedOpts { speed_kmh?: number | null; speed_min_kmh?: number | null; speed_max_kmh?: number | null }
export interface PauseOpts { pause_enabled?: boolean; pause_min?: number; pause_max?: number }
const sp = (o?: SpeedOpts) => ({
  speed_kmh: o?.speed_kmh ?? null,
  speed_min_kmh: o?.speed_min_kmh ?? null,
  speed_max_kmh: o?.speed_max_kmh ?? null,
})
const pp = (o?: PauseOpts) => (o ? {
  pause_enabled: o.pause_enabled ?? true,
  pause_min: o.pause_min ?? 5,
  pause_max: o.pause_max ?? 20,
} : {})
const sl = (v?: boolean) => (v ? { straight_line: true } : {})
const re = (v?: string | null) => (v ? { route_engine: v } : {})
export type JumpOpts = { jump_mode?: boolean; jump_interval?: number }
const jm = (o?: JumpOpts) => (o?.jump_mode ? { jump_mode: true, jump_interval: o.jump_interval ?? 12 } : {})
export const navigate = (lat: number, lng: number, mode: string, speed?: SpeedOpts, udid?: string, straightLine?: boolean, routeEngine?: string) =>
  request<any>('POST', '/api/location/navigate', { lat, lng, mode, ...sp(speed), ...sl(straightLine), ...re(routeEngine), ...ud(udid) })
export const startLoop = (waypoints: { lat: number; lng: number }[], mode: string, speed?: SpeedOpts, pause?: PauseOpts, udid?: string, straightLine?: boolean, lapCount?: number | null, routeEngine?: string, jump?: JumpOpts) =>
  request<any>('POST', '/api/location/loop', { waypoints, mode, ...sp(speed), ...pp(pause), ...sl(straightLine), ...re(routeEngine), ...ud(udid), ...(lapCount != null && lapCount > 0 ? { lap_count: lapCount } : {}), ...jm(jump) })
export const multiStop = (waypoints: { lat: number; lng: number }[], mode: string, stop_duration: number, loop: boolean, speed?: SpeedOpts, pause?: PauseOpts, udid?: string, straightLine?: boolean, routeEngine?: string, jump?: JumpOpts) =>
  request<any>('POST', '/api/location/multistop', { waypoints, mode, stop_duration, loop, ...sp(speed), ...pp(pause), ...sl(straightLine), ...re(routeEngine), ...ud(udid), ...jm(jump) })
export const randomWalk = (center: { lat: number; lng: number }, radius_m: number, mode: string, speed?: SpeedOpts, pause?: PauseOpts, udid?: string, seed?: number | null, straightLine?: boolean, routeEngine?: string) =>
  request<any>('POST', '/api/location/randomwalk', { center, radius_m, mode, ...sp(speed), ...pp(pause), ...sl(straightLine), ...re(routeEngine), ...ud(udid), ...(seed != null ? { seed } : {}) })
export const joystickStart = (mode: string, udid?: string) =>
  request<any>('POST', '/api/location/joystick/start', { mode, ...ud(udid) })
export const joystickStop = (udid?: string) => request<any>('POST', `/api/location/joystick/stop${qs(udid)}`)
export const pauseSim = (udid?: string) => request<any>('POST', `/api/location/pause${qs(udid)}`)
export const resumeSim = (udid?: string) => request<any>('POST', `/api/location/resume${qs(udid)}`)
export const restoreSim = (udid?: string) => request<any>('POST', `/api/location/restore${qs(udid)}`)
export const stopSim = (udid?: string) => request<any>('POST', `/api/location/stop${qs(udid)}`)
// Live waypoint insert into a running multi-stop / loop. Returns
// {ok, mode: 'live'|'deferred', splice_in_past}. Frontend fans out
// to every connected udid in group mode so all engines stay aligned
// on the same waypoint list.
export const insertWaypoint = (after_index: number, lat: number, lng: number, udid?: string) =>
  request<{ ok: boolean; mode?: 'live' | 'deferred'; splice_in_past?: boolean; reason?: string }>(
    'POST', '/api/location/insert_waypoint', { after_index, lat, lng, ...ud(udid) },
  )
export const getStatus = (udid?: string) => request<any>('GET', `/api/location/status${qs(udid)}`)

// Cooldown
export const getCooldownStatus = () => request<any>('GET', '/api/location/cooldown/status')
export const setCooldownEnabled = (enabled: boolean) =>
  request<any>('PUT', '/api/location/cooldown/settings', { enabled })
export const dismissCooldown = () => request<any>('POST', '/api/location/cooldown/dismiss')

// Coord format
export const getCoordFormat = () => request<any>('GET', '/api/location/settings/coord-format')
export const setCoordFormat = (format: string) =>
  request<any>('PUT', '/api/location/settings/coord-format', { format })

// Geocoding — forward search.
//
// Provider + API key are read from localStorage on every call so the
// caller doesn't have to thread them through the component tree. If
// the user picked Google but never saved a key, fall back to nominatim
// silently rather than letting the backend 400.
export const searchAddress = (q: string) => {
  let provider = 'nominatim'
  let googleKey = ''
  try {
    provider = localStorage.getItem('locwarp.geocode_provider') || 'nominatim'
    googleKey = localStorage.getItem('locwarp.google_geocode_key') || ''
  } catch { /* storage disabled */ }
  if (provider === 'google' && !googleKey) provider = 'nominatim'
  const params = new URLSearchParams({ q })
  if (provider === 'google') {
    params.set('provider', 'google')
    params.set('google_key', googleKey)
  }
  return request<any[]>('GET', `/api/geocode/search?${params.toString()}`)
}
export const reverseGeocode = (lat: number, lng: number) =>
  request<any>('GET', `/api/geocode/reverse?lat=${lat}&lng=${lng}`)
export const lookupTimezone = (lat: number, lng: number) =>
  request<{ zone: string; gmt_offset_seconds: number; abbreviation: string; timestamp: number } | null>(
    'GET', `/api/geocode/timezone?lat=${lat}&lng=${lng}`,
  )

// Weather — Open-Meteo (free, global, no API key, ~10k req/day per client IP).
// Called directly from the renderer so each user queries from their own IP
// and keeps their own quota; we never proxy through the backend.
export async function lookupWeather(lat: number, lng: number): Promise<{ tempC: number; code: number } | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=temperature_2m,weather_code`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    const c = data?.current
    if (!c) return null
    const tempC = Number(c.temperature_2m)
    const code = Number(c.weather_code)
    if (!Number.isFinite(tempC) || !Number.isFinite(code)) return null
    return { tempC, code }
  } catch {
    return null
  }
}
export const routeOptimize = (waypoints: { lat: number; lng: number }[], profile = 'foot', keep_first = true) =>
  request<{ waypoints: { lat: number; lng: number }[]; total_distance_m: number; total_duration_s: number; used_estimate?: boolean }>(
    'POST', '/api/geocode/route-optimize', { waypoints, profile, keep_first },
  )

// Bookmarks
export const getBookmarks = () => request<any>('GET', '/api/bookmarks')
export const createBookmark = (bm: any) => request<any>('POST', '/api/bookmarks', bm)
export const updateBookmark = (id: string, bm: any) => request<any>('PUT', `/api/bookmarks/${id}`, bm)
export const deleteBookmark = (id: string) => request<any>('DELETE', `/api/bookmarks/${id}`)
export const moveBookmarks = (ids: string[], catId: string) =>
  request<any>('POST', '/api/bookmarks/move', { bookmark_ids: ids, target_category_id: catId })
export const getCategories = () => request<any[]>('GET', '/api/bookmarks/categories')
export const createCategory = (cat: any) => request<any>('POST', '/api/bookmarks/categories', cat)
export const updateCategory = (id: string, cat: any) => request<any>('PUT', `/api/bookmarks/categories/${id}`, cat)
export const deleteCategory = (id: string) => request<any>('DELETE', `/api/bookmarks/categories/${id}`)

export const bookmarksExportUrl = () => `${API}/api/bookmarks/export`

// Recent places: last 20 flights.
// kind distinguishes the entry point AND the action, so the UI can show
// a clear label ("座標 / 瞬移 / 導航 / 地址") and re-fly with the same
// action the user originally invoked.
export type RecentKind = 'teleport' | 'navigate' | 'search' | 'coord_teleport' | 'coord_navigate'
export interface RecentEntry { lat: number; lng: number; kind: RecentKind; name: string; ts: number }
export const getRecent = () => request<RecentEntry[]>('GET', '/api/recent')
export const pushRecent = (entry: { lat: number; lng: number; kind: RecentKind; name?: string | null }) =>
  request<RecentEntry>('POST', '/api/recent', entry)
export const clearRecent = () => request<{ status: string }>('DELETE', '/api/recent')
export const importBookmarks = (data: any) => request<{ imported: number }>('POST', '/api/bookmarks/import', data)

export const getInitialPosition = () =>
  request<{ position: { lat: number; lng: number } | null }>('GET', '/api/location/settings/initial-position')
export const setInitialPosition = (lat: number | null, lng: number | null) =>
  request<{ position: { lat: number; lng: number } | null }>('PUT', '/api/location/settings/initial-position', { lat, lng })

export const openLog = () => request<{ status: string; path: string }>('POST', '/api/system/open-log')
export const openLogFolder = () => request<{ status: string; path: string }>('POST', '/api/system/open-log-folder')

export const applySpeed = (mode: string, opts: { speed_kmh?: number | null; speed_min_kmh?: number | null; speed_max_kmh?: number | null }, udid?: string) =>
  request<{ status: string; speed_mps: number }>('POST', '/api/location/apply-speed', {
    mode,
    speed_kmh: opts.speed_kmh ?? null,
    speed_min_kmh: opts.speed_min_kmh ?? null,
    speed_max_kmh: opts.speed_max_kmh ?? null,
    ...ud(udid),
  })

// Routes
export const planRoute = (start: any, end: any, profile: string) =>
  request<any>('POST', '/api/route/plan', { start, end, profile })
export const getSavedRoutes = () => request<any[]>('GET', '/api/route/saved')
export const saveRoute = (route: any) => request<any>('POST', '/api/route/saved', route)
export const deleteRoute = (id: string) => request<any>('DELETE', `/api/route/saved/${id}`)
export const renameRoute = (id: string, name: string) => request<any>('PATCH', `/api/route/saved/${id}`, { name })

// GPX import/export
export async function importGpx(file: File): Promise<{ status: string; id: string; points: number }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${API}/api/route/gpx/import`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(formatError(err.detail, res.statusText))
  }
  return res.json()
}

export function exportGpxUrl(routeId: string): string {
  return `${API}/api/route/gpx/export/${routeId}`
}

// Bulk JSON export / import for saved routes
export function exportAllRoutesUrl(): string {
  return `${API}/api/route/saved/export`
}

export const importAllRoutes = (data: { routes: any[] }) =>
  request<{ imported: number }>('POST', '/api/route/saved/import', data)
