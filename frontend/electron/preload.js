const { contextBridge, ipcRenderer } = require('electron')

// Minimal safe bridge for the auto-update flow. Everything else goes over
// the existing HTTP / WebSocket transport to the backend.
contextBridge.exposeInMainWorld('locwarpUpdater', {
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  quitAndInstall: () => ipcRenderer.invoke('updater:install'),
  onEvent: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('updater:event', listener)
    return () => ipcRenderer.removeListener('updater:event', listener)
  },
})
