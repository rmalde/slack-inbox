# Slack Inbox

Slack, reshaped as an email-style inbox. No channels sidebar: every unread
**thread** is one row (a DM's main conversation is one row too). Read it,
reply, press **⌘⇧E**, it's gone. A new message in that thread brings it back.

Local-only Electron app. Reads Slack with Ronak's user token
(`~/.config/slack-user-token`, the same one `~/tech/slack-send` uses), so
replies post as plain "Ronak" with no "Sent using" footer.

## What shows up

| Where | What becomes an inbox row |
|---|---|
| DMs / group DMs | every incoming message (bot-DM thread replies only if you're in the thread) |
| Channels | every new top-level post |
| Channel threads | threads you started or replied in, threads already in your inbox, anything that @mentions you |
| **Muted** channels | only messages that @mention you |

Rows are split into **For you** (DMs, mentions, your threads) and
**Channels** (everything else). Your own messages never create or unarchive a
row.

### Mutes

Slack only exposes mute settings to its own web client, so the app has a
one-time **Sign in to Slack** (bottom of the list). That opens a real Slack
login window in an isolated session; afterwards the app reads your mutes every
3 minutes and can show image previews. You can also mute a conversation just
inside Slack Inbox with **M** (stored locally).

## Smart ordering (ported from Messages Inbox)

- **Time sensitive** (top section): Haiku judges each fresh incoming message
  (≤6h old) once — *how many hours does this stay urgent?* (0 = not). Urgent
  rows show "45m left" / "until 7:00 PM" and drop out when they expire, when
  you reply, or when a newer message supersedes them.
- **Priority queue** (For you / Channels): `typesafe/jev-router` makes A/B
  calls against a Slack rubric (blocked on Ronak → hiring → customers/investors
  → work threads → FYIs → social → bots). A one-time merge sort orders the
  backlog; after that each row with new activity binary-searches its slot.
  Rows waiting for their slot sit at the top of their section. A sort with
  >10% failed comparisons isn't saved.
- Both run on OpenRouter with Trajectory's org key
  (`~/Library/Application Support/{Slack,Messages} Inbox/openrouter-key`).
  State lives in `inbox-store.json` under `ai`. Toggle in settings
  ("Smart ordering"); off = plain recency.

## Keys

`J`/`K` or arrows move · `⌘⇧E` archive (or unarchive in Archived) · `Z` undo ·
`R`/`Enter` reply · `U` mark unread · `⌘⇧A` (or `O`) open the thread in the Slack app · `M` mute here ·
`⌘⇧C` fix with agent (opens a prefilled Claude Code session in `~/tech` with the thread, its link, and a reply command; nothing runs until you send) · `/` filter · `⌘1`/`⌘2` Inbox/Archived · `⌘R` refresh. In the composer `↵`
sends, `⇧↵` newline, `Esc` returns to the list.

## How it stays current

- **Discovery** uses `search.messages` sorted by time: one call returns every
  new message workspace-wide, including thread replies (polling history on
  hundreds of channels would hit rate limits). Polls every 10s while focused,
  30s in the background, immediately on focus; re-scans a 3-minute overlap
  because search indexing lags a little.
- **First run** reconstructs unread from the last 3 days using each
  conversation's Slack `last_read` (takes a couple of minutes; the header shows
  progress).
- The open thread refreshes every 8s.
- Desktop notifications for DMs, mentions, and threads you're in when the
  window isn't focused; dock badge = unread rows in For you.
- Archiving advances Slack's own read marker for that conversation (toggle in
  settings) as far as it can without hiding anything still in your inbox.

## Data (agent-editable)

`~/Library/Application Support/Slack Inbox/inbox-store.json` is the database
and doubles as an API. Same contract as Messages Inbox: flock(2) the file,
reload, mutate, write in place (ftruncate + write on the locked fd), unlock.
The app watches the file and refreshes within a beat. Shape is documented at
the top of `electron/lib/store.js`. `directory.json` (users/channels cache) and
`web-session.json` (Slack web token, chmod 600) live next to it.

## Run / install

```bash
npm install
npm run dev        # Vite + Electron with live reload
npm run make-app   # installs the self-updating /Applications/Slack Inbox.app
npm run make-icon  # re-render build/icon.icns
```

The installed app is a stable Electron shell whose code is a bootstrap: each
launch it `git pull`s this repo (if it has a remote), reinstalls deps if the
lockfile changed, rebuilds the renderer, then runs `electron/main.js` from
source. Keep the repo at `~/tech/slack-inbox`.

## Layout

```
electron/
  main.js            window, menu, IPC, poll loop, notifications, file proxy
  preload.js         contextBridge API
  lib/slack.js       Web API client (user token, 429 backoff)
  lib/sync.js        search-driven discovery, inbox rules, thread loading
  lib/store.js       flock'd JSON store + archive/unread semantics
  lib/directory.js   users + conversations cache
  lib/websession.js  Slack web sign-in → mutes, custom emoji, private images
src/
  App.jsx            state, keyboard, archive/undo
  components/        InboxList, Reader, Avatar, Icons
  lib/mrkdwn.jsx     Slack mrkdwn → React; emoji-map.json from emoji-datasource
```
