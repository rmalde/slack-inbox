'use strict';

// Background loop that keeps the inbox's AI state current (see ai.js):
//   ai.urgent[key]   { forTs, urgent, hours, expiresAt } — one verdict per
//                    incoming message; dies when superseded, answered by me,
//                    archived, or past its own model-chosen expiry.
//   ai.priority      { order: [key…] highest first, byKey: { key: { forTs } },
//                    backfilled } — the ranked queue. New activity on a row
//                    re-ranks it (binary insertion); a row waiting for its
//                    slot shows at the top of its section, by recency.

const ai = require('./ai');
const { Store, ts } = require('./store');

const TICK_MS = 9000;
const URGENT_WINDOW_S = 6 * 3600;   // only triage messages this fresh
const TRIAGE_PER_TICK = 3;
const RANK_PER_TICK = 2;

function plainText(dir, text) {
  return String(text || '')
    .replace(/<@(\w+)(?:\|([^>]+))?>/g, (_m, id, l) => `@${l || dir.userName(id)}`)
    .replace(/<#\w+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

class Brain {
  constructor({ store, dir, sync, view, visible, onChange, log }) {
    Object.assign(this, { store, dir, sync, view, visible, onChange, log });
    this.cards = new Map();       // key -> { forTs, promise }
    this.status = { ranking: false, rankStats: null, lastError: null };
    this.cooldownUntil = 0;
    this.strikes = 0;
    this.stats = { real: 0, fallback: 0 };
    this.busy = false;
  }

  get state() {
    const d = this.store.data;
    if (!d.ai) d.ai = {};
    if (!d.ai.urgent) d.ai.urgent = {};
    if (!d.ai.priority) d.ai.priority = { order: [], byKey: {}, backfilled: false };
    return d.ai;
  }

  enabled() { return this.store.settings.smartOrder !== false && ai.hasKey(); }

  start() {
    setTimeout(() => this.tick(), 4000);
    setInterval(() => this.tick(), TICK_MS);
  }

  liveItems() {
    return Object.values(this.store.items).filter((it) => this.visible(it) && !Store.isArchived(it));
  }

  // ---- messages → model-readable --------------------------------------------

  async recentMessages(it, limit) {
    const msgs = await this.sync.messagesFor(it, { limit });
    return msgs.slice(-limit).map((m) => ({
      who: m.user === this.store.meta.me ? 'Ronak' : (m.user ? this.dir.userName(m.user) : m.botName || 'bot'),
      text: plainText(this.dir, m.text || (m.attachments[0] && (m.attachments[0].title || m.attachments[0].text)) || ''),
    }));
  }

  cardFor(it) {
    const hit = this.cards.get(it.key);
    if (hit && hit.forTs === it.lastTs) return hit.promise;
    const promise = this.recentMessages(it, 8)
      .catch(() => [])
      .then((msgs) => ai.buildCard({ ...this.view(it), mine: !!this.store.data.myThreads[it.key] }, msgs));
    this.cards.set(it.key, { forTs: it.lastTs, promise });
    if (this.cards.size > 600) this.cards.delete(this.cards.keys().next().value);
    return promise;
  }

  // Model verdict with recency fallback. Only a streak of billing/auth
  // failures cools the ranker off; one blip mid-sort mustn't poison it.
  async compare(a, b) {
    const recency = () => (ts(a.lastIncomingTs || a.lastTs) >= ts(b.lastIncomingTs || b.lastTs) ? 'A' : 'B');
    if (Date.now() < this.cooldownUntil) { this.stats.fallback++; return recency(); }
    const [ca, cb] = await Promise.all([this.cardFor(a), this.cardFor(b)]);
    const res = await ai.compareCards(ca, cb);
    if (!res.ok) {
      this.status.lastError = `rank ${res.errorType}: ${String(res.error || '').slice(0, 160)}`;
      if (['billing', 'auth', 'nokey'].includes(res.errorType) && ++this.strikes >= 3) {
        this.cooldownUntil = Date.now() + 10 * 60e3;
      }
      this.stats.fallback++;
      return recency();
    }
    this.strikes = 0;
    this.stats.real++;
    return res.winner;
  }

  // ---- loop ---------------------------------------------------------------

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.expire();
      if (!this.enabled()) return;
      await this.triage();
      const pr = this.state.priority;
      if (!pr.backfilled) this.backlogSort(); // detached, minutes-long, self-guarded
      else if (!this.status.ranking) await this.rankNew();
    } catch (e) {
      this.status.lastError = String((e && e.message) || e);
      this.log('brain', this.status.lastError);
    } finally {
      this.busy = false;
    }
  }

  // Drop dead urgency verdicts and ranked keys that left the inbox.
  expire() {
    const now = Date.now();
    const live = new Map(this.liveItems().map((it) => [it.key, it]));
    const { urgent, priority } = this.state;
    const deadUrgent = Object.entries(urgent).filter(([k, u]) => {
      const it = live.get(k);
      return !it || u.forTs !== it.lastIncomingTs || it.lastFromMe || (u.urgent && now >= u.expiresAt);
    }).map(([k]) => k);
    const prune = priority.order.some((k) => !live.has(k));
    if (!deadUrgent.length && !prune) return;
    const wasUrgent = deadUrgent.some((k) => urgent[k] && urgent[k].urgent);
    this.store.mutate((d) => {
      for (const k of deadUrgent) delete d.ai.urgent[k];
      if (prune) {
        d.ai.priority.order = d.ai.priority.order.filter((k) => live.has(k));
        for (const k of Object.keys(d.ai.priority.byKey)) if (!live.has(k)) delete d.ai.priority.byKey[k];
      }
    });
    if (wasUrgent || prune) this.onChange();
  }

  async triage() {
    const nowS = Date.now() / 1000;
    const { urgent } = this.state;
    const todo = this.liveItems()
      .filter((it) => !it.lastFromMe && ts(it.lastIncomingTs) > nowS - URGENT_WINDOW_S
        && !(urgent[it.key] && urgent[it.key].forTs === it.lastIncomingTs))
      .sort((a, b) => ts(b.lastIncomingTs) - ts(a.lastIncomingTs))
      .slice(0, TRIAGE_PER_TICK);
    for (const it of todo) {
      const v = this.view(it);
      const where = v.convKind === 'im' ? `DM from ${v.title}` : v.convKind === 'mpim' ? `group DM (${v.title})` : `${v.kind === 'thread' ? 'thread in ' : ''}${v.title}${v.mention ? ', mentions Ronak' : ''}`;
      let messages;
      try { messages = await this.recentMessages(it, 12); } catch { continue; }
      const res = await ai.classifyUrgent({ where, messages });
      if (!res.ok) { this.status.lastError = `triage ${res.errorType}: ${res.error}`; return; }
      this.store.mutate((d) => {
        d.ai.urgent[it.key] = { forTs: it.lastIncomingTs, urgent: res.urgent, hours: res.hours, expiresAt: res.urgent ? Date.now() + res.hours * 3600e3 : 0 };
      });
      if (res.urgent) this.onChange();
    }
  }

  // One-time: merge sort the whole inbox. A sort polluted by failures (>10%
  // fallbacks, or a billing cooldown mid-sort) isn't the real ranking — don't
  // persist it; retry after a pause.
  async backlogSort() {
    if (this.status.ranking) return;
    this.status.ranking = true;
    this.onChange();
    const cooldownBefore = this.cooldownUntil;
    this.stats = { real: 0, fallback: 0 };
    try {
      const list = this.liveItems();
      const forTs = Object.fromEntries(list.map((it) => [it.key, it.lastIncomingTs]));
      const sorted = await ai.mergeSort(list, (a, b) => this.compare(a, b));
      this.status.rankStats = { ...this.stats, at: Date.now() };
      const polluted = this.cooldownUntil > cooldownBefore
        || this.stats.fallback > Math.max(2, (this.stats.real + this.stats.fallback) * 0.1);
      if (polluted) { this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + 2 * 60e3); return; }
      this.store.mutate((d) => {
        d.ai.priority = {
          order: sorted.map((it) => it.key),
          byKey: Object.fromEntries(sorted.map((it) => [it.key, { forTs: forTs[it.key] }])),
          backfilled: true,
        };
      });
    } catch (e) {
      this.status.lastError = 'backlog sort: ' + String((e && e.message) || e);
    } finally {
      this.status.ranking = false;
      this.onChange();
    }
  }

  // New rows (or rows with new incoming activity) binary-search their slot.
  async rankNew() {
    const { priority } = this.state;
    const live = this.liveItems();
    const byKey = new Map(live.map((it) => [it.key, it]));
    const todo = live
      .filter((it) => !(priority.byKey[it.key] && priority.byKey[it.key].forTs === it.lastIncomingTs))
      .sort((a, b) => ts(b.lastIncomingTs) - ts(a.lastIncomingTs))
      .slice(0, RANK_PER_TICK);
    for (const it of todo) {
      const order = this.state.priority.order.filter((k) => k !== it.key && byKey.has(k));
      const idx = await ai.binaryInsertIndex(order.map((k) => byKey.get(k)), it, (a, b) => this.compare(a, b));
      const forTs = it.lastIncomingTs;
      this.store.mutate((d) => {
        const cur = d.ai.priority.order.filter((k) => k !== it.key);
        // Re-anchor by neighbour in case the order moved while we compared.
        const before = order[idx];
        const at = before ? Math.max(0, cur.indexOf(before)) : cur.length;
        cur.splice(at, 0, it.key);
        d.ai.priority.order = cur;
        d.ai.priority.byKey[it.key] = { forTs };
      });
      this.onChange();
    }
  }

  // View-model fields for one item.
  decorate(it) {
    const { urgent, priority } = this.state;
    const u = urgent[it.key];
    const live = u && u.urgent && u.forTs === it.lastIncomingTs && !it.lastFromMe && Date.now() < u.expiresAt;
    const idx = this._rankIndex ? this._rankIndex.get(it.key) : undefined;
    const ranked = priority.byKey[it.key] && priority.byKey[it.key].forTs === it.lastIncomingTs;
    return { urgentUntil: live ? u.expiresAt : null, rank: ranked && idx !== undefined ? idx : null };
  }

  beginDecorate() {
    this._rankIndex = new Map(this.state.priority.order.map((k, i) => [k, i]));
  }
}

module.exports = { Brain };
