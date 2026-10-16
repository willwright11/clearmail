const { contextBridge, ipcRenderer } = require('electron');

// Subscribes fn to a push event from the main process; returns an unsubscribe function.
function listen(channel, fn) {
  const handler = (_e, data) => fn(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('clearmail', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  loadInbox: () => ipcRenderer.invoke('inbox:load'),
  // One call per opened conversation with all its unread ids; rejects if the server refused.
  markSeen: (ids) => ipcRenderer.invoke('email:markSeen', [].concat(ids || [])).then(() => undefined),
  reply: (id, body) => ipcRenderer.invoke('email:reply', { id, body }),
  openLink: (url) => ipcRenderer.invoke('link:open', url).then(() => undefined),
  onSummary: (fn) => listen('summary:update', fn),
  onAiStatus: (fn) => listen('ai:status', fn),
});
