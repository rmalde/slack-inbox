'use strict';

// People + conversations the inbox needs to render names and avatars.
// Cached to directory.json so launch is instant; refreshed in the background.

const fs = require('fs');
const path = require('path');
const slack = require('./slack');

class Directory {
  constructor(userData) {
    this.file = path.join(userData, 'directory.json');
    this.users = {};    // id -> { name, real, avatar, bot, deleted }
    this.convs = {};    // id -> { name, im, mpim, private, user, members? }
    this.member = new Set();
    this.fetchedAt = 0;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.assign(this, { users: d.users || {}, convs: d.convs || {}, fetchedAt: d.fetchedAt || 0 });
      this.member = new Set(Object.keys(this.convs));
    } catch { /* first run */ }
    this._pendingUsers = new Map();
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify({ users: this.users, convs: this.convs, fetchedAt: this.fetchedAt }));
  }

  static _user(u) {
    const p = u.profile || {};
    return {
      name: p.display_name || p.real_name || u.real_name || u.name,
      real: p.real_name || u.real_name || u.name,
      avatar: p.image_192 || p.image_72 || null,
      bot: !!u.is_bot || u.id === 'USLACKBOT',
      deleted: !!u.deleted,
    };
  }

  async refresh() {
    const [users, convs] = await Promise.all([
      slack.paginate('users.list', {}, 'members'),
      slack.paginate('users.conversations', {
        types: 'public_channel,private_channel,im,mpim', exclude_archived: true,
      }, 'channels'),
    ]);
    for (const u of users) this.users[u.id] = Directory._user(u);
    const next = {};
    for (const c of convs) {
      next[c.id] = {
        name: c.name || null, im: !!c.is_im, mpim: !!c.is_mpim,
        private: !!c.is_private, user: c.user || null,
        ext: !!c.is_ext_shared,
        members: (this.convs[c.id] && this.convs[c.id].members) || null,
      };
    }
    this.convs = next;
    this.member = new Set(Object.keys(next));
    this.fetchedAt = Date.now();
    this._save();
    this._fillMpims();
  }

  // Group DMs are named "mpdm-a--b--c-1"; fetch members for real names.
  async _fillMpims() {
    for (const c of Object.values(this.convs)) {
      if (c.mpim && c.members) for (const m of c.members) if (!this.users[m]) await this.ensureUser(m);
    }
    for (const [id, c] of Object.entries(this.convs)) {
      if (c.mpim && !c.members) {
        try {
          const r = await slack.call('conversations.members', { channel: id, limit: 50 });
          c.members = r.members;
          // Slack Connect guests aren't in users.list.
          await Promise.all(r.members.map((m) => this.ensureUser(m)));
        } catch { /* fall back to the mpdm name */ }
      }
    }
    this._save();
  }

  // Lazily resolve users we don't know (Slack Connect guests, new hires).
  async ensureUser(id) {
    if (!id || this.users[id]) return;
    if (this._pendingUsers.has(id)) return this._pendingUsers.get(id);
    const p = slack.call('users.info', { user: id })
      .then((r) => { this.users[id] = Directory._user(r.user); this._save(); })
      .catch(() => { this.users[id] = { name: id, real: id, avatar: null }; })
      .finally(() => this._pendingUsers.delete(id));
    this._pendingUsers.set(id, p);
    return p;
  }

  userName(id) { return (this.users[id] && this.users[id].name) || id || 'Someone'; }

  convTitle(id, me) {
    const c = this.convs[id];
    if (!c) return '#unknown';
    if (c.im) return this.userName(c.user);
    if (c.mpim) {
      if (c.members) {
        const names = c.members.filter((m) => m !== me).map((m) => this.userName(m).split(' ')[0]);
        return names.join(', ');
      }
      return (c.name || '').replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ');
    }
    return `#${c.name}`;
  }

  isBotDm(id) {
    const c = this.convs[id];
    const u = c && c.user && this.users[c.user];
    return !!(u && u.bot);
  }

  convKind(id) {
    const c = this.convs[id];
    if (!c) return 'channel';
    return c.im ? 'im' : c.mpim ? 'mpim' : 'channel';
  }
}

module.exports = { Directory };
