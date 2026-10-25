'use strict';

// inbox-store.json — the app's database, and an API for agents.
//
// Same contract as Messages Inbox: external agents may edit the file while the
// app runs. Writers flock(2) the file itself, reload, mutate, write IN PLACE
// (ftruncate + write on the locked fd), unlock. A directory watcher picks up
// external edits and the UI refreshes within a beat.
//
// Shape:
//   meta      { me, teamId, teamDomain, highWater, seededAt }
//   settings  { markReadInSlack, notifications }
//   mutes     { slack: [channelId], slackFetchedAt, local: { channelId: true } }
//   myThreads { "C:threadTs": lastTsIPosted }      — threads I participate in
//   items     { key: Item }
//
// Item (one inbox row = one thread, or a DM's top-level stream):
//   key "C:threadTs" | "D:dm", channel, threadTs|null, kind 'thread'|'dm'
//   lastTs, lastIncomingTs, lastFromMe, lastUser, lastText
//   rootUser, rootText, participants[], newCount, mention
//   openedTs   — newest ts seen when last opened (unread = lastIncomingTs > openedTs)
//   archivedTs — archived while lastIncomingTs <= archivedTs; a newer incoming
//                message returns the item to the inbox (email semantics).

const fs = require('fs');
const path = require('path');

let fsx = null;
try { fsx = require('fs-native-extensions'); } catch { /* unlocked fallback */ }

const DEFAULTS = () => ({
  meta: {},
  settings: { markReadInSlack: true, notifications: true },
  mutes: { slack: [], slackFetchedAt: 0, local: {} },
  myThreads: {},
  items: {},
});

const ts = (s) => (s ? parseFloat(s) : 0);

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = DEFAULTS();
    this.onExternalChange = null;
    this._suppressUntil = 0;
    this._load();
    this._watch();
  }

  _watch() {
    try {
      const base = path.basename(this.filePath);
      fs.watch(path.dirname(this.filePath), (_ev, fname) => {
        if (fname !== base || Date.now() < this._suppressUntil) return;
        clearTimeout(this._reloadT);
        this._reloadT = setTimeout(() => {
          this._load();
          if (this.onExternalChange) this.onExternalChange();
        }, 80);
      });
    } catch { /* best-effort */ }
  }

  _load() {
    for (let i = 0; i < 3; i++) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        const d = DEFAULTS();
        this.data = {
          ...d, ...parsed,
          settings: { ...d.settings, ...(parsed.settings || {}) },
          mutes: { ...d.mutes, ...(parsed.mutes || {}) },
        };
        return;
      } catch (e) {
        if (e && e.code === 'ENOENT') break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  }

  // flock → reload → mutate → write in place → unlock.
  mutate(fn) {
    let fd = null;
    let locked = false;
    let out;
    try {
      try { fd = fs.openSync(this.filePath, 'r+'); } catch { fd = fs.openSync(this.filePath, 'w+'); }
      if (fsx) {
        const deadline = Date.now() + 2000;
        while (!(locked = fsx.tryLock(fd))) {
          if (Date.now() > deadline) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      this._load();
      out = fn(this.data);
      const json = JSON.stringify(this.data);
      this._suppressUntil = Date.now() + 400;
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, json, 0, 'utf8');
    } finally {
      if (locked) { try { fsx.unlock(fd); } catch { /* released with fd */ } }
      if (fd != null) { try { fs.closeSync(fd); } catch { /* closed */ } }
    }
    return out;
  }

  get items() { return this.data.items; }
  get meta() { return this.data.meta; }
  get settings() { return this.data.settings; }

  isMuted(channel) {
    const m = this.data.mutes;
    return !!(m.local[channel] || m.slack.includes(channel));
  }

  static isArchived(it) {
    return it.archivedTs != null && ts(it.lastIncomingTs) <= ts(it.archivedTs);
  }

  static isUnread(it) {
    return ts(it.lastIncomingTs) > ts(it.openedTs);
  }

  archive(keys) {
    this.mutate((d) => {
      for (const k of keys) {
        const it = d.items[k];
        if (!it) continue;
        it.archivedTs = it.lastTs;
        it.openedTs = it.lastTs;
        it.newCount = 0;
        it.mention = false;
      }
    });
  }

  unarchive(keys) {
    this.mutate((d) => { for (const k of keys) if (d.items[k]) d.items[k].archivedTs = null; });
  }

  markOpened(key) {
    this.mutate((d) => {
      const it = d.items[key];
      if (!it) return;
      it.openedTs = it.lastTs;
      it.newCount = 0;
      // `mention` stays until archive so the row doesn't jump sections mid-read.
    });
  }

  markUnread(key) {
    this.mutate((d) => {
      const it = d.items[key];
      if (!it) return;
      it.openedTs = String(ts(it.lastIncomingTs) - 0.000001);
      it.newCount = Math.max(1, it.newCount || 0);
    });
  }

  // Keep the file small: drop archived items untouched for 30 days.
  prune() {
    const cutoff = Date.now() / 1000 - 30 * 86400;
    this.mutate((d) => {
      for (const [k, it] of Object.entries(d.items)) {
        if (Store.isArchived(it) && ts(it.lastTs) < cutoff) delete d.items[k];
      }
      for (const [k, v] of Object.entries(d.myThreads)) if (ts(v) < cutoff) delete d.myThreads[k];
    });
  }
}

module.exports = { Store, ts };
