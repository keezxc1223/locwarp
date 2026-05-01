const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  locatePc: () => ipcRenderer.invoke('locate-pc'),

  // Use the system's native geolocation (macOS CoreLocation / Windows Location)
  // from within the Electron renderer context — no Google API key required.
  // Resolves with { ok, lat, lng, accuracy, via } or { ok: false, error }.
  locateMac: () => new Promise((resolve) => {
    if (!navigator.geolocation) {
      return resolve({ ok: false, error: 'geolocation API not available' })
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        ok: true,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        via: 'system_corelocation',
      }),
      (err) => resolve({ ok: false, error: err.message || String(err.code) }),
      { timeout: 12000, maximumAge: 60000, enableHighAccuracy: true },
    )
  }),
})
