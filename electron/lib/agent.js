'use strict';

// "Fix with agent": hand a Slack thread to Claude Code. Opens a new session in
// the Claude desktop app via its deep link (claude://code/new?q=…&folder=…),
// with the thread, its permalink, and how to reply already in the prompt.

const os = require('os');
const path = require('path');

const PROMPT_CAP = 14000; // the app truncates ?q= at 14336 chars

function promptFor({ where, permalink, channel, threadTs, messages, folder }) {
  const lines = messages.map((m) => `${m.who} (${m.when}): ${m.text || '[attachment]'}`);
  const head = `Fix this for me. It came in on Slack (Trajectory workspace).

Where: ${where}
Link: ${permalink}

Conversation (oldest first):
`;
  const tail = `

Figure out what's being asked of me and handle it: find the relevant repo under ${folder} (most product code is in ${path.join(folder, 'trajectory')}), investigate, and make the fix. Check with me before pushing, merging, deploying, or messaging anyone.
When you're done, draft a short reply for the thread. To post it (after I OK it), run:
~/tech/slack-send/slack_send.py ${channel} "<reply>"${threadTs ? ` --thread ${threadTs}` : ''}`;
  // Keep the newest messages if the thread is too long for the deep link.
  let body = lines.join('\n');
  const room = PROMPT_CAP - head.length - tail.length;
  if (body.length > room) body = '…\n' + body.slice(body.length - room + 2);
  return head + body + tail;
}

function deepLink(prompt, folder) {
  const q = new URLSearchParams({ q: prompt });
  q.append('folder', folder);
  return `claude://code/new?${q}`;
}

const defaultFolder = () => path.join(os.homedir(), 'tech');

module.exports = { promptFor, deepLink, defaultFolder };
