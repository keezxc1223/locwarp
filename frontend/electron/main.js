const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')

// Locate-PC over IPC: shells out to PowerShell + System.Device.Location
// (the Windows Location API). This taps Windows' built-in Wi-Fi
// positioning + GPS without needing a Google API key (which Electron's
// navigator.geolocation requires) or any third-party HTTP service.
// Accuracy in urban areas is typically 30-100m; rural ~500m.
const LOCATE_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Device
  $watcher = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
  $watcher.Start()
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
    if ($watcher.Status -eq 'Ready' -and -not $watcher.Position.Location.IsUnknown) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
  $loc = $watcher.Position.Location
  if ($loc.IsUnknown) { Write-Output ('NODATA,status=' + $watcher.Status); exit 0 }
  Write-Output ('OK,' + $loc.Latitude + ',' + $loc.Longitude + ',' + $loc.HorizontalAccuracy)
  $watcher.Stop()
} catch {
  Write-Output ('ERROR,' + $_.Exception.Message)
}
`

// Run an HTTPS GET from the Electron main process (no renderer CORS,
// no Content-Security-Policy block) and return the parsed JSON. Used
// by the IP-geolocation fallback chain inside the locate-pc handler.
const httpsGetJson = (url) => {
  return new Promise((resolve) => {
    const https = require('https')
    const req = https.get(url, { headers: { 'User-Agent': 'LocWarp-Electron' }, timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return resolve(null)
      }
      let chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { try { req.destroy() } catch {} ; resolve(null) })
  })
}

const ipFallback = async () => {
  // ipwho.is — no key, no signup, HTTPS, returns latitude/longitude in JSON.
  const a = await httpsGetJson('https://ipwho.is/')
  if (a && typeof a.latitude === 'number' && typeof a.longitude === 'number') {
    return { ok: true, lat: a.latitude, lng: a.longitude, accuracy: 5000, via: 'ipwho.is' }
  }
  // ipapi.co — backup, also no key.
  const b = await httpsGetJson('https://ipapi.co/json/')
  if (b && b.latitude != null && b.longitude != null) {
    const lat = parseFloat(b.latitude); const lng = parseFloat(b.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { ok: true, lat, lng, accuracy: 5000, via: 'ipapi.co' }
    }
  }
  // freeipapi.com — last resort.
  const c = await httpsGetJson('https://freeipapi.com/api/json/')
  if (c && c.latitude != null && c.longitude != null) {
    const lat = parseFloat(c.latitude); const lng = parseFloat(c.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { ok: true, lat, lng, accuracy: 5000, via: 'freeipapi.com' }
    }
  }
  return null
}

const tryWindowsLocation = () => {
  return new Promise((resolve) => {
    let settled = false
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload) } }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LOCATE_PS_SCRIPT],
      { windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => console.error('[locate-pc] stderr:', d.toString('utf8')))
    child.on('error', (e) => finish({ ok: false, code: 'SPAWN_FAILED', message: e.message }))
    child.on('exit', () => {
      const trimmed = out.trim()
      if (trimmed.startsWith('OK,')) {
        const parts = trimmed.split(',')
        const lat = parseFloat(parts[1])
        const lng = parseFloat(parts[2])
        const acc = parseFloat(parts[3])
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return finish({ ok: true, lat, lng, accuracy: Number.isFinite(acc) ? acc : 100 })
        }
      }
      if (trimmed === 'DENIED') return finish({ ok: false, code: 'DENIED', message: 'Windows Location service is off or app access denied' })
      if (trimmed.startsWith('NODATA')) return finish({ ok: false, code: 'NODATA', message: trimmed.slice(0, 200) })
      if (trimmed.startsWith('ERROR,')) return finish({ ok: false, code: 'ERROR', message: trimmed.slice(6, 200) })
      finish({ ok: false, code: 'UNKNOWN', message: trimmed.slice(0, 200) || 'no PowerShell output' })
    })
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, code: 'TIMEOUT', message: 'PowerShell timed out after 18s' })
    }, 18000)
  })
}

ipcMain.handle('locate-pc', async () => {
  // On macOS/Linux there is no PowerShell — skip straight to IP fallback.
  // On Windows we try the native Location API first (better accuracy),
  // then fall back to IP geolocation if it fails or is denied.
  if (process.platform === 'win32') {
    const win = await tryWindowsLocation()
    if (win.ok) return { ...win, via: 'windows' }
    if (win.code === 'DENIED') return win
    // Windows Location returned NODATA / TIMEOUT / ERROR / UNKNOWN.
    // Fall back to IP geolocation.
    const ip = await ipFallback()
    if (ip) return ip
    return {
      ok: false,
      code: 'ALL_FAILED',
      message: `Windows Location: ${win.code}${win.message ? ' (' + win.message + ')' : ''} | IP fallback: all 3 services unreachable`,
    }
  }

  // macOS / Linux: IP-geolocation only (city-level, ~5 km accuracy).
  const ip = await ipFallback()
  if (ip) return ip
  return {
    ok: false,
    code: 'ALL_FAILED',
    message: 'IP geolocation: all 3 services unreachable — check network connection',
  }
})

// Strip the default "File Edit View Window Help" menubar — LocWarp has its
// own in-window controls and the native menu only adds noise on Windows.
Menu.setApplicationMenu(null)

let mainWindow
let backendProc = null

function resolveBackendExe() {
  // In a packaged build, extraResources places files under process.resourcesPath.
  // In dev, we don't spawn; the developer runs `python main.py` manually.
  if (app.isPackaged) {
    const binaryName = process.platform === 'win32' ? 'locwarp-backend.exe' : 'locwarp-backend'
    return path.join(process.resourcesPath, 'backend', binaryName)
  }
  return null
}

function startBackend() {
  const exe = resolveBackendExe()
  if (!exe) return
  console.log('[electron] spawning backend:', exe)

  if (process.platform === 'darwin') {
    // iOS 17+ requires root to create utun interfaces — request elevation
    // via osascript so macOS shows the standard password dialog.
    const script = `do shell script "${exe.replace(/"/g, '\\"')}" with administrator privileges`
    backendProc = spawn('osascript', ['-e', script], {
      cwd: path.dirname(exe),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    backendProc = spawn(exe, [], {
      cwd: path.dirname(exe),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backendProc.on('exit', (code) => {
    console.log('[electron] backend exited with code', code)
    backendProc = null
  })
}

function stopBackend() {
  if (!backendProc) return
  try { backendProc.kill() } catch {}
  backendProc = null
}

function waitForBackend(timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get('http://127.0.0.1:8777/docs', (res) => {
        res.destroy()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return reject(new Error('backend timeout'))
        setTimeout(tick, 500)
      })
    }
    tick()
  })
}

async function createWindow() {
  // OSM tile policy (https://operations.osmfoundation.org/policies/tiles/)
  // requires an identifying User-Agent; Electron's default Chrome UA is
  // blocked with HTTP 418. Rewrite the UA on requests to the OSM tile
  // endpoints so we can use the 'Standard' (Mapnik) style for free.
  try {
    const { session } = require('electron')
    const OSM_HOSTS = [
      'tile.openstreetmap.org',
      'a.tile.openstreetmap.org',
      'b.tile.openstreetmap.org',
      'c.tile.openstreetmap.org',
      'tile.openstreetmap.fr',
      'a.tile.openstreetmap.fr',
      'b.tile.openstreetmap.fr',
      'c.tile.openstreetmap.fr',
    ]
    session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
      try {
        const u = new URL(details.url)
        if (OSM_HOSTS.includes(u.hostname)) {
          details.requestHeaders['User-Agent'] =
            'LocWarp/0.1.49 (+https://github.com/keezxc1223/locwarp)'
          details.requestHeaders['Referer'] = 'https://github.com/keezxc1223/locwarp'
        }
      } catch {}
      cb({ requestHeaders: details.requestHeaders })
    })
  } catch (e) { console.error('[electron] UA hook failed:', e) }

  // Allow the renderer to use navigator.geolocation (uses macOS CoreLocation
  // or Windows Location internally — no Google API key required).
  // The OS will show its own permission dialog on first use; after the user
  // grants it, subsequent requests are answered from the permission store.
  try {
    const { session } = require('electron')
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'geolocation') {
        callback(true) // hand off to the OS permission dialog
      } else {
        callback(false)
      }
    })
    // Some Electron versions also check this for inline permission queries.
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return permission === 'geolocation'
    })
  } catch (e) { console.error('[electron] permission handler failed:', e) }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LocWarp',
    // Match the app's dark theme so the initial frame isn't white while
    // the renderer attaches — previously caused a jarring white flash.
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  // Show the window once the first frame is painted. Combined with
  // backgroundColor above, this eliminates the blank/white boot state.
  mainWindow.once('ready-to-show', () => { mainWindow.show() })

  // Open target="_blank" / external links in the user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  const isDev = process.argv.includes('--dev') || !app.isPackaged
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    // Spawn the backend in parallel and load the UI immediately. The
    // renderer already has fetch-with-retry so it rides out the backend
    // startup race — no need to block loadFile on waitForBackend() and
    // stare at a blank window for seconds.
    startBackend()
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', stopBackend)
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
