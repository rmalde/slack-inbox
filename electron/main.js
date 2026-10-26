'use strict';

const { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell, Notification, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

const slack = require('./lib/slack');
const { Store, ts } = require('./lib/store');
const { Directory } = require('./lib/directory');
const { Sync } = require('./lib/sync');
const { WebSession } = require('./lib/websession');

app.setName('Slack Inbox');

// Private Slack files (image previews) are fetched through the web session.
protocol.registerSchemesAsPrivileged([
  { scheme: 'slackfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const POLL_FOCUSED_MS = 10_000;
const POLL_BLURRED_MS = 30_000;
const MUTES_EVERY_MS = 3 * 60_000;

let win;
let store;
let dir;
let sync;
let web;
let customEmoji = {};
const log = (...a) => console.log('[slack-inbox]', ...a);

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const here = process.env.VITE_DEV ? 'http://127.0.0.1:5174' : 'file://';
    if (!url.startsWith(here)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  win.on('focus', () => { send('focus'); schedulePoll(300); });
  // Debug aid: SI_CAPTURE=/path/prefix writes window screenshots periodically.
  if (process.env.SI_CAPTURE) {
    let n = 0;
    setInterval(async () => {
      try { fs.writeFileSync(`${process.env.SI_CAPTURE}-${n++ % 3}.png`, (await win.webContents.capturePage()).toPNG()); } catch { /* window gone */ }
    }, 4000);
  }
  if (process.env.VITE_DEV) win.loadURL('http://127.0.0.1:5174');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function buildMenu() {
  const to = (ch, ...a) => () => send(ch, ...a);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Thread',
      submenu: [
        { label: 'Archive', accelerator: 'CmdOrCtrl+Shift+E', click: to('cmd', 'archive') },
        { label: 'Mark Unread', accelerator: 'CmdOrCtrl+Shift+U', click: to('cmd', 'unread') },
        { label: 'Open Thread in Slack', accelerator: 'CmdOrCtrl+Shift+A', click: to('cmd', 'open-slack') },
        { label: 'Mute Channel Here', accelerator: 'CmdOrCtrl+Shift+M', click: to('cmd', 'mute') },
        { type: 'separator' },
        { label: 'Next', accelerator: 'CmdOrCtrl+Down', click: to('cmd', 'next') },
        { label: 'Previous', accelerator: 'CmdOrCtrl+Up', click: to('cmd', 'prev') },
        { type: 'separator' },
        { label: 'Refresh Now', accelerator: 'CmdOrCtrl+R', click: () => schedulePoll(0) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Inbox', accelerator: 'CmdOrCtrl+1', click: to('cmd', 'view-inbox') },
        { label: 'Archived', accelerator: 'CmdOrCtrl+2', click: to('cmd', 'view-archived') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// ---- inbox view model -------------------------------------------------------

function section(it) {
  const k = dir.convKind(it.channel);
  if (k !== 'channel') return 'you';
  if (it.mention || it.rootUser === store.meta.me || store.data.myThreads[it.key]) return 'you';
  return 'channels';
}

function viewItem(it) {
  const me = store.meta.me;
  const ck = dir.convKind(it.channel);
  const conv = dir.convs[it.channel] || {};
  const avatarUser = ck === 'im' ? conv.user : (it.kind === 'thread' ? (it.rootUser || it.lastUser) : it.lastUser);
  return {
    key: it.key,
    channel: it.channel,
    kind: it.kind,
    convKind: ck,
    title: dir.convTitle(it.channel, me),
    isPrivate: !!conv.private,
    ext: !!conv.ext,
    avatarUser,
    participants: it.participants || [],
    rootUser: it.rootUser,
    rootBotName: it.rootBotName || null,
    rootText: it.rootText,
    lastUser: it.lastUser,
    lastBotName: it.lastBotName || null,
    lastText: it.lastText,
    lastFromMe: !!it.lastFromMe,
    lastTs: it.lastTs,
    lastIncomingTs: it.lastIncomingTs,
    newCount: it.newCount || 0,
    mention: !!it.mention,
    unread: Store.isUnread(it),
    archived: Store.isArchived(it),
    muted: store.isMuted(it.channel),
    section: section(it),
    threadTs: it.threadTs,
    openedTs: it.openedTs,
    firstUnreadTs: it.firstUnreadTs || null,
  };
}

function updateBadge() {
  if (!app.dock) return;
  const n = Object.values(store.items).filter((i) => visible(i) && !Store.isArchived(i) && Store.isUnread(i) && section(i) === 'you').length;
  app.dock.setBadge(n ? String(n) : '');
}

let changeT = null;
function changed() {
  clearTimeout(changeT);
  changeT = setTimeout(() => { send('inbox-changed'); updateBadge(); }, 60);
}

function notify({ key, n, mention }) {
  if (!store.settings.notifications || (win && win.isFocused())) return;
  if (!Notification.isSupported()) return;
  const who = dir.userName(n.user) || n.botName || 'Slack';
  const where = dir.convKind(n.channel) === 'im' ? '' : ` in ${dir.convTitle(n.channel, store.meta.me)}`;
  const body = String(n.text || '')
    .replace(/<@(\w+)(\|[^>]+)?>/g, (_m, id) => `@${dir.userName(id)}`)
    .replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/<([^>]+)>/g, '$1').slice(0, 180);
  const note = new Notification({ title: `${mention ? '@ ' : ''}${who}${where}`, body, silent: false });
  note.on('click', () => { if (win) { win.show(); win.focus(); send('select', key); } });
  note.show();
}

// ---- loops ------------------------------------------------------------------

let pollT = null;
function schedulePoll(ms) {
  clearTimeout(pollT);
  pollT = setTimeout(async () => {
    await sync.tick();
    schedulePoll(win && win.isFocused() ? POLL_FOCUSED_MS : POLL_BLURRED_MS);
  }, ms);
}

async function refreshMutes() {
  // A finished Slack login leaves its `d` cookie in our partition even if the
  // sign-in window never captured the token; pick it up silently.
  if (!web.connected) {
    web.teamId = store.meta.teamId;
    web.domain = store.meta.teamDomain;
    try { if (web._adopt(await web._tokenFromCookie())) send('session-changed'); } catch { /* not signed in */ }
  }
  if (!web.connected) return;
  try {
    const muted = await web.mutedChannels();
    store.mutate((d) => { d.mutes.slack = muted; d.mutes.slackFetchedAt = Date.now(); });
    changed();
  } catch (e) { log('mutes', e.message); send('session-changed'); }
  if (!Object.keys(customEmoji).length && web.connected) {
    try { customEmoji = await web.customEmoji(); send('directory-changed'); } catch { /* optional */ }
  }
}

app.whenReady().then(async () => {
  const ud = app.getPath('userData');
  store = new Store(path.join(ud, 'inbox-store.json'));
  dir = new Directory(ud);
  web = new WebSession(ud, store.meta.teamId);
  sync = new Sync({ store, dir, onChange: changed, onNotify: notify, log });
  store.onExternalChange = changed;

  protocol.handle('slackfile', async (req) => {
    // slackfile://f/<encoded https url>
    const url = decodeURIComponent(req.url.replace(/^slackfile:\/\/f\//, ''));
    if (!/^https:\/\/([a-z0-9-]+\.)*slack(-edge)?\.com\//.test(url)) return new Response('', { status: 400 });
    try {
      const r = await web.fetchFile(url);
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' } });
    } catch { return new Response('', { status: 502 }); }
  });

  try {
    const icon = path.join(__dirname, '..', 'build', 'icon-1024.png');
    if (app.dock && fs.existsSync(icon)) app.dock.setIcon(icon);
  } catch { /* ignore */ }

  buildMenu();
  createWindow();
  updateBadge();

  nativeTheme.on('updated', () => send('theme-changed'));

  try {
    await sync.init();
    web.teamId = store.meta.teamId;
    send('directory-changed');
  } catch (e) {
    sync.status.error = e.message;
    changed();
  }
  refreshMutes().finally(() => schedulePoll(0));
  setInterval(refreshMutes, MUTES_EVERY_MS);
  setInterval(() => dir.refresh().then(() => send('directory-changed')).catch(() => {}), 6 * 3600e3);
  store.prune();
  setInterval(() => store.prune(), 24 * 3600e3);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- IPC ----------------------------------------------------------------------

// Muted conversations only surface for @mentions — also for rows that landed
// before the mute list was known. Unmuting brings them back.
const visible = (it) => it.mention || !store.isMuted(it.channel);

ipcMain.handle('inbox:list', () => ({
  items: Object.values(store.items).filter(visible).map(viewItem),
  status: {
    ...sync.status,
    hasToken: !!slack.getToken(),
    webConnected: web.connected,
    mutesFetchedAt: store.data.mutes.slackFetchedAt,
    me: store.meta.me,
  },
}));

ipcMain.handle('directory:get', () => {
  const channels = {};
  for (const [id, c] of Object.entries(dir.convs)) if (c.name && !c.im && !c.mpim) channels[id] = c.name;
  return { users: dir.users, channels, me: store.meta.me, customEmoji };
});

ipcMain.handle('item:messages', async (_e, key) => {
  const it = store.items[key];
  if (!it) return { ok: false, error: 'gone' };
  try {
    const messages = await sync.messagesFor(it);
    return { ok: true, messages, users: dir.users };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Side-panel threads (replying to a message inside a DM's main stream).
ipcMain.handle('thread:messages', async (_e, { channel, threadTs }) => {
  try {
    return { ok: true, messages: await sync.messagesFor({ kind: 'thread', channel, threadTs }) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('thread:send', async (_e, { channel, threadTs, text }) => {
  if (!text || !text.trim()) return { ok: false };
  try {
    const r = await slack.call('chat.postMessage', { channel, text, thread_ts: threadTs }, { post: true });
    // Marks the thread as mine, so later replies land in For you.
    sync.ingest([{ channel, ts: r.ts, user: store.meta.me, text, threadTs, isReply: true }]);
    return { ok: true, ts: r.ts };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Full conversation view (opened from a thread's header): the channel or
// DM's main stream, read and posted to without making it an inbox row.
ipcMain.handle('channel:messages', async (_e, { channel }) => {
  try {
    return { ok: true, messages: await sync.messagesFor({ kind: 'dm', channel }, { limit: 200 }) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('channel:send', async (_e, { channel, text }) => {
  if (!text || !text.trim()) return { ok: false };
  try {
    const r = await slack.call('chat.postMessage', { channel, text }, { post: true });
    sync.ingest([{ channel, ts: r.ts, user: store.meta.me, text, threadTs: null, isReply: false }]);
    return { ok: true, ts: r.ts };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('item:open', (_e, key) => { store.markOpened(key); changed(); return true; });
ipcMain.handle('item:unread', (_e, key) => { store.markUnread(key); changed(); return true; });

ipcMain.handle('item:archive', (_e, keys) => {
  store.archive(keys);
  changed();
  if (store.settings.markReadInSlack) {
    const chans = new Set(keys.map((k) => store.items[k] && store.items[k].channel).filter(Boolean));
    (async () => { for (const c of chans) { try { await sync.syncSlackRead(c); } catch (e) { log('mark', e.message); } } })();
  }
  return true;
});

ipcMain.handle('item:unarchive', (_e, keys) => { store.unarchive(keys); changed(); return true; });

ipcMain.handle('item:send', async (_e, { key, text }) => {
  const it = store.items[key];
  if (!it || !text.trim()) return { ok: false };
  try {
    const r = await slack.call('chat.postMessage', {
      channel: it.channel, text, thread_ts: it.kind === 'thread' ? it.threadTs : undefined,
    }, { post: true });
    sync.ingest([{ channel: it.channel, ts: r.ts, user: store.meta.me, text, threadTs: it.kind === 'thread' ? it.threadTs : null, isReply: it.kind === 'thread' && r.ts !== it.threadTs }]);
    store.mutate((d) => { const x = d.items[key]; if (x && ts(r.ts) > ts(x.openedTs)) x.openedTs = r.ts; });
    changed();
    return { ok: true, ts: r.ts };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('item:react', async (_e, { channel, ts: msgTs, name, remove }) => {
  try {
    await slack.call(remove ? 'reactions.remove' : 'reactions.add', { channel, timestamp: msgTs, name }, { post: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('item:openInSlack', (_e, { key, ts: msgTs }) => {
  const it = store.items[key];
  if (!it) return false;
  const hasDesktop = fs.existsSync('/Applications/Slack.app') || fs.existsSync(path.join(require('os').homedir(), 'Applications', 'Slack.app'));
  shell.openExternal(hasDesktop ? sync.deepLink(it, msgTs) : sync.permalink(it, msgTs));
  return true;
});

ipcMain.handle('mute:toggleLocal', (_e, channel) => {
  store.mutate((d) => {
    if (d.mutes.local[channel]) delete d.mutes.local[channel];
    else d.mutes.local[channel] = true;
  });
  changed();
  return !!store.data.mutes.local[channel];
});

ipcMain.handle('session:signIn', async () => {
  const ok = await web.signIn(store.meta.teamId, store.meta.teamDomain);
  if (ok) await refreshMutes();
  send('session-changed');
  return ok;
});

ipcMain.handle('session:signOut', async () => {
  await web.signOut();
  store.mutate((d) => { d.mutes.slack = []; d.mutes.slackFetchedAt = 0; });
  changed();
  return true;
});

ipcMain.handle('settings:set', (_e, patch) => {
  store.mutate((d) => { Object.assign(d.settings, patch); });
  return store.settings;
});
ipcMain.handle('settings:get', () => store.settings);
ipcMain.handle('sync:now', () => { schedulePoll(0); return true; });
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('theme:isDark', () => nativeTheme.shouldUseDarkColors);
