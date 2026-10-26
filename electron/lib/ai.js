'use strict';

// Inbox intelligence, ported from Messages Inbox:
//   • Time-sensitive triage — Haiku decides for how many hours the newest
//     incoming message stays urgent (0 = not urgent). Urgent rows float into a
//     Time Sensitive section until their own expiry.
//   • Priority ranking — pairwise A/B verdicts from the tiny jev router turn
//     the inbox into a priority queue: a one-time merge sort of the backlog,
//     then each new message binary-searches its slot (O(log n) comparisons).
// Everything goes through OpenRouter on Trajectory's org key (the Anthropic
// key is capped until Nov 1; the personal OpenRouter key is out of credits).

const fs = require('fs');
const os = require('os');
const path = require('path');

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const RANK_MODEL = 'typesafe/jev-router';
const TRIAGE_MODEL = 'anthropic/claude-haiku-4.5';

let cachedKey;
function getKey() {
  if (cachedKey !== undefined) return cachedKey;
  const support = path.join(os.homedir(), 'Library', 'Application Support');
  for (const d of ['Slack Inbox', 'Messages Inbox']) {
    try {
      const k = fs.readFileSync(path.join(support, d, 'openrouter-key'), 'utf8').trim();
      if (k) { cachedKey = k; return cachedKey; }
    } catch { /* missing */ }
  }
  cachedKey = process.env.OPENROUTER_API_KEY || null;
  return cachedKey;
}
const hasKey = () => !!getKey();

function classifyError(status, body) {
  const msg = String((body && body.error && (body.error.message || JSON.stringify(body.error))) || '');
  if (status === 402 || /credit|payment|balance|spend limit/i.test(msg)) return 'billing';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  return 'other';
}

// Global concurrency gate: a parallel merge sort would otherwise fire dozens
// of simultaneous requests and trip rate limits into silent fallbacks.
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiters = [];
async function gate() {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((r) => waiters.push(r));
  inFlight++;
}
function ungate() {
  inFlight--;
  const w = waiters.shift();
  if (w) w();
}

async function chat(body) {
  const key = getKey();
  if (!key) return { ok: false, errorType: 'nokey', error: 'No OpenRouter key' };
  await gate();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errorType = classifyError(res.status, json);
          if ((errorType === 'rate' || errorType === 'other') && attempt < 3) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          return { ok: false, errorType, error: `HTTP ${res.status}: ${JSON.stringify(json.error || json).slice(0, 200)}` };
        }
        return { ok: true, message: (json.choices && json.choices[0] && json.choices[0].message) || {} };
      } catch (e) {
        if (attempt < 3) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
        return { ok: false, errorType: 'network', error: String((e && e.message) || e) };
      }
    }
    return { ok: false, errorType: 'other', error: 'unreachable' };
  } finally {
    ungate();
  }
}

// ---- ranking ------------------------------------------------------------------

// The whole ordering policy lives here.
const RUBRIC = `You prioritize Slack threads in the inbox of Ronak, CEO of Trajectory (an AI startup). Given two inbox items A and B, decide which should sit HIGHER.

Priority tiers, highest to lowest:
1. Someone is BLOCKED on Ronak: a direct question, decision, approval, or request addressed to him (DM, @mention, or a thread he's in), especially with a deadline.
2. HIRING: specific candidates, interviews, references, offers, closing someone.
3. CUSTOMERS, partners, investors: external/shared channels, deals, pilots, intros.
4. Other work threads he started or is part of; important team discussion.
5. General team updates, FYIs, announcements, celebrations.
6. Social chatter, memes, links shared for fun.
7. Automated notifications: bots, alerts, deploys, CI, GitHub, calendar, Slackbot: lowest.

If both fall in the same tier, the one with more recent activity goes higher.
Reply with exactly one letter: A or B. Nothing else.`;

// One inbox item as a compact card the model can judge.
// `it` is the view item; `messages` the latest few (oldest first), names resolved.
function buildCard(it, messages, now = Date.now()) {
  const last = parseFloat(it.lastIncomingTs !== '0' ? it.lastIncomingTs : it.lastTs) * 1000;
  const ageH = Math.max(0, Math.round((now - last) / 3600000));
  const age = ageH < 1 ? 'active <1h ago' : ageH < 48 ? `active ${ageH}h ago` : `active ${Math.round(ageH / 24)}d ago`;
  const where = it.convKind === 'im' ? `DM with ${it.title}` : it.convKind === 'mpim' ? `group DM (${it.title})` : `${it.title}${it.ext ? ' (shared with an external company)' : ''}`;
  const flags = [it.kind === 'thread' ? 'thread' : 'conversation', it.mention && 'mentions Ronak', it.mine && 'Ronak is in this thread', age].filter(Boolean).join(', ');
  const lines = messages.slice(-6).map((m) => `${m.who}: ${(m.text || '[attachment]').replace(/\s+/g, ' ').slice(0, 200)}`);
  return `${where} — ${flags}\n${lines.length ? lines.join('\n') : '(no text)'}`;
}

async function compareCards(cardA, cardB) {
  const res = await chat({
    model: RANK_MODEL,
    temperature: 0,
    max_tokens: 1500,              // hard pairs reason at length before the letter
    reasoning: { effort: 'low' },  // ...but ask them not to
    messages: [
      { role: 'system', content: RUBRIC },
      { role: 'user', content: `A:\n${cardA}\n\nB:\n${cardB}\n\nWhich belongs higher in the inbox? Reply A or B.` },
    ],
  });
  if (!res.ok) return res;
  const t = String(res.message.content || '').trim().toUpperCase();
  let m = t.match(/\b([AB])\b/);
  if (!m && res.message.reasoning) {
    // Content came back empty (tokens spent reasoning): take only an explicit
    // "answer … A" from the reasoning tail.
    const all = [...String(res.message.reasoning).toUpperCase().matchAll(/ANSWER[^A-Z0-9]{0,12}([AB])\b/g)];
    if (all.length) m = all[all.length - 1];
  }
  if (!m) return { ok: false, errorType: 'parse', error: 'unparseable: ' + t.slice(0, 40) };
  return { ok: true, winner: m[1] };
}

// Merge sort with an async comparator; halves sort in parallel so wall time is
// far below the comparison count. cmp(a, b) resolves 'A' when a ranks higher.
async function mergeSort(list, cmp) {
  if (list.length <= 1) return list.slice();
  const mid = list.length >> 1;
  const [l, r] = await Promise.all([mergeSort(list.slice(0, mid), cmp), mergeSort(list.slice(mid), cmp)]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < l.length && j < r.length) out.push((await cmp(l[i], r[j])) === 'A' ? l[i++] : r[j++]);
  while (i < l.length) out.push(l[i++]);
  while (j < r.length) out.push(r[j++]);
  return out;
}

async function binaryInsertIndex(ranked, candidate, cmp) {
  let lo = 0;
  let hi = ranked.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((await cmp(candidate, ranked[mid])) === 'A') hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---- time-sensitive triage ----------------------------------------------------

async function classifyUrgent({ where, messages }) {
  const now = new Date();
  const system = `You triage Slack messages for Ronak, CEO of Trajectory. Judge whether the NEWEST message from someone else is TIME-SENSITIVE for Ronak — it loses value if he doesn't see or answer it soon — and for HOW LONG it stays that way.

Time-sensitive: something blocked on Ronak right now (an approval, decision, or answer someone is waiting on today), same-day scheduling or logistics ("hop on a call now?", "meeting moved to 3pm", "are you coming?"), a deadline within hours, an outage or incident that needs him. NOT time-sensitive: FYIs, announcements, general discussion, links, kudos, bot notifications, anything that can comfortably wait until tomorrow, or messages not aimed at Ronak.

Think briefly if needed, then ALWAYS finish by calling submit_urgency with hours: how long from now this stays time-sensitive.
- "can you hop on now?" → 1
- "need your sign-off before the 5pm send" (it's 2pm) → 3
- end-of-day deadline → hours until then
- not time-sensitive → 0
Whole numbers or halves, max 24.`;
  const transcript = messages.slice(-10).map((m) => `${m.who}: ${(m.text || '[attachment]').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
  const user = `Now: ${now.toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
Where: ${where}

----
${transcript}
----

Call submit_urgency with the hours (0 if it isn't time-sensitive).`;
  const res = await chat({
    model: TRIAGE_MODEL,
    max_tokens: 300,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    tools: [{
      type: 'function',
      function: {
        name: 'submit_urgency',
        description: 'Submit how many hours from now the newest message stays time-sensitive (0 = not time-sensitive).',
        parameters: { type: 'object', properties: { hours: { type: 'number', description: 'hours from now; 0 if not time-sensitive; max 24' } }, required: ['hours'] },
      },
    }],
  });
  if (!res.ok) return res;
  let n = NaN;
  const tc = res.message.tool_calls && res.message.tool_calls[0];
  if (tc && tc.function && tc.function.name === 'submit_urgency') {
    try { n = parseFloat(JSON.parse(tc.function.arguments || '{}').hours); } catch { /* malformed */ }
  } else {
    n = parseFloat(String(res.message.content || '').replace(/[^0-9.]/g, ''));
  }
  const hours = Number.isFinite(n) ? Math.max(0, Math.min(24, n)) : 0;
  return { ok: true, hours, urgent: hours > 0 };
}

module.exports = { hasKey, buildCard, compareCards, mergeSort, binaryInsertIndex, classifyUrgent, RANK_MODEL, TRIAGE_MODEL };
