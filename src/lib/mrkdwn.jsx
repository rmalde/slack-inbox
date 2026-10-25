import React from 'react';
import EMOJI from './emoji-map.json';

// Slack mrkdwn → React. Covers what real messages use: code blocks, inline
// code, quotes, *bold* _italic_ ~strike~, links, @mentions, #channels,
// :emoji: (standard + workspace custom), and HTML entities.

const SKIN = { 'skin-tone-2': '\u{1F3FB}', 'skin-tone-3': '\u{1F3FC}', 'skin-tone-4': '\u{1F3FD}', 'skin-tone-5': '\u{1F3FE}', 'skin-tone-6': '\u{1F3FF}' };

export function unescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function emojiChar(name, custom, depth = 0) {
  if (EMOJI[name]) return EMOJI[name];
  if (SKIN[name]) return SKIN[name];
  const c = custom && custom[name];
  if (c && c.startsWith('alias:') && depth < 3) return emojiChar(c.slice(6), custom, depth + 1);
  return null;
}

function customUrl(name, custom, depth = 0) {
  const c = custom && custom[name];
  if (!c) return null;
  if (c.startsWith('alias:')) return depth < 3 ? customUrl(c.slice(6), custom, depth + 1) : null;
  return c;
}

export function Emoji({ name, custom, size }) {
  const ch = emojiChar(name, custom);
  if (ch && !ch.startsWith('http')) return <span className="emoji" title={`:${name}:`}>{ch}</span>;
  const url = customUrl(name, custom);
  if (url) return <img className="emoji-img" style={size ? { width: size, height: size } : null} src={url} alt={`:${name}:`} title={`:${name}:`} />;
  return <span className="emoji-missing">:{name}:</span>;
}

const userName = (dir, id) => (dir.users[id] && dir.users[id].name) || id;

// Plain-text rendering for list previews and notifications.
export function plain(text, dir) {
  if (!text) return '';
  return unescape(
    text
      .replace(/```([\s\S]*?)```/g, '$1')
      .replace(/<@(\w+)(?:\|([^>]+))?>/g, (_m, id, label) => `@${label || userName(dir, id)}`)
      .replace(/<#(\w+)(?:\|([^>]*))?>/g, (_m, id, label) => `#${label || dir.channels[id] || 'channel'}`)
      .replace(/<!subteam\^\w+(?:\|([^>]+))?>/g, (_m, l) => l || '@team')
      .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/<mailto:([^>|]+)>/g, '$1')
      .replace(/:([a-z0-9_+'-]+):/g, (m, n) => {
        const c = emojiChar(n, dir.customEmoji);
        return c && !c.startsWith('http') ? c : m;
      })
      .replace(/[*_~`]/g, '')
      .replace(/\s*\n+\s*/g, ' ')
  ).trim();
}

const INLINE = /(<[^>\n]+>)|(`[^`\n]+`)|(:[a-z0-9_+'-]+:)|((?:^|(?<=[\s(]))[*_~][^*_~\n]+?[*_~](?=$|[\s.,!?;:)]))/g;

function inline(text, dir, ctx, keyBase) {
  const out = [];
  let last = 0;
  let i = 0;
  text.replace(INLINE, (m, angle, code, emoji, fmt, offset) => {
    if (offset > last) out.push(unescape(text.slice(last, offset)));
    const k = `${keyBase}-${i++}`;
    if (angle) out.push(renderAngle(angle.slice(1, -1), dir, ctx, k));
    else if (code) out.push(<code key={k}>{unescape(code.slice(1, -1))}</code>);
    else if (emoji) out.push(<Emoji key={k} name={emoji.slice(1, -1)} custom={dir.customEmoji} />);
    else if (fmt) {
      const mark = fmt[0];
      const inner = inline(fmt.slice(1, -1), dir, ctx, k);
      if (mark !== fmt[fmt.length - 1]) out.push(unescape(fmt));
      else if (mark === '*') out.push(<strong key={k}>{inner}</strong>);
      else if (mark === '_') out.push(<em key={k}>{inner}</em>);
      else out.push(<s key={k}>{inner}</s>);
    }
    last = offset + m.length;
    return m;
  });
  if (last < text.length) out.push(unescape(text.slice(last)));
  return out;
}

function renderAngle(body, dir, ctx, k) {
  const [target, label] = body.split('|');
  if (target.startsWith('@')) {
    const id = target.slice(1);
    const me = id === dir.me;
    return <span key={k} className={`mention${me ? ' me' : ''}`}>@{label || userName(dir, id)}</span>;
  }
  if (target.startsWith('#')) {
    return <span key={k} className="mention chan">#{label || dir.channels[target.slice(1)] || 'channel'}</span>;
  }
  if (target.startsWith('!subteam')) return <span key={k} className="mention">{label || '@team'}</span>;
  if (target.startsWith('!')) {
    const n = target.slice(1).split('^')[0];
    return <span key={k} className="mention loud">@{n}</span>;
  }
  const href = unescape(target);
  const shown = label ? unescape(label) : href.replace(/^mailto:/, '');
  return (
    <a key={k} href={href} onClick={(e) => { e.preventDefault(); ctx.openExternal(href); }} title={href}>
      {shown}
    </a>
  );
}

export function Mrkdwn({ text, dir, ctx }) {
  if (!text) return null;
  const blocks = [];
  const parts = text.split(/```/);
  parts.forEach((part, pi) => {
    if (pi % 2 === 1) {
      blocks.push(<pre key={`pre${pi}`}><code>{unescape(part.replace(/^\n/, ''))}</code></pre>);
      return;
    }
    const lines = part.split('\n');
    let quote = [];
    let para = [];
    const flushPara = () => {
      if (!para.length) return;
      const k = `p${pi}-${blocks.length}`;
      blocks.push(
        <p key={k}>
          {para.map((l, li) => (
            <React.Fragment key={li}>{li > 0 && <br />}{inline(l, dir, ctx, `${k}-${li}`)}</React.Fragment>
          ))}
        </p>
      );
      para = [];
    };
    const flushQuote = () => {
      if (!quote.length) return;
      const k = `q${pi}-${blocks.length}`;
      blocks.push(
        <blockquote key={k}>
          {quote.map((l, li) => (<React.Fragment key={li}>{li > 0 && <br />}{inline(l, dir, ctx, `${k}-${li}`)}</React.Fragment>))}
        </blockquote>
      );
      quote = [];
    };
    for (const line of lines) {
      const q = /^(&gt;|>)\s?(.*)$/.exec(line);
      if (q) { flushPara(); quote.push(q[2]); } else { flushQuote(); para.push(line); }
    }
    flushPara();
    flushQuote();
  });
  return <div className="md">{blocks}</div>;
}
