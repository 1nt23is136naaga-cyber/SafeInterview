const { contextBridge, ipcRenderer } = require('electron');

/**
 * preload.js — Secure bridge between Electron main process and the React app.
 * Exposes only the specific IPC calls the renderer needs.
 */

contextBridge.exposeInMainWorld('electronAPI', {
  // Silent screen capture source (no user dialog in Electron)
  getScreenSource: () => ipcRenderer.invoke('get-screen-source'),

  // Active OS window title (for app-switch integrity monitoring)
  getActiveWindow: () => ipcRenderer.invoke('get-active-window'),

  // Meeting lifecycle
  endMeeting: () => ipcRenderer.send('meeting-ended'),
  quit: () => ipcRenderer.send('quit-app'),

  // Assessment lockdown controls
  enterAssessment: () => ipcRenderer.send('enter-assessment'),
  exitAssessment: () => ipcRenderer.send('exit-assessment'),

  // Environment info
  platform: process.platform,
});
