'use strict';

// Slack's *web client* session (xoxc token + `d` cookie), obtained by signing in
// to app.slack.com once inside this app. The public user token can't read mute
// settings (users.prefs.get needs the legacy `read` scope) or private files
// (no files:read), but the web session can. Everything else uses the xoxp token.
//
// The xoxc token is cached in userData (chmod 600); the `d` cookie lives in the
// persistent Electron partition, so sign-in is a one-time step.

const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:slack-web';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class WebSession {
  constructor(userData, teamId) {
    this.file = path.join(userData, 'web-session.json');
    this.teamId = teamId;
    this.token = null;
    try { this.token = JSON.parse(fs.readFileSync(this.file, 'utf8')).token || null; } catch { /* none yet */ }
    this.ses = session.fromPartition(PARTITION);
    this.ses.setUserAgent(UA);
    this.win = null;
  }

  get connected() { return !!this.token; }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify({ token: this.token }), { mode: 0o600 });
  }

  async _cookieHeader() {
    const cookies = await this.ses.cookies.get({ domain: 'slack.com' });
    const want = cookies.filter((c) => c.name === 'd' || c.name === 'd-s');
    if (!want.find((c) => c.name === 'd')) return null;
    return want.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  // The web client's token, read with just the `d` cookie: workspace pages
  // embed it in their boot data as "api_token":"xoxc-…".
  async _tokenFromCookie() {
    const cookie = await this._cookieHeader();
    if (!cookie) return null;
    const hosts = [this.domain && `https://${this.domain}.slack.com/customize/emoji`, this.domain && `https://${this.domain}.slack.com/`, 'https://app.slack.com/'].filter(Boolean);
    for (const url of hosts) {
      try {
        const res = await fetch(url, { headers: { Cookie: cookie, 'User-Agent': UA } });
        const m = /"api_token":"(xoxc-[^"]+)"/.exec(await res.text());
        if (m) return m[1];
      } catch { /* try the next page */ }
    }
    return null;
  }

  // Fallback: once app.slack.com/client has booted, it keeps the token in
  // localStorage. Checks every window in our partition (sign-in may finish in
  // a popup).
  async _tokenFromWindows() {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.session !== this.ses) continue;
      try {
        const tok = await w.webContents.executeJavaScript(`(() => {
          try {
            const teams = (JSON.parse(localStorage.getItem('localConfig_v2') || '{}').teams) || {};
            const t = teams[${JSON.stringify(this.teamId || '')}] || Object.values(teams)[0];
            return (t && t.token) || null;
          } catch (e) { return null; }
        })()`);
        if (tok) return tok;
      } catch { /* mid-navigation */ }
    }
    return null;
  }

  _adopt(tok) {
    if (!tok || !tok.startsWith('xoxc-')) return false;
    this.token = tok;
    this._save();
    return true;
  }

  // Opens a real Slack sign-in window and resolves once we hold the web
  // client token. Slack's login ends on a "Launching <workspace>" page that
  // hands off to the desktop app (slack://); we block that hand-off and load
  // the browser client instead, and also read the token straight off the
  // session cookie, so either path completes sign-in.
  async signIn(teamId, domain) {
    if (teamId) this.teamId = teamId;
    if (domain) this.domain = domain;
    if (this._adopt(await this._tokenFromCookie())) return true; // already signed in
    if (this.win && !this.win.isDestroyed()) { this.win.focus(); return this._pending; }

    const clientUrl = `https://app.slack.com/client/${this.teamId || ''}`;
    this.win = new BrowserWindow({
      width: 980, height: 760, title: 'Sign in to Slack',
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
    });
    const wc = this.win.webContents;
    // Keep the whole flow in this one window.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) setImmediate(() => this.win && !this.win.isDestroyed() && this.win.loadURL(url, { userAgent: UA }));
      return { action: 'deny' };
    });
    const guard = (e, url) => {
      if (!/^https?:/.test(url)) { e.preventDefault(); this.win.loadURL(clientUrl, { userAgent: UA }); }
    };
    wc.on('will-navigate', guard);
    wc.on('will-frame-navigate', (e) => guard(e, e.url));
    wc.on('did-navigate', (_e, url) => {
      if (/\/ssb\/redirect|\/launch/.test(url)) this.win.loadURL(clientUrl, { userAgent: UA });
    });
    this.win.loadURL(clientUrl, { userAgent: UA });

    this._pending = new Promise((resolve) => {
      let busy = false;
      const finish = (ok) => {
        clearInterval(poll);
        if (this.win && !this.win.isDestroyed()) this.win.close();
        resolve(ok);
      };
      const poll = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          if (this._adopt(await this._tokenFromWindows()) && await this._cookieHeader()) return finish(true);
          if (this._adopt(await this._tokenFromCookie())) return finish(true);
          if (!this.win || this.win.isDestroyed()) { clearInterval(poll); resolve(this.connected); }
        } finally { busy = false; }
      }, 1500);
      this.win.on('closed', async () => {
        this.win = null;
        // Closed by hand right after logging in? The cookie may be enough.
        if (!this.connected) this._adopt(await this._tokenFromCookie());
        clearInterval(poll);
        resolve(this.connected);
      });
    });
    return this._pending;
  }

  signOut() {
    this.token = null;
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
    return this.ses.clearStorageData();
  }

  async call(method, params = {}) {
    if (!this.token) throw new Error('web session not connected');
    const cookie = await this._cookieHeader();
    if (!cookie) { this.token = null; throw new Error('web session expired'); }
    const body = new URLSearchParams({ token: this.token, ...params });
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    if (!json.ok) {
      if (json.error === 'invalid_auth' || json.error === 'not_authed') { this.token = null; try { fs.unlinkSync(this.file); } catch { /* */ } }
      const err = new Error(`${method}: ${json.error}`);
      err.slack = json.error;
      throw err;
    }
    return json;
  }

  // Channel ids muted in Slack. Newer workspaces keep this inside
  // all_notifications_prefs; older ones in a comma-separated muted_channels.
  async mutedChannels() {
    const r = await this.call('users.prefs.get');
    const prefs = r.prefs || {};
    const muted = new Set();
    if (prefs.muted_channels) for (const id of String(prefs.muted_channels).split(',')) if (id) muted.add(id);
    try {
      const all = typeof prefs.all_notifications_prefs === 'string'
        ? JSON.parse(prefs.all_notifications_prefs) : (prefs.all_notifications_prefs || {});
      for (const [id, p] of Object.entries(all.channels || {})) {
        if (p && p.muted) muted.add(id);
        else if (p && p.muted === false) muted.delete(id);
      }
    } catch { /* malformed pref — keep what we have */ }
    return [...muted];
  }

  async customEmoji() {
    const r = await this.call('emoji.list');
    return r.emoji || {};
  }

  // Authenticated fetch of a private Slack file (images in messages).
  async fetchFile(url) {
    const cookie = await this._cookieHeader();
    const headers = { 'User-Agent': UA };
    if (cookie) headers.Cookie = cookie;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return fetch(url, { headers });
  }
}

module.exports = { WebSession };
