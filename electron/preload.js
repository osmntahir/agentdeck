'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Expose only the folder chooser, never generic IPC or filesystem access.
contextBridge.exposeInMainWorld('agentdeckDesktop', {
  notify: (notice) => ipcRenderer.invoke('agentdeck:notify', notice),
  onNotificationClick: (cb) => {
    const listener = (_event, sessionId) => cb(sessionId)
    ipcRenderer.on('agentdeck:notification-click', listener)
    return () => ipcRenderer.removeListener('agentdeck:notification-click', listener)
  },
  selectProjectFolder: () => ipcRenderer.invoke('agentdeck:select-project-folder'),
  onPtyF6: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('agentdeck:pty-f6', listener)
    return () => ipcRenderer.removeListener('agentdeck:pty-f6', listener)
  },
})
