'use strict';

// Settings: accounts, the morning brief, sorting rules and general options.
// Accounts are saved as soon as they are added, edited, removed or signed in to, and sorting
// rules as soon as one is removed. The morning brief and General are saved with Save.
// Closing Settings reloads the inbox if anything about the accounts changed.

const PORTS = { imap: { tls: '993', starttls: '143' }, smtp: { tls: '465', starttls: '587' } };
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first, as getDay() numbers
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const READ_WRITE_RE = /Mail\.ReadWrite/i;

let settingsOpening = false;
let saving = false;
let settingsView = null; // what Settings shows (getSettings: never any secret)
let briefStatus = null; // brief:status
let accountsChanged = false; // reload the inbox when Settings closes
let signIn = null; // { accountId, cancelled } while the Microsoft sign-in is open in the browser
let setupFor = null; // { accountId } while asking for the Microsoft app ID before signing in
let confirmRemove = null; // id of the account whose Remove waits for "Remove" or "Keep"
let editing = null; // the IMAP account in the account form, or null when adding one
let accountBusy = false; // an account change is on its way to the main process
let ruleBusy = null; // the rule being removed
const fresh = new Map(); // account id -> 'Added.' | 'Saved.' | 'Signed in.' since Settings opened

const dialogOpen = () => $('settings').open;

function showBox(id, text) {
  const box = $(id);
  box.textContent = text;
  box.hidden = !text;
  if (text) box.scrollIntoView({ block: 'nearest' });
}

const showSettingsError = (text) => showBox('settings-error', text);
const showFormError = (text) => showBox('account-error', text);
const showSetupError = (text) => showBox('ms-setup-error', text);

function accountsMessage({ ok = '', error = '' } = {}) {
  showBox('accounts-status', ok);
  showBox('accounts-error', error);
}

// An account was added, changed or removed: the inbox must load again.
function accountsDidChange() {
  accountsChanged = true;
  if (!dialogOpen()) {
    accountsChanged = false;
    load({ force: true });
  }
}

function tidyRules(raw) {
  const entries = Array.isArray(raw) ? raw.map((r) => [str(r?.address), r?.rule])
    : raw && typeof raw === 'object' ? Object.entries(raw) : [];
  return entries.filter(([k, v]) => k && (v === 'important' || v === 'noise'))
    .map(([address, rule]) => ({ address, rule }))
    .sort((a, b) => a.address.replace(/^@/, '').localeCompare(b.address.replace(/^@/, '')));
}

function tidyBriefSettings(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const days = arr(b.days).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return {
    enabled: Boolean(b.enabled),
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(str(b.time)) ? b.time : '07:30',
    days: Array.isArray(b.days) ? days : [0, 1, 2, 3, 4, 5, 6],
    openAtLogin: Boolean(b.openAtLogin),
  };
}

function tidySettings(s) {
  const v = s && typeof s === 'object' ? s : {};
  return {
    accounts: arr(v.accounts).filter((a) => typeof a?.id === 'string' && a.id).map((a) => ({
      ...a,
      kind: a.kind === 'microsoft' ? 'microsoft' : 'imap',
      email: str(a.email) || str(a.user) || '(no address)',
      name: str(a.name),
      grantedScopes: arr(a.grantedScopes).map(str),
      upgrade: str(a.upgrade) || null,
      personal: a.personal === true ? true : a.personal === false ? false : null,
    })),
    limit: v.limit,
    demoChosen: Boolean(v.demoChosen),
    demoActive: Boolean(v.demoActive),
    demoReason: v.demoReason || null,
    secretsLocked: Boolean(v.secretsLocked),
    providers: v.providers && typeof v.providers === 'object' ? v.providers : {},
    msClientId: str(v.msClientId),
    msClientIdBuiltIn: Boolean(v.msClientIdBuiltIn),
    brief: tidyBriefSettings(v.brief),
    rules: tidyRules(v.rules),
    canSee: v.canSee ?? null,
  };
}

const hasClientId = () => Boolean(settingsView?.msClientId || settingsView?.msClientIdBuiltIn);

function kindLabel(a) {
  if (a.kind === 'microsoft') return 'Outlook';
  const providers = settingsView?.providers || {};
  return (Object.hasOwn(providers, a.provider) && str(providers[a.provider])) || 'Other';
}

// ---------- accounts ----------

// What an account's row says: { tone: 'ok'|'warn'|'muted', text, signIn (offer the button),
// consent (offer Microsoft's permissions page), perm (the "can read and reply" line) }.
function accountStatus(a) {
  const note = fresh.get(a.id);
  const loaded = note ? null : state.accounts.find((x) => x.id === a.id); // a fresh change makes the last load's news stale
  let perm = null;
  if (a.kind === 'microsoft') {
    if (a.locked && !a.signedIn) {
      return { tone: 'warn', text: "ClearMail couldn't unlock this sign-in from the macOS Keychain. Sign in again to fix it.", signIn: true };
    }
    if (a.upgrade === 'reconnect') {
      return { tone: 'warn', text: 'ClearMail no longer needs permission to change your mailbox. Click Sign in again.', signIn: true };
    }
    if (a.needsSignIn) {
      return { tone: 'warn', text: loaded?.error || (a.signedIn ? 'Microsoft needs you to sign in again.' : "Signing in wasn't finished."), signIn: true };
    }
    if (a.grantedScopes.some((s) => READ_WRITE_RE.test(s))) {
      return {
        tone: 'warn',
        text: "Microsoft still lets ClearMail change this mailbox, because of an old permission. ClearMail never uses it, but you can remove it: open Microsoft's permissions page, remove ClearMail, then click Sign in again.",
        consent: true,
        signIn: true,
      };
    }
    perm = "Can read and reply · can't delete or move ✓";
  } else if (!a.hasPass) {
    return a.locked
      ? { tone: 'warn', text: "ClearMail couldn't unlock the saved app password from the macOS Keychain. Click Edit and type it again." }
      : { tone: 'warn', text: 'No app password saved yet. Click Edit to add it.' };
  }
  if (loaded?.error) return { tone: 'warn', text: loaded.error, perm };
  if (settingsView?.demoActive) return { tone: 'muted', text: 'Not loaded while Demo mode is on.', perm };
  if (note) return { tone: 'ok', text: `${note} Its email loads when you close Settings.`, perm };
  if (loaded) return { tone: 'ok', text: '✓ Working', perm };
  return { tone: 'muted', text: 'Not loaded yet.', perm };
}

function focusAccount(id, act, fallback = true) {
  const row = id ? $('account-list').querySelector(`[data-id="${CSS.escape(id)}"]`) : null;
  const exact = act ? row?.querySelector(`[data-act="${act}"]:not(:disabled)`) : null;
  const target = exact || (fallback ? row?.querySelector('button:not(:disabled)') || $('add-microsoft') : null);
  if (target && !target.closest('[hidden]')) target.focus();
}

function openConsent(a) {
  Promise.resolve().then(() => clearmail.openConsentPage(a.id))
    .catch((err) => accountsMessage({ error: `Couldn't open Microsoft's permissions page: ${errText(err)}` }));
}

function accountRow(a) {
  const status = accountStatus(a);
  const busy = Boolean(signIn) || accountBusy;
  const confirming = confirmRemove === a.id;
  const keep = () => {
    confirmRemove = null;
    renderAccounts();
    focusAccount(a.id, 'remove');
  };
  return el('li', { class: 'account', 'data-id': a.id },
    avatar(a.email, a.email),
    el('div', { class: 'account-main' },
      el('div', { class: 'account-top' },
        el('span', { class: 'account-email', title: a.name ? `${a.name} <${a.email}>` : a.email }, a.email),
        el('span', { class: `kind kind-${a.kind}` }, kindLabel(a))),
      status.perm ? el('p', { class: 'account-perm' }, status.perm) : null,
      el('p', { class: `account-status is-${status.tone}` }, status.text),
      status.signIn || status.consent ? el('div', { class: 'account-buttons' },
        status.consent ? el('button', {
          type: 'button', class: 'small-btn', 'data-act': 'consent', disabled: busy, onclick: () => openConsent(a),
        }, "Open Microsoft's permissions page") : null,
        status.signIn ? el('button', {
          type: 'button', class: `small-btn${status.consent ? '' : ' primary'}`, 'data-act': 'signin', disabled: busy,
          'aria-label': `Sign in again to ${a.email}`, onclick: () => startSignIn(a.id),
        }, 'Sign in again') : null) : null,
      confirming ? el('div', { class: 'account-confirm', role: 'group', 'aria-label': `Remove ${a.email}?` },
        el('p', {}, `Remove ${a.email} from ClearMail? Its emails leave ClearMail. Nothing is deleted from the mailbox itself.`),
        el('div', { class: 'confirm-actions' },
          el('button', { type: 'button', class: 'small-btn danger', 'data-act': 'remove-yes', disabled: busy, onclick: () => removeAccount(a.id) }, 'Remove'),
          el('button', { type: 'button', class: 'small-btn', 'data-act': 'remove-no', onclick: keep }, 'Keep'))) : null),
    el('div', { class: 'account-actions' },
      a.kind === 'imap' ? el('button', {
        type: 'button', class: 'linkish', 'data-act': 'edit', disabled: busy, 'aria-label': `Edit ${a.email}`, onclick: () => openAccountForm(a),
      }, 'Edit') : null,
      el('button', {
        type: 'button', class: 'linkish danger-text', 'data-act': 'remove', disabled: busy || confirming,
        'aria-label': `Remove ${a.email}`, onclick: () => askRemove(a.id),
      }, 'Remove')));
}

function renderAccounts() {
  if (!settingsView) return;
  const list = $('account-list');
  // Rebuilding the list mustn't lose the keyboard focus.
  const active = document.activeElement;
  const focusId = active?.closest?.('#account-list .account')?.dataset.id;
  const focusAct = active?.dataset?.act;
  list.replaceChildren(...settingsView.accounts.map(accountRow));
  if (!settingsView.accounts.length) {
    list.append(el('li', { class: 'account-empty' }, 'No accounts yet. Add one below to see your own email instead of the sample emails.'));
  }
  if (focusId) focusAccount(focusId, focusAct, false);

  $('secrets-locked').hidden = !settingsView.secretsLocked;
  $('ms-wait').hidden = !signIn;
  $('ms-cancel').disabled = Boolean(signIn?.cancelled);
  $('ms-wait').querySelector('.ms-wait-text').textContent = signIn?.cancelled ? 'Cancelling…' : 'Finish signing in in your browser…';
  $('ms-setup').hidden = !setupFor;
  $('add-buttons').hidden = Boolean(signIn || setupFor);
  for (const id of ['add-microsoft', 'add-imap']) $(id).disabled = accountBusy;
}

// ---------- sorting rules ----------

function ruleLabel(address) {
  return address.startsWith('@') ? `Anyone at ${address.slice(1)}` : address;
}

function renderRules() {
  if (!settingsView) return;
  const list = $('rule-list');
  const rules = settingsView.rules;
  list.replaceChildren(...rules.map((r) => el('li', { class: 'rule', 'data-rule': r.address },
    el('span', { class: 'rule-who', title: r.address }, ruleLabel(r.address)),
    el('span', { class: `rule-what is-${r.rule}` }, r.rule === 'important' ? 'Always important' : 'Always noise'),
    el('button', {
      type: 'button', class: 'linkish danger-text', 'data-act': 'remove-rule', disabled: Boolean(ruleBusy),
      'aria-label': `Remove the rule for ${ruleLabel(r.address)}`, onclick: () => removeRule(r),
    }, 'Remove'))));
  if (!rules.length) {
    list.append(el('li', { class: 'rule-empty' },
      'No rules yet. To add one, click ⋯ on an email in the Brief and choose Always important or Always noise.'));
  }
}

async function removeRule(r) {
  if (ruleBusy) return;
  ruleBusy = r.address;
  showBox('rules-status', '');
  renderRules();
  try {
    await viewAction(() => clearmail.setRule(r.address, null));
    if (settingsView) settingsView.rules = settingsView.rules.filter((x) => x.address !== r.address);
    showBox('rules-status', `Removed the rule for ${ruleLabel(r.address)}. Its emails are sorted as usual again.`);
  } catch (err) {
    showBox('rules-status', `Couldn't remove the rule: ${errText(err)}`);
  } finally {
    ruleBusy = null;
    renderRules();
    $('rule-list').querySelector('button:not(:disabled)')?.focus();
  }
}

// ---------- the morning brief ----------

function fillBrief(b) {
  const f = $('settings-form').elements;
  f.briefEnabled.checked = b.enabled;
  f.briefTime.value = b.time;
  for (const box of $('brief-days').querySelectorAll('input')) box.checked = b.days.includes(Number(box.value));
  f.openAtLogin.checked = b.openAtLogin;
  briefFieldsState();
}

function briefFromForm() {
  const f = $('settings-form').elements;
  return {
    enabled: f.briefEnabled.checked,
    time: f.briefTime.value,
    days: [...$('brief-days').querySelectorAll('input:checked')].map((box) => Number(box.value)),
    openAtLogin: f.openAtLogin.checked,
  };
}

// The time and days are dimmed while the brief is off (still editable).
function briefFieldsState() {
  $('brief-fields').classList.toggle('off', !$('settings-form').elements.briefEnabled.checked);
}

const LOGIN_TEXT = {
  enabled: '✓ ClearMail opens when you log in.',
  'requires-approval': 'Approve ClearMail in System Settings → General → Login Items.',
  'not-registered': "macOS didn't accept it (ClearMail isn't notarised). Add ClearMail yourself: System Settings → General → Login Items → +",
  'not-found': "macOS didn't accept it (ClearMail isn't notarised). Add ClearMail yourself: System Settings → General → Login Items → +",
};

function renderBriefStatus() {
  const s = briefStatus && typeof briefStatus === 'object' ? briefStatus : null;
  const saved = settingsView?.brief;
  const next = toMs(s?.nextAt);
  let line = '';
  if (s || saved) {
    const enabled = s && typeof s.enabled === 'boolean' ? s.enabled : Boolean(saved?.enabled);
    if (!enabled) line = 'The morning brief is off.';
    else if (str(s?.paused)) line = str(s.paused);
    else if (!Number.isNaN(next)) line = `Next brief: ${whenLabel(next)}.`;
    else line = 'No brief is planned. Check the days you chose.';
  }
  $('next-brief').textContent = line;
  $('next-brief').hidden = !line;

  const lastError = str(s?.lastError);
  showBox('brief-problem', lastError ? `The last brief had a problem: ${lastError}` : '');
  $('notifications-blocked').hidden = !s?.notificationsBlocked;

  // Open at login: only says something once it's been asked for.
  const login = s?.loginItem && typeof s.loginItem === 'object' ? s.loginItem : null;
  const wanted = Boolean(saved?.openAtLogin);
  const status = str(login?.status);
  const text = wanted && status && status !== 'off' ? str(login.message) || LOGIN_TEXT[status] || '' : '';
  $('login-status').textContent = text;
  $('login-status').hidden = !text;
  $('login-status').classList.toggle('is-ok', status === 'enabled');
  $('open-login-items').hidden = !text || status === 'enabled';
}

async function refreshBriefStatus() {
  try {
    briefStatus = await clearmail.briefStatus();
  } catch {
    briefStatus = null; // the section still shows the saved settings
  }
  if (dialogOpen()) renderBriefStatus();
}

let testTimer = null;
async function sendTestBrief() {
  const btn = $('brief-test');
  btn.disabled = true;
  $('brief-test-status').textContent = 'Sending…';
  clearTimeout(testTimer);
  try {
    const res = await clearmail.testBrief();
    if (res && res.ok === false) throw new Error(str(res.error) || "The test brief couldn't be shown.");
    $('brief-test-status').textContent = "Sent. If no notification appeared, check that notifications are on for ClearMail.";
  } catch (err) {
    $('brief-test-status').textContent = `Couldn't send a test brief: ${errText(err)}`;
  } finally {
    btn.disabled = false;
  }
  // macOS reports a blocked notification a moment later.
  testTimer = setTimeout(refreshBriefStatus, 1500);
}

function openSystemSettings(which) {
  Promise.resolve().then(() => clearmail.openSystemSettings(which))
    .catch((err) => showSettingsError(`Couldn't open System Settings: ${errText(err)}`));
}

// ---------- What ClearMail can see ----------

function canSeeText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(' · ');
  if (!v || typeof v !== 'object') return '';
  const parts = [];
  if (num(v.emails) != null) parts.push(plural(v.emails, 'email'));
  if (num(v.withListHeaders) != null) parts.push(`${v.withListHeaders} with mailing-list headers`);
  if (typeof v.focusedOther === 'boolean') parts.push(v.focusedOther ? 'Focused/Other available' : 'Focused/Other not available');
  if (num(v.people) != null) parts.push(`${plural(v.people, 'person', 'people')} in Sent history`);
  return parts.join(', ');
}

function renderCanSee() {
  const text = canSeeText(settingsView?.canSee);
  $('can-see').textContent = text || 'Nothing loaded yet. Close Settings to load your email, then look again.';
}

// ---------- opening and filling in Settings ----------

function applySettings(s) {
  const before = settingsView?.msClientId || '';
  settingsView = tidySettings(s);
  // The app ID field in Advanced follows a newly saved ID, unless the user is editing it.
  const field = $('settings-form').elements.msClientId;
  if (field.value.trim() === before) field.value = settingsView.msClientId;
  $('ms-id-hint').textContent = settingsView.msClientIdBuiltIn
    ? 'This copy of ClearMail has a Microsoft app ID built in. Only fill this in to use a different one.'
    : 'Needed for Outlook and Microsoft 365 accounts. See "Using Outlook" in the README for the 5-minute setup.';
  renderAccounts();
  renderRules();
  renderCanSee();
  renderBriefStatus();
}

// Called after every inbox load: account statuses and the readout may have changed.
async function settingsLoaded() {
  if (!dialogOpen() || !settingsView) return;
  renderAccounts();
  try {
    const s = tidySettings(await clearmail.getSettings());
    if (settingsView) {
      settingsView.canSee = s.canSee;
      renderCanSee();
    }
  } catch { /* keep what's shown */ }
}

// options.signIn: an account id to sign in again straight away.
async function openSettings(options = {}) {
  if (dialogOpen()) {
    if (options.signIn) startSignIn(options.signIn);
    return;
  }
  if (settingsOpening) return;
  settingsOpening = true;
  let s;
  try {
    s = await clearmail.getSettings();
  } catch (err) {
    notice(`Couldn't open Settings: ${errText(err)}`);
    return;
  } finally {
    settingsOpening = false;
  }
  accountsChanged = false;
  fresh.clear();
  setupFor = null;
  confirmRemove = null;
  editing = null;
  settingsView = null;
  briefStatus = null;
  const f = $('settings-form').elements;
  f.limit.value = s?.limit ?? '';
  f.demo.checked = Boolean(s?.demoChosen);
  f.msClientId.value = '';
  fillBrief(tidyBriefSettings(s?.brief));
  $('demo-flag').hidden = s?.demoReason !== 'flag';
  $('advanced').open = false;
  $('settings-cancel').textContent = 'Close';
  $('account-form').hidden = true;
  $('settings-main').hidden = false;
  $('brief-test-status').textContent = '';
  showBox('rules-status', '');
  showBox('settings-saved', '');
  applySettings(s);
  accountsMessage();
  showSettingsError('');
  $('settings').returnValue = '';
  $('settings').showModal();
  $('settings').scrollTop = 0;
  refreshBriefStatus();
  if (options.signIn) startSignIn(options.signIn);
}

// ---------- Microsoft sign-in ----------

// accountId: sign that account in again; null adds a new account.
async function startSignIn(accountId = null) {
  if (!settingsView || signIn || accountBusy) return;
  if (accountId && !settingsView.accounts.some((a) => a.id === accountId && a.kind === 'microsoft')) return;
  accountsMessage();
  confirmRemove = null;
  if (!hasClientId()) {
    showSetup(accountId);
    return;
  }
  const run = { accountId, cancelled: false };
  signIn = run;
  setupFor = null;
  renderAccounts();
  $('ms-cancel').focus();
  const before = new Set(settingsView.accounts.map((a) => a.id));
  const waiting = new Set(settingsView.accounts.filter((a) => a.needsSignIn).map((a) => a.id));
  let s;
  try {
    s = await clearmail.signInMicrosoft(accountId ? { accountId } : {});
  } catch (err) {
    if (signIn === run) signIn = null;
    const text = errText(err);
    if (!dialogOpen()) {
      if (!run.cancelled) notice(`Couldn't sign in to Microsoft: ${text}`);
      return;
    }
    renderAccounts();
    if (!run.cancelled) accountsMessage({ error: text }); // cancelling needs no message
    focusAccount(accountId, 'signin');
    return;
  }
  if (signIn === run) signIn = null;
  const view = tidySettings(s);
  // The account signed in to: the one asked for, a new one, or one that needed it.
  const account = view.accounts.find((a) => a.id === accountId)
    || view.accounts.find((a) => a.kind === 'microsoft' && !before.has(a.id))
    || view.accounts.find((a) => waiting.has(a.id) && !a.needsSignIn);
  if (account) fresh.set(account.id, 'Signed in.');
  const text = account ? `Signed in to ${account.email}.` : 'Signed in.';
  if (!dialogOpen()) notice(text);
  accountsDidChange();
  if (!dialogOpen()) return;
  applySettings(s);
  accountsMessage({ ok: `${text} Its email loads when you close Settings.` });
  focusAccount(account?.id);
}

function cancelSignIn() {
  if (!signIn || signIn.cancelled) return;
  signIn.cancelled = true;
  renderAccounts();
  Promise.resolve().then(() => clearmail.cancelSignIn()).catch((err) => {
    if (dialogOpen()) accountsMessage({ error: `Couldn't cancel signing in: ${errText(err)}` });
  });
}

// No Microsoft app ID yet: ask for one, then sign in.
function showSetup(accountId) {
  setupFor = { accountId };
  $('ms-client-id').value = '';
  showSetupError('');
  renderAccounts();
  $('ms-client-id').focus();
}

function hideSetup() {
  setupFor = null;
  renderAccounts();
  $('add-microsoft').focus();
}

async function saveSetup(e) {
  e.preventDefault();
  if (!setupFor || accountBusy) return;
  const id = $('ms-client-id').value.trim();
  if (!id) {
    showSetupError('Paste the Application (client) ID first.');
    $('ms-client-id').focus();
    return;
  }
  accountBusy = true;
  $('ms-setup-save').disabled = true;
  showSetupError('');
  let s;
  try {
    s = await clearmail.saveSettings({ msClientId: id });
  } catch (err) {
    showSetupError(errText(err));
    return;
  } finally {
    accountBusy = false;
    $('ms-setup-save').disabled = false;
  }
  const target = setupFor;
  setupFor = null;
  accountsDidChange(); // Outlook accounts may load now
  if (!dialogOpen()) return;
  applySettings(s);
  if (target) startSignIn(target.accountId);
}

// ---------- removing an account ----------

function askRemove(id) {
  confirmRemove = id;
  accountsMessage();
  renderAccounts();
  focusAccount(id, 'remove-no');
}

// A removed account's emails leave ClearMail straight away.
function dropAccount(id) {
  state.emails = state.emails.filter((m) => m.accountId !== id);
  state.byId = new Map(state.emails.map((m) => [m.id, m]));
  state.accounts = state.accounts.filter((a) => a.id !== id);
  dropMissingSelection();
  renderAll();
}

async function removeAccount(id) {
  if (accountBusy || signIn) return;
  const account = settingsView.accounts.find((a) => a.id === id);
  accountBusy = true;
  renderAccounts();
  let s;
  try {
    s = await clearmail.removeAccount(id);
  } catch (err) {
    accountBusy = false;
    renderAccounts();
    accountsMessage({ error: errText(err) });
    focusAccount(id, 'remove-yes');
    return;
  }
  accountBusy = false;
  confirmRemove = null;
  fresh.delete(id);
  dropAccount(id);
  accountsDidChange();
  if (!dialogOpen()) return;
  applySettings(s);
  accountsMessage({ ok: `Removed ${account?.email || 'the account'}.` });
  $('add-microsoft').focus();
}

// ---------- Gmail, iCloud, Yahoo and other IMAP accounts ----------
// Replies from these accounts go out through the SMTP server below.

function fillProviders(selected) {
  const providers = settingsView?.providers || {};
  const sel = $('provider');
  sel.replaceChildren(
    ...Object.entries(providers).map(([k, label]) => el('option', { value: k }, str(label) || k)),
    el('option', { value: 'custom' }, 'Other (custom server)'),
  );
  sel.value = Object.hasOwn(providers, selected) || selected === 'custom' ? selected : Object.keys(providers)[0] || 'custom';
}

// account: the IMAP account to edit, or null to add one.
function openAccountForm(account = null) {
  if (signIn || accountBusy) return;
  editing = account;
  confirmRemove = null;
  accountsMessage();
  const f = $('account-form').elements;
  fillProviders(account?.provider);
  for (const name of ['user', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort']) f[name].value = account?.[name] ?? '';
  for (const kind of ['imap', 'smtp']) {
    const mode = account?.[`${kind}Security`] === 'starttls' ? 'starttls' : 'tls';
    f[`${kind}Security`].value = mode;
    f[`${kind}Port`].placeholder = PORTS[kind][mode];
  }
  f.pass.value = '';
  f.pass.placeholder = account?.hasPass ? '•••••••• saved (leave blank to keep)' : 'app password';
  $('custom-server').hidden = $('provider').value !== 'custom';
  $('account-title').textContent = account ? `Edit ${account.email}` : 'Add an email account';
  $('account-save').textContent = account ? 'Save changes' : 'Add account';
  showFormError('');
  $('settings-main').hidden = true;
  $('account-form').hidden = false;
  $('settings').scrollTop = 0;
  $('provider').focus();
}

// focusId: the account to put the keyboard focus on afterwards.
function closeAccountForm(focusId = editing?.id) {
  editing = null;
  $('account-form').hidden = true;
  $('settings-main').hidden = false;
  renderAccounts();
  if (focusId) focusAccount(focusId, 'edit');
  else $('add-imap').focus();
}

// Save is the form's only submit button, so Enter in any field saves.
async function saveAccountForm(e) {
  e.preventDefault();
  if (accountBusy) return;
  const f = e.target.elements;
  const target = editing;
  const input = { provider: f.provider.value, user: f.user.value.trim(), pass: f.pass.value };
  if (target) input.id = target.id;
  if (input.provider === 'custom') {
    for (const kind of ['imap', 'smtp']) {
      input[`${kind}Host`] = f[`${kind}Host`].value.trim();
      input[`${kind}Port`] = f[`${kind}Port`].value;
      input[`${kind}Security`] = f[`${kind}Security`].value;
    }
  }
  const before = new Set(settingsView.accounts.map((a) => a.id));
  accountBusy = true;
  $('account-save').disabled = true;
  showFormError('');
  let s;
  try {
    s = await clearmail.saveAccount(input);
  } catch (err) {
    showFormError(errText(err));
    return;
  } finally {
    accountBusy = false;
    $('account-save').disabled = false;
  }
  const view = tidySettings(s);
  const saved = target ? view.accounts.find((a) => a.id === target.id) : view.accounts.find((a) => !before.has(a.id));
  if (saved) fresh.set(saved.id, target ? 'Saved.' : 'Added.');
  accountsDidChange();
  if (!dialogOpen()) return;
  applySettings(s);
  // Still on the form the user saved (Esc may have left it meanwhile).
  if (!$('account-form').hidden && editing === target) closeAccountForm(saved?.id);
  accountsMessage({ ok: `${target ? 'Saved' : 'Added'} ${saved?.email || input.user}. Its email loads when you close Settings.` });
}

// ---------- the morning brief and General: saved with Save ----------

// Save is the form's only submit button, so Enter in any field saves. Settings stays open,
// so the "Next brief" and login item lines can show the result.
async function saveGeneral(e) {
  e.preventDefault();
  if (saving) return;
  const f = e.target.elements;
  const input = { limit: f.limit.value, demo: f.demo.checked, brief: briefFromForm() };
  const msClientId = f.msClientId.value.trim();
  if (msClientId !== (settingsView?.msClientId || '')) input.msClientId = msClientId;
  // Only these need the inbox loaded again.
  const reload = String(input.limit) !== String(settingsView?.limit ?? '') || input.demo !== Boolean(settingsView?.demoChosen)
    || input.msClientId !== undefined;
  saving = true;
  $('settings-save').disabled = true;
  showSettingsError('');
  showBox('settings-saved', '');
  let s;
  try {
    s = await clearmail.saveSettings(input);
  } catch (err) {
    if (dialogOpen()) showSettingsError(errText(err));
    else notice(`Settings not saved: ${errText(err)}`);
    return;
  } finally {
    saving = false;
    $('settings-save').disabled = false;
  }
  if (reload) load({ force: true });
  if (!dialogOpen()) return;
  if (s && typeof s === 'object') {
    applySettings(s);
    f.limit.value = s.limit ?? f.limit.value;
    fillBrief(settingsView.brief);
  }
  $('settings-cancel').textContent = 'Close';
  showBox('settings-saved', '✓ Saved.');
  refreshBriefStatus();
}

// ---------- wiring ----------

function wireSettings() {
  $('ms-setup').addEventListener('submit', saveSetup);
  $('ms-setup-cancel').addEventListener('click', hideSetup);
  $('ms-cancel').addEventListener('click', cancelSignIn);
  $('add-microsoft').addEventListener('click', () => startSignIn(null));
  $('add-imap').addEventListener('click', () => openAccountForm(null));
  $('account-cancel').addEventListener('click', () => closeAccountForm());
  $('account-form').addEventListener('submit', saveAccountForm);
  $('provider').addEventListener('change', (e) => { $('custom-server').hidden = e.target.value !== 'custom'; });

  // Picking a security mode suggests its usual port, unless the user typed their own.
  for (const kind of ['imap', 'smtp']) {
    const f = $('account-form').elements;
    f[`${kind}Security`].addEventListener('change', (e) => {
      const port = f[`${kind}Port`];
      const mode = e.target.value;
      const other = PORTS[kind][mode === 'tls' ? 'starttls' : 'tls'];
      if (!port.value || port.value === other) port.value = PORTS[kind][mode];
      port.placeholder = PORTS[kind][mode];
    });
  }

  // The seven day boxes, Monday first.
  $('brief-days').append(...DAY_ORDER.map((d) => el('label', { class: 'check day' },
    el('input', { type: 'checkbox', name: 'briefDay', value: String(d) }), DAY_SHORT[d])));

  $('settings-form').addEventListener('input', () => {
    $('settings-cancel').textContent = 'Cancel';
    showBox('settings-saved', '');
    showSettingsError(''); // the user is fixing it
    briefFieldsState();
  });
  $('settings-form').addEventListener('submit', saveGeneral);
  $('settings-cancel').addEventListener('click', () => $('settings').close('cancel'));
  $('brief-test').addEventListener('click', sendTestBrief);
  $('open-notifications').addEventListener('click', () => openSystemSettings('notifications'));
  $('open-login-items').addEventListener('click', () => openSystemSettings('login-items'));

  // Esc steps back one level: stops a sign-in, leaves the account form or setup, or
  // keeps an account the user was about to remove, before it closes Settings.
  $('settings').addEventListener('cancel', (e) => {
    if (signIn) {
      e.preventDefault();
      cancelSignIn();
    } else if (!$('account-form').hidden) {
      e.preventDefault();
      closeAccountForm();
    } else if (setupFor) {
      e.preventDefault();
      hideSetup();
    } else if (confirmRemove) {
      e.preventDefault();
      const id = confirmRemove;
      confirmRemove = null;
      renderAccounts();
      focusAccount(id, 'remove');
    }
  });

  $('settings').addEventListener('close', () => {
    if (signIn) cancelSignIn(); // closes the browser sign-in's waiting page in ClearMail
    clearTimeout(testTimer);
    setupFor = null;
    confirmRemove = null;
    editing = null;
    $('account-form').hidden = true;
    $('settings-main').hidden = false;
    const reload = accountsChanged;
    accountsChanged = false;
    if (reload) load({ force: true });
  });
}
