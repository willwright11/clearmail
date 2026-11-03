const { contextBridge, ipcRenderer } = require('electron');

// The window's only way to reach the main process (IPC contract H). There is nothing here
// that can delete, move or mark email: ClearMail only reads, and sends the replies the user
// writes. A reply only carries the email's id and the text; main decides where it goes.

// Subscribes fn to a push event from the main process; returns an unsubscribe function.
function listen(channel, fn) {
  const handler = (_e, data) => fn(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const nothing = () => undefined;

contextBridge.exposeInMainWorld('clearmail', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  // { limit, demo, msClientId?, brief: { enabled, time, days, openAtLogin } }; resolves the settings.
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  // Adds (no id) or edits an IMAP account.
  saveAccount: (input) => ipcRenderer.invoke('account:save', input),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  // Opens the browser to sign in; { accountId } signs that account in again.
  signInMicrosoft: (options) => ipcRenderer.invoke('microsoft:signIn', { accountId: (typeof options === 'string' ? options : options?.accountId) || undefined }),
  cancelSignIn: () => ipcRenderer.invoke('microsoft:cancelSignIn').then(nothing),
  openConsentPage: (accountId) => ipcRenderer.invoke('microsoft:openConsentPage', accountId).then(nothing),
  // Resolves a BriefView. { force: true } fetches even if the last load is under a minute old.
  loadInbox: (options) => ipcRenderer.invoke('inbox:load', { force: Boolean(options?.force) }),
  // In Outlook on the web or Mail; main works out where from the email's id.
  openEmail: (id) => ipcRenderer.invoke('email:open', id).then(nothing),
  // Resolves { queued: true, sendAt }: main sends it after 5 seconds unless undoReply is
  // called first. The outcome arrives on onReplyResult.
  reply: (id, body) => ipcRenderer.invoke('email:reply', { id, body }),
  // Resolves { undone: true } if the reply was stopped in time.
  undoReply: (id) => ipcRenderer.invoke('email:undoReply', { id }),
  openLink: (url) => ipcRenderer.invoke('link:open', url).then(nothing),
  // Sorting changes (kept in ClearMail only, never in the mailbox); each resolves a BriefView.
  // rule: 'important', 'noise' or null to remove the rule.
  setRule: (address, rule) => ipcRenderer.invoke('triage:setRule', { address, rule: rule ?? null }),
  setNotNoise: (id, on) => ipcRenderer.invoke('triage:notNoise', { id, on: on === true }),
  setDone: (ids, on) => ipcRenderer.invoke('triage:done', { ids: [].concat(ids || []), on: on === true }),
  // Hands over the Done marks ClearMail 0.2 kept in this window's storage.
  importDone: (map) => ipcRenderer.invoke('triage:importDone', map),
  testBrief: () => ipcRenderer.invoke('brief:test'),
  briefStatus: () => ipcRenderer.invoke('brief:status'),
  // 'notifications' or 'login-items' only.
  openSystemSettings: (which) => ipcRenderer.invoke('system:openSettings', which).then(nothing),
  onBriefShow: (fn) => listen('brief:show', fn),
  onInboxUpdated: (fn) => listen('inbox:updated', fn),
  onReplyResult: (fn) => listen('reply:result', fn),
});
