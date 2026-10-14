const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clearmail', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  loadInbox: () => ipcRenderer.invoke('inbox:load'),
  markSeen: (id) => ipcRenderer.invoke('email:markSeen', id),
  reply: (id, body) => ipcRenderer.invoke('email:reply', { id, body }),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  onSummary: (fn) => ipcRenderer.on('summary:update', (_e, data) => fn(data)),
});
