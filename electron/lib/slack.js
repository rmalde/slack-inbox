'use strict';

// Thin Slack Web API client on Ronak's user token (xoxp, ~/.config/slack-user-token).
// Posts made with a user token render as plain "Ronak" — no "Sent using" footer
// (see ~/tech/slack-send). Handles 429s by honoring Retry-After.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN_PATH = path.join(os.homedir(), '.config', 'slack-user-token');
const API = 'https://slack.com/api/';

let token = null;
function getToken() {
  if (token) return token;
  try { token = fs.readFileSync(TOKEN_PATH, 'utf8').trim(); } catch { token = null; }
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, params = {}, { post = false, attempt = 0 } = {}) {
  const t = getToken();
  if (!t) throw new Error(`No Slack token at ${TOKEN_PATH}`);
  let res;
  if (post) {
    res = await fetch(API + method, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(params),
    });
  } else {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
    res = await fetch(`${API}${method}?${qs}`, { headers: { Authorization: `Bearer ${t}` } });
  }
  if (res.status === 429 && attempt < 4) {
    const wait = (Number(res.headers.get('retry-after')) || 5) * 1000;
    await sleep(wait);
    return call(method, params, { post, attempt: attempt + 1 });
  }
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(`${method}: ${json.error}`);
    err.slack = json.error;
    throw err;
  }
  return json;
}

async function paginate(method, params, key) {
  const out = [];
  let cursor;
  do {
    const r = await call(method, { ...params, cursor, limit: 200 });
    out.push(...(r[key] || []));
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    if (cursor) await sleep(300);
  } while (cursor);
  return out;
}

module.exports = { call, paginate, getToken, sleep, TOKEN_PATH };
