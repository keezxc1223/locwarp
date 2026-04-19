const { app, BrowserWindow, shell, powerSaveBlocker } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')

let mainWindow
let backendProc = null
let powerSaveId = -1  // powerSaveBlocker ID for App Nap prevention

// ── Cross-platform backend binary resolution ──────────────────────────────
function resolveBackendExe() {
  if (!app.isPackaged) return null   // dev: run `python main.py` manually

  const platform = process.platform
  // Binary name: Windows = locwarp-backend.exe, macOS/Linux = locwarp-backend
  const binaryName = platform === 'win32' ? 'locwarp-backend.exe' : 'locwarp-backend'
  return path.join(process.resourcesPath, 'backend', binaryName)
}

function resolveWifiTunnelExe() {
  if (!app.isPackaged) return null
  const platform = process.platform
  const binaryName = platform === 'win32' ? 'wifi-tunnel.exe' : 'wifi-tunnel'
  return path.join(process.resourcesPath, 'wifi-tunnel', binaryName)
}

// ── Backend lifecycle ─────────────────────────────────────────────────────
function startBackend() {
  const exe = resolveBackendExe()
  if (!exe) return

  console.log('[electron] spawning backend:', exe)

  const spawnOpts = {
    cwd: path.dirname(exe),
    stdio: ['ignore', 'pipe', 'pipe'],
  }

  // windowsHide is only meaningful on Windows; omit on macOS/Linux
  if (process.platform === 'win32') {
    spawnOpts.windowsHide = true
  }

  backendProc = spawn(exe, [], spawnOpts)
  backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backendProc.on('exit', (code, signal) => {
    console.log('[electron] backend exited — code:', code, 'signal:', signal)
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
      req.setTimeout(1000, () => req.destroy())
    }
    tick()
  })
}

// ── Window creation ───────────────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LocWarp',
    // macOS: use native traffic-light buttons
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // Open target="_blank" / external links in the user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  // ── Prevent App Nap: GPS ticks must keep firing even when window is hidden
  // 'prevent-app-suspension' stops macOS from throttling us when minimized
  powerSaveId = powerSaveBlocker.start('prevent-app-suspension')
  console.log('[electron] powerSaveBlocker started, id:', powerSaveId)

  const isDev = process.argv.includes('--dev') || !app.isPackaged
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    startBackend()
    try {
      await waitForBackend()
    } catch (err) {
      console.error('[electron] backend did not come up:', err)
    }
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  stopBackend()
  // Release the power save blocker
  if (powerSaveId !== -1 && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId)
    powerSaveId = -1
  }
  // On macOS, apps conventionally stay in the Dock until explicitly quit
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopBackend()
})

app.on('activate', () => {
  // On macOS, re-create the window when the dock icon is clicked and no windows open
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
