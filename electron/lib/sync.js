'use strict';

// Turns Slack into inbox items and keeps them current.
//
// Discovery is via search.messages: one call returns every new message in the
// workspace — top-level posts AND thread replies, across channels and DMs —
// sorted newest first. That's far cheaper than polling history on 100+
// channels, and it's the only API that surfaces thread replies without the web
// client's private thread-subscription endpoints.
//
// Which messages make an item (mirrors what Slack would actually notify):
//   DMs / group DMs ......... everything (group DMs respect mute)
//   channel top-level ....... everything, unless the channel is muted
//   channel thread reply .... threads I started / replied in, threads already
//                             sitting in my inbox, or anything mentioning me
//   muted channel ........... only messages that @mention me
// My own messages never create or unarchive an item (email semantics), but
// they mark the thread as one I participate in.

const slack = require('./slack');
const { Store, ts } = require('./store');

const SEED_DAYS = 3;
const OVERLAP_S = 180; // search indexing lags a few seconds; re-scan a window

function threadOfPermalink(p) {
  const m = /[?&]thread_ts=([\d.]+)/.exec(p || '');
  return m ? m[1] : null;
}

function attachText(atts) {
  if (!atts || !atts.length) return '';
  const a = atts[0];
  return a.fallback || a.pretext || a.title || a.text || '';
}

function blockText(blocks) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'text' && n.text) out.push(n.text);
    else if (n.type === 'mrkdwn' || n.type === 'plain_text') out.push(n.text);
    else if (n.type === 'link') out.push(n.text || n.url);
    else if (n.type === 'user') out.push(`<@${n.user_id}>`);
    for (const k of ['elements', 'fields', 'text']) if (n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  walk(blocks);
  return out.join(' ');
}

function plainOf(m) {
  return m.text || attachText(m.attachments) || blockText(m.blocks) || (m.files && m.files.length ? `📎 ${m.files[0].name || 'file'}` : '');
}

function dayStr(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class Sync {
  constructor({ store, dir, onChange, onNotify, log }) {
    this.store = store;
    this.dir = dir;
    this.onChange = onChange || (() => {});
    this.onNotify = onNotify || (() => {});
    this.log = log || (() => {});
    this.seen = new Map(); // "C:ts" -> true, bounded
    this.rootQueue = new Set();
    this.status = { phase: 'idle', lastPollAt: 0, error: null, seedProgress: null };
    this.lastRead = {};
  }

  get me() { return this.store.meta.me; }

  async init() {
    if (!this.me) {
      const a = await slack.call('auth.test');
      const host = /https:\/\/([^.]+)\.slack\.com/.exec(a.url || '');
      this.store.mutate((d) => {
        d.meta.me = a.user_id;
        d.meta.teamId = a.team_id;
        d.meta.teamDomain = host ? host[1] : null;
      });
    }
    if (!Object.keys(this.dir.users).length || Date.now() - this.dir.fetchedAt > 6 * 3600e3) {
      this.status.phase = 'directory';
      await this.dir.refresh();
    } else {
      this.dir.refresh().catch((e) => this.log('directory refresh', e.message));
    }
  }

  // ---- normalization -----------------------------------------------------

  fromSearch(m) {
    const thread = threadOfPermalink(m.permalink);
    return {
      channel: m.channel.id,
      ts: m.ts,
      user: m.user || null,
      botName: m.username || null,
      text: plainOf(m),
      // Bots tag people inside attachments (GitHub: "Reviewers: @Ronak").
      tagBlob: `${m.text || ''} ${m.attachments ? JSON.stringify(m.attachments) : ''} ${m.blocks ? JSON.stringify(m.blocks) : ''}`,
      threadTs: thread,
      isReply: !!thread && thread !== m.ts,
    };
  }

  keyFor(n) {
    const kind = this.dir.convKind(n.channel);
    if (n.isReply) return `${n.channel}:${n.threadTs}`;
    if (kind === 'im' || kind === 'mpim') return `${n.channel}:dm`;
    return `${n.channel}:${n.ts}`;
  }

  mentionsMe(text) {
    return !!text && text.includes(`<@${this.me}`);
  }

  isParticipant(d, n, key) {
    if (d.myThreads[key]) return true;
    const it = d.items[key];
    return !!(it && it.rootUser === this.me);
  }

  // ---- ingest ------------------------------------------------------------

  // `msgs` ascending by ts. In seed mode `isUnread(n, key, d)` filters what's
  // genuinely new to me; live, everything past the high-water mark is new.
  ingest(msgs, { seed = false, isUnread } = {}) {
    const notify = [];
    let changed = false;
    this.store.mutate((d) => {
      for (const n of msgs) {
        const sk = `${n.channel}:${n.ts}`;
        if (this.seen.has(sk)) continue;
        this.seen.set(sk, true);
        if (this.seen.size > 8000) this.seen.delete(this.seen.keys().next().value);

        const key = this.keyFor(n);
        const kind = this.dir.convKind(n.channel);
        let it = d.items[key];

        if (n.user === this.me) {
          if (n.isReply) d.myThreads[key] = n.ts;
          else if (kind === 'channel') d.myThreads[key] = n.ts;
          if (it && ts(n.ts) >= ts(it.lastTs)) {
            Object.assign(it, { lastTs: n.ts, lastFromMe: true, lastUser: n.user, lastText: n.text });
            changed = true;
          }
          continue;
        }

        const mention = this.mentionsMe(n.tagBlob || n.text);
        const member = this.dir.member.has(n.channel) || !this.dir.fetchedAt;
        const muted = this.store.isMuted(n.channel) || (d.mutes.local[n.channel]);
        let include = (member || mention) && (!muted || mention);
        // Thread replies: in channels and bot DMs, only threads I'm in (or
        // that are already open in the inbox). Human DMs notify everything.
        const botDm = kind === 'im' && this.dir.isBotDm(n.channel);
        if (include && n.isReply && (kind === 'channel' || botDm)) {
          include = mention || this.isParticipant(d, n, key) || (it && !Store.isArchived(it));
        }
        if (include && seed && isUnread) include = isUnread(n, key, d, mention);

        if (!include) {
          // Keep an existing row's preview fresh without resurfacing it.
          if (it && ts(n.ts) > ts(it.lastTs)) {
            Object.assign(it, { lastTs: n.ts, lastFromMe: false, lastUser: n.user, lastText: n.text });
            changed = true;
          }
          continue;
        }

        if (!it) {
          it = d.items[key] = {
            key, channel: n.channel,
            threadTs: key.endsWith(':dm') ? null : (n.threadTs || n.ts),
            kind: key.endsWith(':dm') ? 'dm' : 'thread',
            createdTs: n.ts, lastTs: n.ts, lastIncomingTs: '0', openedTs: '0', archivedTs: null,
            rootUser: n.isReply ? null : n.user,
            rootText: n.isReply ? null : n.text,
            participants: [], newCount: 0, mention: false,
          };
          if (n.isReply) this.rootQueue.add(key);
        }
        const wasHidden = Store.isArchived(it) || !Store.isUnread(it);
        if (ts(n.ts) >= ts(it.lastTs)) {
          Object.assign(it, { lastTs: n.ts, lastFromMe: false, lastUser: n.user, lastText: n.text, lastBotName: n.botName });
        }
        if (ts(n.ts) > ts(it.lastIncomingTs)) it.lastIncomingTs = n.ts;
        it.newCount = (it.newCount || 0) + 1;
        if (mention) it.mention = true;
        if (n.user && !it.participants.includes(n.user)) it.participants = [n.user, ...it.participants].slice(0, 6);
        changed = true;

        if (!seed && wasHidden && (kind !== 'channel' || mention || this.isParticipant(d, n, key))) {
          notify.push({ key, n, mention });
        }
      }
    });
    if (changed) this.onChange();
    for (const x of notify) this.onNotify(x);
    if (this.rootQueue.size) this._drainRoots();
    return changed;
  }

  async _drainRoots() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this.rootQueue.size) {
        const key = this.rootQueue.values().next().value;
        this.rootQueue.delete(key);
        const it = this.store.items[key];
        if (!it || it.rootText != null) continue;
        try {
          const r = await slack.call('conversations.replies', { channel: it.channel, ts: it.threadTs, limit: 1 });
          const root = (r.messages || [])[0];
          if (root) {
            this.store.mutate((d) => {
              const x = d.items[key];
              if (!x) return;
              x.rootUser = root.user || null;
              x.rootText = plainOf(root);
              x.rootBotName = (root.bot_profile && root.bot_profile.name) || root.username || null;
              x.replyCount = root.reply_count || 0;
            });
            this.onChange();
          }
        } catch (e) { this.log('root fetch', e.message); }
        await slack.sleep(350);
      }
    } finally { this._draining = false; }
  }

  // ---- search paging -----------------------------------------------------

  async searchSince(oldestSec, maxPages = 40, onPage) {
    const out = [];
    const query = `after:${dayStr(oldestSec - 86400)}`;
    for (let page = 1; page <= maxPages; page++) {
      const r = await slack.call('search.messages', { query, sort: 'timestamp', sort_dir: 'desc', count: 100, page });
      const matches = (r.messages && r.messages.matches) || [];
      let done = false;
      for (const m of matches) {
        if (ts(m.ts) < oldestSec) { done = true; break; }
        out.push(this.fromSearch(m));
      }
      if (onPage) onPage(page, r.messages && r.messages.paging);
      const pages = (r.messages && r.messages.paging && r.messages.paging.pages) || 1;
      if (done || page >= pages || !matches.length) break;
      await slack.sleep(1200);
    }
    return out.reverse(); // ascending
  }

  async channelLastRead(channel) {
    if (this.lastRead[channel] !== undefined) return this.lastRead[channel];
    try {
      const r = await slack.call('conversations.info', { channel });
      this.lastRead[channel] = r.channel.last_read || '0';
    } catch { this.lastRead[channel] = '0'; }
    return this.lastRead[channel];
  }

  // First run: reconstruct what's unread from the last few days.
  async seed() {
    this.status.phase = 'seeding';
    const now = Date.now() / 1000;
    const msgs = await this.searchSince(now - SEED_DAYS * 86400, 40, (page, paging) => {
      this.status.seedProgress = { page, pages: paging && paging.pages };
      this.onChange();
    });
    const channels = [...new Set(msgs.map((m) => m.channel))].filter((c) => this.dir.member.has(c));
    for (const c of channels) { await this.channelLastRead(c); await slack.sleep(150); }

    // Pass 1: my own messages establish thread participation + my last reply.
    const mine = msgs.filter((m) => m.user === this.me);
    this.ingest(mine, { seed: true });

    const isUnread = (n, key, d, mention) => {
      const lr = ts(this.lastRead[n.channel]);
      const myLast = ts(d.myThreads[key]);
      if (n.isReply) return ts(n.ts) > myLast && (mention || myLast > 0 || ts(n.ts) > lr);
      return ts(n.ts) > lr;
    };
    this.ingest(msgs.filter((m) => m.user !== this.me), { seed: true, isUnread });

    const high = msgs.length ? msgs[msgs.length - 1].ts : String(now);
    this.store.mutate((d) => { d.meta.highWater = high; d.meta.seededAt = Date.now(); });
    this.status.seedProgress = null;
  }

  async poll() {
    const hw = ts(this.store.meta.highWater) || Date.now() / 1000 - 3600;
    const msgs = await this.searchSince(hw - OVERLAP_S, 8);
    this.ingest(msgs);
    const newest = msgs.length ? msgs[msgs.length - 1].ts : null;
    if (newest && ts(newest) > hw) this.store.mutate((d) => { d.meta.highWater = newest; });
    this.status.lastPollAt = Date.now();
  }

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this.store.meta.seededAt) await this.seed();
      else { this.status.phase = 'live'; await this.poll(); }
      this.status.phase = 'live';
      this.status.error = null;
    } catch (e) {
      this.status.error = e.message;
      this.log('tick', e.message);
    } finally {
      this._busy = false;
      this.onChange();
    }
  }

  // ---- reading a thread --------------------------------------------------

  async messagesFor(it) {
    let raw;
    if (it.kind === 'dm') {
      const r = await slack.call('conversations.history', { channel: it.channel, limit: 60 });
      raw = (r.messages || []).reverse();
    } else {
      const r = await slack.call('conversations.replies', { channel: it.channel, ts: it.threadTs, limit: 200 });
      raw = r.messages || [];
    }
    await Promise.all([...new Set(raw.map((m) => m.user).filter(Boolean))].map((u) => this.dir.ensureUser(u)));
    return raw
      .filter((m) => !['channel_join', 'channel_leave', 'group_join'].includes(m.subtype))
      .map((m) => ({
        ts: m.ts,
        user: m.user || null,
        botName: (m.bot_profile && m.bot_profile.name) || m.username || null,
        botIcon: (m.bot_profile && m.bot_profile.icons && (m.bot_profile.icons.image_72 || m.bot_profile.icons.image_48)) || (m.icons && m.icons.image_72) || null,
        text: m.text || (!m.attachments ? blockText(m.blocks) : ''),
        edited: !!m.edited,
        threadTs: m.thread_ts || null,
        replyCount: m.reply_count || 0,
        latestReply: m.latest_reply || null,
        reactions: (m.reactions || []).map((r) => ({ name: r.name, count: r.count, me: (r.users || []).includes(this.me) })),
        files: (m.files || []).map((f) => ({
          id: f.id, name: f.name || f.title, mimetype: f.mimetype || '',
          thumb: f.thumb_720 || f.thumb_480 || f.thumb_360 || null,
          w: f.thumb_720_w || f.thumb_480_w || f.original_w || null,
          h: f.thumb_720_h || f.thumb_480_h || f.original_h || null,
          permalink: f.permalink,
        })),
        attachments: (m.attachments || []).map((a) => ({
          color: a.color || null, pretext: a.pretext || '', title: a.title || '',
          titleLink: a.title_link || a.from_url || null, text: a.text || (!a.title ? a.fallback : '') || '',
          author: a.author_name || a.service_name || '', footer: a.footer || '',
          image: a.image_url || a.thumb_url || null,
        })),
      }));
  }

  // When an item is archived, advance Slack's channel read marker as far as
  // we can without hiding anything still waiting in the inbox.
  async syncSlackRead(channel) {
    const items = Object.values(this.store.items).filter((i) => i.channel === channel);
    const kind = this.dir.convKind(channel);
    const pointOf = (i) => (i.kind === 'dm' ? i.lastTs : i.threadTs);
    if (kind !== 'channel' && items.some((i) => i.kind === 'dm' && !Store.isArchived(i))) return;
    const open = items.filter((i) => !Store.isArchived(i) && i.kind === 'thread' && kind === 'channel');
    const ceiling = open.length ? Math.min(...open.map((i) => ts(i.threadTs))) : Infinity;
    let best = null;
    for (const i of items) {
      if (!Store.isArchived(i)) continue;
      if (kind !== 'channel' && i.kind !== 'dm') continue;
      const p = pointOf(i);
      if (ts(p) < ceiling && (!best || ts(p) > ts(best))) best = p;
    }
    if (!best || ts(best) <= ts(this.lastRead[channel])) return;
    await slack.call('conversations.mark', { channel, ts: best }, { post: true });
    this.lastRead[channel] = best;
  }

  permalink(it, msgTs) {
    const dom = this.store.meta.teamDomain || 'app';
    const t = msgTs || it.threadTs || it.lastTs;
    let url = `https://${dom}.slack.com/archives/${it.channel}/p${String(t).replace('.', '')}`;
    if (it.threadTs && t !== it.threadTs) url += `?thread_ts=${it.threadTs}&cid=${it.channel}`;
    return url;
  }
}

module.exports = { Sync, plainOf };
