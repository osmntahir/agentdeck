'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Expose only the folder chooser, never generic IPC or filesystem access.
contextBridge.exposeInMainWorld('agentdeckDesktop', {
  selectProjectFolder: () => ipcRenderer.invoke('agentdeck:select-project-folder'),
})
