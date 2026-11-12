import { MAX_DEVICES } from '../deviceSlots'

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
  geocode_timeout: { zh: '地址搜尋服務回應逾時,請稍後再試或換一個搜尋來源', en: 'Address search timed out, try again later or switch the search provider' },
  geocode_unavailable: { zh: '地址搜尋服務暫時無法使用,請稍後再試或換一個搜尋來源', en: 'Address search service is unavailable, try again later or switch the search provider' },
  repair_needs_usb: { zh: '重新配對需要 USB, 請先用線連接 iPhone', en: 'Re-pair needs USB, please connect the iPhone first' },
  usbmux_unavailable: { zh: '無法列出 USB 裝置,請確認驅動與 Apple Mobile Device Service 是否正常', en: 'Cannot list USB devices, check iTunes/Apple Mobile Device Service' },
  trust_failed: { zh: 'USB 信任失敗, 請在 iPhone 上點「信任」後再試', en: 'USB trust failed, tap Trust on the iPhone and retry' },
  remote_pair_failed: { zh: 'RemotePairing 記錄重建失敗, 請以系統管理員身分重啟 LocWarp', en: 'RemotePairing record rebuild failed, restart LocWarp as Administrator' },
  device_lost: { zh: '裝置連線中斷(USB 拔除或 Tunnel 死亡),請重新插上 USB 後再操作', en: 'Device connection lost (USB unplugged or tunnel died), please reconnect USB and try again' },
  device_lost_tunnel_dead: {
    zh: 'WiFi 連線中斷,請確認手機 WiFi 與電腦同網段、解鎖手機後再試',
    en: 'Wi-Fi tunnel dropped — confirm the iPhone is on the same subnet, unlock the screen, and retry',
  },
  device_lost_lockdown_dead: {
    zh: '裝置回應停止,請解鎖手機螢幕後再試',
    en: 'Device stopped responding — unlock the iPhone screen and retry',
  },
  device_lost_ddi_missing: {
    zh: 'Developer Disk Image 未掛載,請重新插拔 USB 或重新啟動裝置',
    en: 'Developer Disk Image is not mounted — replug USB or reboot the device',
  },
  device_lost_usb_gone: {
    zh: 'USB 已拔除,請重新插上後再操作',
    en: 'USB cable disconnected — plug it back in and retry',
  },
  max_devices_reached: {
    zh: `已連接最多 ${MAX_DEVICES} 台裝置`,
    en: `Maximum ${MAX_DEVICES} devices connected`,
  },
  ios_unsupported: {
    zh: '裝置 iOS 版本過舊,LocWarp 僅支援 iOS 16 以上。請升級 iOS 後再試。',
    en: 'This device runs an unsupported iOS version. LocWarp requires iOS 16 or later. Please update and try again.',
  },
  pipi_no_cookie: { zh: '尚未設定 Pipi Mushroom 的 Cookie', en: 'Pipi Mushroom cookie is not set' },
  pipi_local_only: { zh: '只能在這台電腦上設定 Cookie', en: 'The cookie can only be set from this PC' },
  pipi_cookie_invalid: { zh: 'Cookie 格式不正確, 應為 name=value; name2=value2', en: 'Invalid cookie, expected name=value; name2=value2' },
  pipi_login_required: { zh: 'pipimushroom.com 的登入已過期, 請在 Chrome 開啟該網站重新登入, 之後會自動恢復', en: 'The pipimushroom.com login has expired. Open the site in Chrome and log in again; it recovers by itself' },
  pipi_rate_limited: { zh: 'Pipi Mushroom 請求太頻繁, 稍後會自動重試', en: 'Pipi Mushroom rate limit hit, will retry automatically' },
  pipi_unavailable: { zh: 'Pipi Mushroom 暫時無法連線, 或網站格式已變更', en: 'Pipi Mushroom is unreachable, or the site format changed' },
  pipi_zoom_too_low: { zh: '請放大地圖後再載入蘑菇地圖', en: 'Zoom in to load the mushroom map' },
  pipi_bad_bounds: { zh: '地圖範圍不正確', en: 'Invalid map bounds' },
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
    const d = detail as { code?: string; reason?: string; message?: string }
    // Composite lookup: device_lost + reason → tunnel_dead/lockdown_dead/etc
    // gives a more specific message than the generic device_lost fallback.
    if (d.code && d.reason) {
      const composite = `${d.code}_${d.reason}`
      if (ERROR_I18N[composite]) return ERROR_I18N[composite][currentLang()]
    }
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
// ports: extra RemotePairing port candidates the backend walks if `port` is
// stale. iOS re-picks the port on every boot, so a remembered one often is.
// skipConnected: a phone that is already connected (USB or WiFi) is left
// exactly as it is and the call answers { status: 'already_connected', udid }.
export const wifiTunnelStartAndConnect = (
  ip: string, port = 49152, udid?: string, ports?: number[], skipConnected = false,
) =>
  request<any>('POST', '/api/device/wifi/tunnel/start-and-connect', {
    ip, port,
    ...(udid ? { udid } : {}),
    ...(ports && ports.length ? { ports } : {}),
    ...(skipConnected ? { skip_connected: true } : {}),
  })
// target_ip / target_port: the phone's LAN address the tunnel was opened to.
// Only /wifi/tunnel/status fills them.
export interface TunnelInfo {
  udid: string; rsd_address?: string; rsd_port?: number; interface?: string; protocol?: string
  target_ip?: string; target_port?: number
}
export const wifiTunnelStatus = () =>
  request<{ tunnels: TunnelInfo[]; running: boolean; rsd_address?: string; rsd_port?: number }>(
    'GET', '/api/device/wifi/tunnel/status',
  )
// scan=false: mDNS only, no LAN scan. Background auto-connect must use it.
export const wifiTunnelDiscover = (opts?: { scan?: boolean }) =>
  request<{ devices: { ip: string; port: number; ports?: number[]; host: string; name: string; method?: 'mdns' | 'tcp_scan' }[] }>(
    'GET', `/api/device/wifi/tunnel/discover${opts?.scan === false ? '?scan=false' : ''}`,
  )
export const wifiTunnelFindPort = (ip: string) =>
  request<{ ip: string; ports: number[]; proxy_suspected?: boolean }>('POST', '/api/device/wifi/tunnel/find_port', { ip })
// udid: stop one specific tunnel; omit to stop all (legacy stop-all)
export const wifiTunnelStop = (udid?: string) =>
  request<{ status: string; udid?: string; udids?: string[] }>(
    'POST', '/api/device/wifi/tunnel/stop', udid ? { udid } : {},
  )
export const wifiRepair = () => request<{ status: string; udid: string; name: string; ios_version: string; remote_record_regenerated: boolean }>('POST', '/api/device/wifi/repair')
// WiFi tunnel keep-alive: backend re-pushes the current simulated location
// to idle tunnels so iOS doesn't drop the RSD socket when the screen is off.
export const wifiHostNetwork = () =>
  request<{ ip: string | null; prefix: string | null }>('GET', '/api/device/wifi/host-network')
export const wifiKeepaliveGet = () => request<{ enabled: boolean }>('GET', '/api/device/wifi/tunnel/keepalive')
export const wifiKeepaliveSet = (enabled: boolean) =>
  request<{ enabled: boolean }>('POST', '/api/device/wifi/tunnel/keepalive', { enabled })
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
export const goldDittoCycle = (lat: number, lng: number, udid?: string) =>
  request<any>('POST', '/api/location/goldditto/cycle', { lat, lng, ...ud(udid) })
// `seed` is set when several devices start together, so they all draw the
// same random speed / pause values.
export interface SpeedOpts { speed_kmh?: number | null; speed_min_kmh?: number | null; speed_max_kmh?: number | null; seed?: number | null }
export interface PauseOpts { pause_enabled?: boolean; pause_min?: number; pause_max?: number }
const sp = (o?: SpeedOpts) => ({
  speed_kmh: o?.speed_kmh ?? null,
  speed_min_kmh: o?.speed_min_kmh ?? null,
  speed_max_kmh: o?.speed_max_kmh ?? null,
  ...(o?.seed != null ? { seed: o.seed } : {}),
})
const pp = (o?: PauseOpts) => (o ? {
  pause_enabled: o.pause_enabled ?? true,
  pause_min: o.pause_min ?? 5,
  pause_max: o.pause_max ?? 20,
} : {})
const sl = (v?: boolean) => (v ? { straight_line: true } : {})
const re = (v?: string | null) => (v ? { route_engine: v } : {})
export type JumpOpts = { jump_mode?: boolean; jump_pre_delay?: number; jump_post_delay?: number }
const jm = (o?: JumpOpts) => (o?.jump_mode ? {
  jump_mode: true,
  jump_pre_delay: o.jump_pre_delay ?? 2,
  jump_post_delay: o.jump_post_delay ?? 4,
} : {})
export const navigate = (lat: number, lng: number, mode: string, speed?: SpeedOpts, udid?: string, straightLine?: boolean, routeEngine?: string) =>
  request<any>('POST', '/api/location/navigate', { lat, lng, mode, ...sp(speed), ...sl(straightLine), ...re(routeEngine), ...ud(udid) })
export const startLoop = (waypoints: { lat: number; lng: number }[], mode: string, speed?: SpeedOpts, pause?: PauseOpts, udid?: string, straightLine?: boolean, lapCount?: number | null, routeEngine?: string, jump?: JumpOpts) =>
  request<any>('POST', '/api/location/loop', { waypoints, mode, ...sp(speed), ...pp(pause), ...sl(straightLine), ...re(routeEngine), ...ud(udid), ...(lapCount != null && lapCount > 0 ? { lap_count: lapCount } : {}), ...jm(jump) })
export const multiStop = (waypoints: { lat: number; lng: number }[], mode: string, stop_duration: number, loop: boolean, speed?: SpeedOpts, pause?: PauseOpts, udid?: string, straightLine?: boolean, routeEngine?: string, jump?: JumpOpts) =>
  request<any>('POST', '/api/location/multistop', { waypoints, mode, stop_duration, loop, ...sp(speed), ...pp(pause), ...sl(straightLine), ...re(routeEngine), ...ud(udid), ...jm(jump) })
export interface FlowerOpts {
  radius_m?: number
  segments?: number
  circles?: number
  rounds?: number
  pre_wait?: number
  post_wait?: number
  teleport?: boolean
}
export const flower = (waypoints: { lat: number; lng: number }[], mode: string, opts: FlowerOpts, speed?: SpeedOpts, udid?: string, straightLine?: boolean, routeEngine?: string) =>
  request<any>('POST', '/api/location/flower', {
    waypoints, mode,
    radius_m: opts.radius_m ?? 30,
    segments: opts.segments ?? 8,
    circles: opts.circles ?? 1,
    rounds: opts.rounds ?? 1,
    pre_wait: opts.pre_wait ?? 3,
    post_wait: opts.post_wait ?? 3,
    teleport: opts.teleport ?? false,
    ...sp(speed), ...sl(straightLine), ...re(routeEngine), ...ud(udid),
  })
export const randomWalk = (center: { lat: number; lng: number }, radius_m: number, mode: string, speed?: SpeedOpts, pause?: PauseOpts, udid?: string, seed?: number | null, straightLine?: boolean, routeEngine?: string, centerMode?: string, forward?: { enabled: boolean; turnDeg: number }) =>
  request<any>('POST', '/api/location/randomwalk', { center, radius_m, mode, ...sp(speed), ...pp(pause), ...sl(straightLine), ...re(routeEngine), ...ud(udid), ...(seed != null ? { seed } : {}), ...(centerMode ? { center_mode: centerMode } : {}), ...(forward?.enabled ? { forward_enabled: true, forward_turn_deg: forward.turnDeg } : {}) })
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
// the user picked Google but never saved a key, fall back to ArcGIS
// silently rather than letting the backend 400.
export const searchAddress = (q: string) => {
  let provider = 'arcgis'
  let googleKey = ''
  let arcgisKey = ''
  try {
    provider = localStorage.getItem('locwarp.geocode_provider') || 'arcgis'
    googleKey = localStorage.getItem('locwarp.google_geocode_key') || ''
    arcgisKey = localStorage.getItem('locwarp.arcgis_geocode_key') || ''
  } catch { /* storage disabled */ }
  if (provider === 'google' && !googleKey) provider = 'arcgis'
  const params = new URLSearchParams({ q, provider })
  if (provider === 'google') params.set('google_key', googleKey)
  // ArcGIS works keyless; the user's own key is optional.
  if (provider === 'arcgis' && arcgisKey) params.set('arcgis_key', arcgisKey)
  return request<any[]>('GET', `/api/geocode/search?${params.toString()}`)
}
// The backend caches reverse results per ~100 m cell. Pass precise=true
// when the label names a saved spot or answers "what's here", so a
// neighbouring lookup's name is never reused.
export const reverseGeocode = (lat: number, lng: number, precise = false) =>
  request<any>('GET', `/api/geocode/reverse?lat=${lat}&lng=${lng}${precise ? '&precise=true' : ''}`)

// Mirror the desktop's geocode provider choice to the backend so the phone
// page (which can't read renderer localStorage) honours the same provider.
export const setGeocodeProviderPref = (provider: string, googleKey: string = '', arcgisKey: string = '') =>
  request<any>('PUT', '/api/geocode/provider-pref', { provider, google_key: googleKey, arcgis_key: arcgisKey })
// Mirrors the desktop's coordinate format (設定 > 座標格式) to the backend so
// the phone control page shows and parses coordinate text the same way.
export const setPhoneCoordFormat = (datum: string, order: string) =>
  request<any>('POST', '/api/phone/coord_format', { datum, order })
// Theme accent as "R, G, B", so the phone control page matches the desktop.
export const setPhoneAppearance = (accentRgb: string) =>
  request<any>('POST', '/api/phone/appearance', { accent_rgb: accentRgb })
// Base map picked in the layer switcher, so the phone control page can
// follow the desktop's choice.
export const setPhoneMapLayer = (key: string) =>
  request<any>('POST', '/api/phone/map_layer', { key })
export const lookupTimezone =(lat: number, lng: number) =>
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
export const routeOptimize = (
  waypoints: { lat: number; lng: number }[],
  profile = 'foot',
  keep_first = true,
  engine = 'osrm',
  straightLine = false,
) =>
  request<{ waypoints: { lat: number; lng: number }[]; total_distance_m: number; total_duration_s: number; used_estimate?: boolean }>(
    'POST', '/api/geocode/route-optimize', { waypoints, profile, keep_first, engine, ...(straightLine ? { straight_line: true } : {}) },
  )

// Bookmarks
export const getBookmarks = () => request<any>('GET', '/api/bookmarks')
export const createBookmark = (bm: any) => request<any>('POST', '/api/bookmarks', bm)
export const updateBookmark = (id: string, bm: any) => request<any>('PUT', `/api/bookmarks/${id}`, bm)
export const deleteBookmark = (id: string) => request<any>('DELETE', `/api/bookmarks/${id}`)
export const moveBookmarks = (ids: string[], catId: string) =>
  request<any>('POST', '/api/bookmarks/move', { bookmark_ids: ids, target_category_id: catId })
export const reorderBookmarks = (categoryId: string, bookmarkIds: string[]) =>
  request<{ reordered: number }>('POST', '/api/bookmarks/reorder', {
    category_id: categoryId,
    bookmark_ids: bookmarkIds,
  })
export const getCategories = () => request<any[]>('GET', '/api/bookmarks/categories')
export const createCategory = (cat: any) => request<any>('POST', '/api/bookmarks/categories', cat)
export const updateCategory = (id: string, cat: any) => request<any>('PUT', `/api/bookmarks/categories/${id}`, cat)
export const deleteCategory = (id: string) => request<any>('DELETE', `/api/bookmarks/categories/${id}`)
export const reorderBookmarkCategories = (categoryIds: string[]) =>
  request<{ reordered: number }>('POST', '/api/bookmarks/categories/reorder', { category_ids: categoryIds })

export const bookmarksExportUrl = () => `${API}/api/bookmarks/export`
export const bookmarkGpxExportUrl = (id: string) => `${API}/api/bookmarks/gpx/export/${id}`
export const bookmarkCategoryGpxExportUrl = (categoryId: string) => `${API}/api/bookmarks/gpx/export/category/${categoryId}`
export const bookmarkCategoriesGpxZipUrl = (categoryIds: string[]) =>
  `${API}/api/bookmarks/gpx/categories/export.zip?ids=${encodeURIComponent(categoryIds.join(','))}`

// Recent places: last 50 flights.
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
export async function importBookmarksGpx(file: File): Promise<{ imported: number }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${API}/api/bookmarks/gpx/import`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(formatError(err.detail, res.statusText))
  }
  return res.json()
}

export const getInitialPosition = () =>
  request<{ position: { lat: number; lng: number } | null }>('GET', '/api/location/settings/initial-position')
export const setInitialPosition = (lat: number | null, lng: number | null) =>
  request<{ position: { lat: number; lng: number } | null }>('PUT', '/api/location/settings/initial-position', { lat, lng })

export const openLog = () => request<{ status: string; path: string }>('POST', '/api/system/open-log')
export const openLogFolder = () => request<{ status: string; path: string }>('POST', '/api/system/open-log-folder')

export const applySpeed = (mode: string, opts: SpeedOpts, udid?: string) =>
  request<{ status: string; speed_mps: number }>('POST', '/api/location/apply-speed', {
    mode,
    speed_kmh: opts.speed_kmh ?? null,
    speed_min_kmh: opts.speed_min_kmh ?? null,
    speed_max_kmh: opts.speed_max_kmh ?? null,
    ...(opts.seed != null ? { seed: opts.seed } : {}),
    ...ud(udid),
  })

// Routes
export const planRoute = (start: any, end: any, profile: string) =>
  request<any>('POST', '/api/route/plan', { start, end, profile })
export const getSavedRoutes = () => request<any[]>('GET', '/api/route/saved')
export const saveRoute = (route: any) => request<any>('POST', '/api/route/saved', route)
// Replace an existing saved route in-place (overwrite-on-save). Keeps the
// original id and created_at, updates everything else.
export const replaceRoute = (id: string, route: any) =>
  request<any>('PUT', `/api/route/saved/${id}`, route)
export const deleteRoute = (id: string) => request<any>('DELETE', `/api/route/saved/${id}`)
export const renameRoute = (id: string, name: string) => request<any>('PATCH', `/api/route/saved/${id}`, { name })
export const moveRoutes = (route_ids: string[], target_category_id: string) =>
  request<{ moved: number }>('POST', '/api/route/saved/move', { route_ids, target_category_id })
export const reorderRoutes = (categoryId: string, routeIds: string[]) =>
  request<{ reordered: number }>('POST', '/api/route/saved/reorder', {
    category_id: categoryId,
    route_ids: routeIds,
  })
export const reorderRouteCategories = (categoryIds: string[]) =>
  request<{ reordered: number }>('POST', '/api/route/categories/reorder', { category_ids: categoryIds })

// Route categories (mirror of bookmark categories)
export const listRouteCategories = () =>
  request<any[]>('GET', '/api/route/categories')
export const createRouteCategory = (name: string, color = '#6c8cff') =>
  request<any>('POST', '/api/route/categories', { name, color })
export const updateRouteCategory = (id: string, fields: { name?: string; color?: string }) =>
  request<any>('PUT', `/api/route/categories/${id}`, { id, name: fields.name ?? '', color: fields.color ?? '#6c8cff' })
export const deleteRouteCategory = (id: string) =>
  request<any>('DELETE', `/api/route/categories/${id}`)

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

export const importAllRoutes = (data: { routes: any[]; categories?: any[] }) =>
  request<{ imported: number }>('POST', '/api/route/saved/import', data)

// ── Pipi Mushroom 蘑菇地圖 overlay ─────────────────────────────────────
// Backend proxies pipimushroom.com with the cookie the user pasted. Errors
// carry a machine-readable `code` so the layer can decide whether to keep
// polling (rate limit / network) or stop (cookie missing / expired).
export type PipiKind = 'mushroom' | 'flower' | 'smoke'
export interface PipiItem {
  id: string
  itemKind: PipiKind | string
  key?: string
  displayName?: string
  title?: string
  sizeName?: string
  state?: string
  bloomedMs?: number
  wiltingMs?: number
  finishMs?: number
  smokeEndMs?: number
  lat: number
  lng: number
  image?: string
}
export interface PipiItemsResponse {
  region: string | null
  items: PipiItem[]
  now_ms: number
  truncated: boolean
}
export interface PipiCookieResult { configured: boolean; logged_in: boolean; error: string | null }

export class PipiApiError extends Error {
  code: string
  status: number
  retryAfter?: number
  constructor(message: string, code: string, status: number, retryAfter?: number) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

// Plain fetch (no fetchWithRetry): viewport requests get aborted on every
// pan, and an AbortError must surface immediately rather than be retried.
async function pipiRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' }, signal }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(`${API}${path}`, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    const d = err.detail && typeof err.detail === 'object' ? err.detail : {}
    throw new PipiApiError(formatError(err.detail, res.statusText), d.code || 'pipi_unavailable', res.status, d.retry_after)
  }
  return res.json()
}

export const describePipiError = (code: string) => formatError({ code }, code)

export interface PipiStatusResponse {
  configured: boolean
  source: 'manual' | 'extension' | null
  updated_at: number | null
  // false: a cookie is stored but the site no longer accepts it.
  logged_in?: boolean | null
}
export const pipiStatus = () => pipiRequest<PipiStatusResponse>('GET', '/api/pipi/status')
export const pipiSetCookie = (cookie: string) => pipiRequest<PipiCookieResult>('PUT', '/api/pipi/cookie', { cookie })
export const pipiClearCookie = () => pipiRequest<{ configured: boolean }>('DELETE', '/api/pipi/cookie')
export const pipiItems = (
  b: { north: number; south: number; east: number; west: number; zoom: number },
  signal?: AbortSignal,
) => {
  const q = new URLSearchParams({
    north: b.north.toFixed(6), south: b.south.toFixed(6),
    east: b.east.toFixed(6), west: b.west.toFixed(6), zoom: String(b.zoom),
  })
  return pipiRequest<PipiItemsResponse>('GET', `/api/pipi/items?${q.toString()}`, undefined, signal)
}
