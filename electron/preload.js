'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Expose only the folder chooser, never generic IPC or filesystem access.
contextBridge.exposeInMainWorld('agentdeckDesktop', {
  selectProjectFolder: () => ipcRenderer.invoke('agentdeck:select-project-folder'),
  onPtyF6: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('agentdeck:pty-f6', listener)
    return () => ipcRenderer.removeListener('agentdeck:pty-f6', listener)
  },
})
