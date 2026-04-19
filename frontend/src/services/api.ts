// Derive backend URL from the current browser location so the app works both
// on localhost and when accessed from a phone on the local network
// (e.g. http://192.168.1.101:5173  →  API = http://192.168.1.101:8777).
const API_HOST = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1'
const API = `http://${API_HOST}:8777`

// Connection-refused means backend isn't up yet — retry with backoff.
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
  tunnel_timeout: { zh: 'Tunnel 啟動逾時,請確認 iPhone 解鎖且與電腦同網段', en: 'Tunnel startup timed out — ensure iPhone is unlocked and on the same subnet' },
  no_device: { zh: '尚未連接任何 iOS 裝置,請先透過 USB 連線', en: 'No iOS device connected — connect via USB first' },
  no_position: { zh: '尚未取得目前位置,請先跳點到一個座標', en: 'No current position — teleport to a coordinate first' },
  tunnel_lost: { zh: 'WiFi Tunnel 連線中斷,請重新建立', en: 'Wi-Fi tunnel dropped — please reconnect' },
  cooldown_active: { zh: '冷卻中,請等待後再跳點', en: 'Cooldown active — wait before teleporting' },
  repair_needs_usb: { zh: '重新配對需要 USB — 請先用線連接 iPhone', en: 'Re-pair needs USB — please connect the iPhone first' },
  usbmux_unavailable: { zh: '無法列出 USB 裝置,請確認驅動與 Apple Mobile Device Service 是否正常', en: 'Cannot list USB devices — check iTunes/Apple Mobile Device Service' },
  trust_failed: { zh: 'USB 信任失敗 — 請在 iPhone 上點「信任」後再試', en: 'USB trust failed — tap Trust on the iPhone and retry' },
  remote_pair_failed: { zh: 'RemotePairing 記錄重建失敗 — 請以系統管理員身分重啟 LocWarp', en: 'RemotePairing record rebuild failed — restart LocWarp as Administrator' },
  device_lost: { zh: '裝置連線中斷(USB 拔除或 Tunnel 死亡),請重新插上 USB 後再操作', en: 'Device connection lost (USB unplugged or tunnel died), please reconnect USB and try again' },
}

function currentLang(): 'zh' | 'en' {
  try {
    const v = localStorage.getItem('locwarp.lang')
    if (v === 'en' || v === 'zh') return v
  } catch { /* ignore */ }
  return (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

function formatError(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object') {
    const d = detail as { code?: string; message?: string }
    if (d.code && ERROR_I18N[d.code]) return ERROR_I18N[d.code][currentLang()]
    if (d.message) return d.message
  }
  return fallback
}

/**
 * Safe error-message extractor for `catch (err)` blocks.
 *
 * `catch (err: any)` is a footgun: TypeScript can't validate that `err.message`
 * exists, so a thrown non-Error (string, number, undefined, anything) silently
 * becomes `undefined` in the toast. Use this everywhere instead.
 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
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
export const wifiTunnelStatus = () => request<any>('GET', '/api/device/wifi/tunnel/status')
export const wifiTunnelDiscover = () => request<{ devices: { ip: string; port: number; host: string; name: string }[] }>('GET', '/api/device/wifi/tunnel/discover')
export const wifiTunnelStop = () => request<any>('POST', '/api/device/wifi/tunnel/stop')
export const wifiRepair = () => request<{ status: string; udid: string; name: string; ios_version: string; remote_record_regenerated: boolean }>('POST', '/api/device/wifi/repair')

// Location simulation
export const teleport = (lat: number, lng: number) =>
  request<any>('POST', '/api/location/teleport', { lat, lng })
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
export const navigate = (lat: number, lng: number, mode: string, speed?: SpeedOpts) =>
  request<any>('POST', '/api/location/navigate', { lat, lng, mode, ...sp(speed) })
export const startLoop = (waypoints: { lat: number; lng: number }[], mode: string, speed?: SpeedOpts, pause?: PauseOpts) =>
  request<any>('POST', '/api/location/loop', { waypoints, mode, ...sp(speed), ...pp(pause) })
export const multiStop = (waypoints: { lat: number; lng: number }[], mode: string, stop_duration: number, loop: boolean, speed?: SpeedOpts, pause?: PauseOpts) =>
  request<any>('POST', '/api/location/multistop', { waypoints, mode, stop_duration, loop, ...sp(speed), ...pp(pause) })
export const randomWalk = (center: { lat: number; lng: number }, radius_m: number, mode: string, speed?: SpeedOpts, pause?: PauseOpts) =>
  request<any>('POST', '/api/location/randomwalk', { center, radius_m, mode, ...sp(speed), ...pp(pause) })
export const joystickStart = (mode: string, speed?: SpeedOpts) =>
  request<any>('POST', '/api/location/joystick/start', { mode, ...sp(speed) })
export const joystickStop = () => request<any>('POST', '/api/location/joystick/stop')
export const pauseSim = () => request<any>('POST', '/api/location/pause')
export const resumeSim = () => request<any>('POST', '/api/location/resume')
export const restoreSim = () => request<any>('POST', '/api/location/restore')
export const getStatus = () => request<any>('GET', '/api/location/status')

// Scheduled return (定時回家)
export const timerStart = (seconds: number) => request<any>('POST', '/api/location/timer/start', { seconds })
export const timerCancel = () => request<any>('DELETE', '/api/location/timer/cancel')
export const timerStatus = () => request<any>('GET', '/api/location/timer/status')

// Location history
export const getHistory = () => request<{ entries: any[] }>('GET', '/api/history')
export const clearHistory = () => request<any>('DELETE', '/api/history')
export function exportHistoryGpxUrl(): string {
  return `${API}/api/history/export/gpx`
}

// GPS Jitter
export const getJitter = () => request<any>('GET', '/api/location/settings/jitter')
export const setJitter = (enabled: boolean) =>
  request<any>('PUT', '/api/location/settings/jitter', { enabled })

// Cooldown
export const getCooldownStatus = () => request<any>('GET', '/api/location/cooldown/status')
export const setCooldownEnabled = (enabled: boolean) =>
  request<any>('PUT', '/api/location/cooldown/settings', { enabled })
export const dismissCooldown = () => request<any>('POST', '/api/location/cooldown/dismiss')

// Coord format
export const getCoordFormat = () => request<any>('GET', '/api/location/settings/coord-format')
export const setCoordFormat = (format: string) =>
  request<any>('PUT', '/api/location/settings/coord-format', { format })

// Initial (startup) position — available even before any device connects
export const getInitialPosition = () =>
  request<{ lat: number; lng: number }>('GET', '/api/location/initial-position')

// Home position (fixed startup location)
export const getHomePosition = () =>
  request<{ home_position: { lat: number; lng: number } | null }>('GET', '/api/location/settings/home-position')
export const setHomePosition = (lat: number, lng: number) =>
  request<any>('PUT', '/api/location/settings/home-position', { lat, lng })
export const clearHomePosition = () =>
  request<any>('DELETE', '/api/location/settings/home-position')

// Multi-device GPS sync
export const getSyncDevices = () =>
  request<{ devices: { udid: string; name: string; is_primary: boolean }[]; total: number }>('GET', '/api/device/sync')
export const addSyncDevice = (udid: string) => request<any>('POST', '/api/device/sync', { udid })
export const removeSyncDevice = (udid: string) => request<any>('DELETE', `/api/device/sync/${udid}`)

// Geocoding
export const searchAddress = (q: string) => request<any[]>('GET', `/api/geocode/search?q=${encodeURIComponent(q)}`)
export const reverseGeocode = (lat: number, lng: number) =>
  request<any>('GET', `/api/geocode/reverse?lat=${lat}&lng=${lng}`)

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
