import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import { Mrkdwn, Emoji, plain } from '../lib/mrkdwn';
import { msgTime, dayLabel, dayKey, fullTime } from '../lib/format';
import { ArchiveIcon, UnreadIcon, ExternalIcon, MuteIcon, BellIcon, SendIcon, ThreadIcon, FileIcon, HashIcon, LockIcon, CloseIcon, ChevronIcon, SparkleIcon } from './Icons';

const QUICK = ['+1', 'white_check_mark', 'eyes', 'heart', 'joy', 'pray'];

function displayName(dir, m) {
  const u = m.user && dir.users[m.user];
  return (u && u.name) || m.botName || 'Someone';
}

function Attachment({ a, dir, ctx }) {
  const long = (a.text || '').length > 700;
  const [open, setOpen] = useState(false);
  return (
    <div className={`att${long && !open ? ' clamped' : ''}`} style={a.color ? { '--bar': a.color.startsWith('#') ? a.color : `#${a.color}` } : null}>
      {a.author && <div className="att-author">{a.author}</div>}
      {a.pretext && <Mrkdwn text={a.pretext} dir={dir} ctx={ctx} />}
      {a.title && (a.titleLink
        ? <a className="att-title" href={a.titleLink} onClick={(e) => { e.preventDefault(); ctx.openExternal(a.titleLink); }}>{a.title}</a>
        : <div className="att-title">{a.title}</div>)}
      {a.text && <Mrkdwn text={a.text} dir={dir} ctx={ctx} />}
      {long && <button type="button" className="att-more" onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show more'}</button>}
      {a.footer && <div className="att-footer">{plain(a.footer, dir)}</div>}
    </div>
  );
}

function Files({ files, webConnected, ctx }) {
  return (
    <div className="files">
      {files.map((f) => {
        const isImg = f.mimetype.startsWith('image/') && f.thumb && webConnected;
        if (isImg) {
          const ratio = f.w && f.h ? f.h / f.w : 0.6;
          return (
            <button type="button" key={f.id} className="file-img" onClick={() => ctx.openExternal(f.permalink)}
              style={{ aspectRatio: f.w && f.h ? `${f.w} / ${f.h}` : undefined, maxWidth: ratio > 1.2 ? 260 : 420 }}>
              <img src={`slackfile://f/${encodeURIComponent(f.thumb)}`} alt={f.name} loading="lazy" draggable={false} />
            </button>
          );
        }
        return (
          <button type="button" key={f.id} className="file-chip" onClick={() => ctx.openExternal(f.permalink)}>
            <FileIcon size={15} /> <span>{f.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function Message({ m, dir, ctx, compact, isRoot, onReact, onOpenThread, isNew, active }) {
  const name = displayName(dir, m);
  return (
    <div className={`msg${compact ? ' compact' : ''}${isRoot ? ' root' : ''}${isNew ? ' is-new' : ''}${active ? ' active' : ''}`} data-ts={m.ts}>
      <div className="msg-gutter">
        {compact
          ? <span className="msg-hover-time">{msgTime(m.ts)}</span>
          : <Avatar user={m.user} botName={m.botName} botIcon={m.botIcon} dir={dir} size={isRoot ? 40 : 34} />}
      </div>
      <div className="msg-main">
        {!compact && (
          <div className="msg-head">
            <span className="msg-name">{name}</span>
            <span className="msg-time" title={fullTime(m.ts)}>{msgTime(m.ts)}</span>
            {m.edited && <span className="msg-edited">edited</span>}
          </div>
        )}
        {m.text && <Mrkdwn text={m.text} dir={dir} ctx={ctx} />}
        {m.attachments.length > 0 && m.attachments.map((a, i) => <Attachment key={i} a={a} dir={dir} ctx={ctx} />)}
        {m.files.length > 0 && <Files files={m.files} webConnected={ctx.webConnected} ctx={ctx} />}
        {m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button type="button" key={r.name} className={`reaction${r.me ? ' mine' : ''}`} onClick={() => onReact(m, r.name, r.me)}>
                <Emoji name={r.name} custom={dir.customEmoji} size={16} />
                <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}
        {onOpenThread && m.replyCount > 0 && (
          <button type="button" className="thread-chip" onClick={() => onOpenThread(m)}>
            <ThreadIcon size={13} /> {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </div>
      <div className="msg-tools">
        {QUICK.map((q) => (
          <button type="button" key={q} onClick={() => onReact(m, q, m.reactions.some((r) => r.name === q && r.me))} title={`:${q}:`}>
            <Emoji name={q} custom={dir.customEmoji} />
          </button>
        ))}
        <span className="msg-tools-sep" />
        {onOpenThread && <button type="button" onClick={() => onOpenThread(m)} title="Reply in thread"><ThreadIcon size={14} /></button>}
        <button type="button" onClick={() => ctx.openInSlack(m.ts)} title="Open in Slack"><ExternalIcon size={14} /></button>
      </div>
    </div>
  );
}

function Composer({ draftKey, placeholder, onSend, inputRef, autoFocus, onEscape, compact }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const ownRef = useRef(null);
  const ref = inputRef || ownRef;

  useEffect(() => {
    setText(DRAFTS[draftKey] || '');
    setError(null);
    if (autoFocus && ref.current) ref.current.focus();
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text, ref]);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    const r = await onSend(t);
    setSending(false);
    if (r && r.ok) { setText(''); DRAFTS[draftKey] = ''; }
    else setError((r && r.error) || 'Could not send');
  };

  return (
    <div className={`composer-wrap${compact ? ' compact' : ''}`}>
      <div className={`composer${sending ? ' sending' : ''}`}>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); DRAFTS[draftKey] = e.target.value; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur(); if (onEscape) onEscape(); }
          }}
        />
        <button type="button" className="send" disabled={!text.trim() || sending} onClick={submit} aria-label="Send">
          <SendIcon size={15} />
        </button>
      </div>
      {error && <div className="composer-error">{error}</div>}
    </div>
  );
}

// Unsent text per conversation/thread, kept across switching rows.
const DRAFTS = {};

const tsn = (s) => parseFloat(s || 0);

// The message reading should resume at, from the row's state when it was opened.
function firstUnread(messages, snap, me) {
  if (!snap || !snap.unread || !messages.length) return null;
  const incoming = messages.filter((m) => m.user !== me);
  let hit = null;
  if (snap.firstUnreadTs && tsn(snap.firstUnreadTs) > tsn(snap.openedTs)) {
    hit = messages.find((m) => tsn(m.ts) >= tsn(snap.firstUnreadTs));
  } else if (tsn(snap.openedTs) > 0) {
    hit = incoming.find((m) => tsn(m.ts) > tsn(snap.openedTs));
  } else if (incoming.length) {
    hit = incoming[Math.max(0, incoming.length - Math.max(1, snap.newCount || 1))];
  }
  return hit ? hit.ts : null;
}

// Scrolls a message list: to the first-unread divider once, then sticks to
// the bottom as new messages arrive (unless the reader scrolled up).
function useThreadScroll(messages, resetKey, focusTs) {
  const scrollRef = useRef(null);
  const stick = useRef(true);
  const pending = useRef(true);
  useEffect(() => { stick.current = true; pending.current = true; }, [resetKey]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !messages) return;
    if (pending.current) {
      pending.current = false;
      const focus = focusTs && el.querySelector(`.msg[data-ts="${focusTs}"]`);
      if (focus) {
        el.scrollTop += focus.getBoundingClientRect().top - el.getBoundingClientRect().top - 96;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        return;
      }
      const div = el.querySelector('.new-divider');
      if (div) {
        el.scrollTop += div.getBoundingClientRect().top - el.getBoundingClientRect().top - 72;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        return;
      }
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { scrollRef, onScroll, stick };
}

function MessageList({ messages, dir, ctx, isThread, boundary, onReact, onOpenThread, activeTs }) {
  let prev = null;
  return messages.map((m, i) => {
    const out = [];
    const isRoot = isThread && i === 0;
    if (!isRoot && (!prev || dayKey(prev.ts) !== dayKey(m.ts))) {
      out.push(<div key={`d${m.ts}`} className="day"><span>{dayLabel(m.ts)}</span></div>);
    }
    const isBoundary = boundary && m.ts === boundary && i > 0;
    if (isBoundary) out.push(<div key={`n${m.ts}`} className="new-divider"><span>New</span></div>);
    const compact = !isRoot && !isBoundary && prev && prev.user === m.user && !m.botName === !prev.botName
      && tsn(m.ts) - tsn(prev.ts) < 300 && dayKey(prev.ts) === dayKey(m.ts) && !(i === 1 && isThread);
    out.push(
      <Message key={m.ts} m={m} dir={dir} ctx={ctx} compact={compact} isRoot={isRoot}
        isNew={boundary && tsn(m.ts) >= tsn(boundary) && m.user !== dir.me}
        active={activeTs === m.ts}
        onReact={onReact} onOpenThread={onOpenThread} />
    );
    if (isRoot && messages.length > 1) {
      out.push(<div key="replies" className="replies-rule"><span>{messages.length - 1} {messages.length === 2 ? 'reply' : 'replies'}</span></div>);
    }
    prev = m;
    return out;
  });
}

function useReactions(setMessages, channel) {
  return async (m, name, remove) => {
    setMessages((ms) => ms && ms.map((x) => {
      if (x.ts !== m.ts) return x;
      let rs = x.reactions.map((r) => ({ ...r }));
      const r = rs.find((y) => y.name === name);
      if (remove) { if (r) { r.count -= 1; r.me = false; } rs = rs.filter((y) => y.count > 0); }
      else if (r) { if (!r.me) { r.count += 1; r.me = true; } }
      else rs.push({ name, count: 1, me: true });
      return { ...x, reactions: rs };
    }));
    await window.api.react({ channel, ts: m.ts, name, remove });
  };
}

// Slack-style side panel: a thread opened from a DM's main stream.
function ThreadPanel({ channel, threadTs, dir, ctx, onClose, title }) {
  const [messages, setMessages] = useState(null);
  const [error, setError] = useState(null);
  const tkey = `${channel}:${threadTs}`;
  const { scrollRef, onScroll, stick } = useThreadScroll(messages, tkey);

  const load = useCallback(async () => {
    const r = await window.api.threadMessages({ channel, threadTs });
    if (r.ok) { setMessages(r.messages); setError(null); } else setError(r.error);
  }, [channel, threadTs]);

  useEffect(() => {
    setMessages(null);
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  const react = useReactions(setMessages, channel);
  const send = async (text) => {
    const r = await window.api.threadSend({ channel, threadTs, text });
    if (r.ok) { stick.current = true; await load(); }
    return r;
  };

  return (
    <aside className="thread-panel">
      <header className="thread-head">
        <div>
          <div className="thread-title">Thread</div>
          <div className="thread-sub">{title}</div>
        </div>
        <button type="button" className="tool" onClick={onClose} title="Close (esc)"><CloseIcon /></button>
      </header>
      <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread-inner">
          {error && <div className="reader-error">Couldn’t load thread · {error}</div>}
          {!messages && !error && <LoadingMessages />}
          {messages && <MessageList messages={messages} dir={dir} ctx={{ ...ctx, openInSlack: (ts) => ctx.openInSlack(ts || threadTs) }} isThread onReact={react} />}
        </div>
      </div>
      <Composer draftKey={tkey} placeholder="Reply in thread…" onSend={send} autoFocus onEscape={onClose} compact />
    </aside>
  );
}

export default function Reader({ item, dir, webConnected, onArchive, onUnread, onToggleMute, onFixWithAgent, agentRef, onCopyLink, copyLinkRef, composerRef, onAfterSend }) {
  const [messages, setMessages] = useState(null);
  const [error, setError] = useState(null);
  const [panel, setPanel] = useState(null); // { threadTs } of an open side thread
  // Conversation mode: the thread's whole channel/DM, opened from the header.
  const [conv, setConv] = useState(false);
  const snap = useRef(null);
  const boundary = useRef(undefined);
  const key = item && item.key;
  const lastTs = item && item.lastTs;
  const channel = item && item.channel;
  const threadTs = item && item.threadTs;
  const { scrollRef, onScroll, stick } = useThreadScroll(messages, `${key}|${conv}`, conv ? threadTs : null);

  const load = useCallback(async () => {
    if (!key) return;
    const r = conv ? await window.api.channelMessages({ channel }) : await window.api.messages(key);
    if (r.ok) { setMessages(r.messages); setError(null); }
    else setError(r.error);
  }, [key, conv, channel]);
  const loadRef = useRef(load);
  loadRef.current = load;

  // Reset when switching rows; snapshot unread state before opening clears it.
  useEffect(() => {
    setMessages(null);
    setError(null);
    setPanel(null);
    setConv(false);
    snap.current = item ? { unread: item.unread, openedTs: item.openedTs, newCount: item.newCount, firstUnreadTs: item.firstUnreadTs } : null;
    boundary.current = undefined;
    load();
    const t = setInterval(() => loadRef.current(), 8000);
    return () => clearInterval(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (key) load(); }, [lastTs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Entering/leaving conversation mode swaps the message source (the 8s
  // refresh above always calls the current loader through loadRef).
  const firstConv = useRef(true);
  useEffect(() => {
    if (firstConv.current) { firstConv.current = false; return; }
    setMessages(null);
    setError(null);
    load();
  }, [conv]); // eslint-disable-line react-hooks/exhaustive-deps

  const openConversation = () => {
    setConv(true);
    // Keep the thread you came from open beside the channel, like Slack.
    setPanel({ threadTs: item.threadTs });
  };
  const backToThread = () => { setConv(false); setPanel(null); };
  // ⌘⇧C / the button: hand the open side-panel thread if there is one,
  // otherwise this row, to Claude Code.
  const fixWithAgent = () => onFixWithAgent(panel ? panel.threadTs : null);
  if (agentRef) agentRef.current = fixWithAgent;
  if (copyLinkRef) copyLinkRef.current = () => onCopyLink(panel ? panel.threadTs : null);

  useEffect(() => {
    if (!panel && !conv) return undefined;
    const onKey = (e) => {
      const t = e.target;
      if (e.key !== 'Escape' || (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT'))) return;
      if (panel) setPanel(null); else setConv(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, conv]);

  if (!item) return null;

  if (messages && !conv && boundary.current === undefined) boundary.current = firstUnread(messages, snap.current, dir.me);

  const ctx = {
    webConnected,
    openExternal: (u) => window.api.openExternal(u),
    openInSlack: (ts) => window.api.openInSlack({ key: item.key, ts }),
  };

  const react = useReactions(setMessages, item.channel);

  const send = async (text) => {
    const r = conv ? await window.api.channelSend({ channel, text }) : await window.api.send({ key: item.key, text });
    if (r.ok) { stick.current = true; await load(); onAfterSend && onAfterSend(); }
    return r;
  };

  const isChannel = item.convKind === 'channel';
  const isThread = item.kind === 'thread' && !conv;
  const canOpenConv = item.kind === 'thread' && !conv;
  const name = isChannel ? item.title.replace(/^#/, '') : item.title;
  const chanIcon = isChannel ? (item.isPrivate ? <LockIcon size={14} /> : <HashIcon size={14} />) : null;

  return (
    <main className={`reader${panel ? ' with-panel' : ''}`}>
      <div className="reader-main">
        <header className="reader-header">
          <div className="drag" />
          <div className="reader-title">
            {conv && (
              <button type="button" className="tool back" onClick={backToThread} title="Back to thread (esc)"><ChevronIcon size={14} /> Thread</button>
            )}
            {canOpenConv ? (
              <button type="button" className="title-link" onClick={openConversation} title={`Open ${isChannel ? `#${name}` : name}`}>
                {chanIcon}<h2>{name}</h2>
              </button>
            ) : (
              <>{chanIcon}<h2>{name}</h2></>
            )}
            {item.ext && <span className="ext-tag">External</span>}
            {isThread && item.rootText != null && (
              <span className="reader-sub"><span className="reader-sub-sep">Thread</span>{plain(item.rootText, dir).slice(0, 160)}</span>
            )}
          </div>
          <div className="reader-actions">
            <button type="button" className="tool" onClick={onToggleMute} title={item.muted ? 'Unmute here (⌘⇧M)' : 'Mute this conversation here (⌘⇧M)'}>
              {item.muted ? <BellIcon /> : <MuteIcon />}
            </button>
            <button type="button" className="tool agent" onClick={fixWithAgent} title="Fix with agent: open in Claude Code (⌘⇧C)"><SparkleIcon /> <span>Fix with agent</span></button>
            <button type="button" className="tool" onClick={() => ctx.openInSlack()} title="Open thread in Slack (⌘⇧A)"><ExternalIcon /></button>
            <button type="button" className="tool" onClick={onUnread} title="Mark unread (u)"><UnreadIcon /></button>
            <button type="button" className="tool primary" onClick={onArchive} title={item.archived ? 'Move to Inbox (⌘⇧E)' : 'Archive (⌘⇧E)'}>
              <ArchiveIcon /> <span>{item.archived ? 'Unarchive' : 'Archive'}</span> <kbd>⌘⇧E</kbd>
            </button>
          </div>
        </header>

        <div className="reader-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="reader-inner">
            {error && <div className="reader-error">Couldn’t load this conversation · {error}</div>}
            {!messages && !error && <LoadingMessages />}
            {messages && (
              <MessageList messages={messages} dir={dir} ctx={ctx} isThread={isThread} boundary={conv ? null : boundary.current}
                activeTs={panel && panel.threadTs}
                onReact={react}
                onOpenThread={isThread ? null : (m) => setPanel({ threadTs: m.threadTs || m.ts })} />
            )}
          </div>
        </div>

        <Composer draftKey={conv ? `${channel}:conv` : item.key} placeholder={`${isThread ? 'Reply in thread' : `Message ${isChannel ? `#${name}` : name}`}…`} onSend={send} inputRef={composerRef} />
      </div>
      {panel && (
        <ThreadPanel channel={item.channel} threadTs={panel.threadTs} dir={dir} ctx={ctx} title={item.title}
          onClose={() => setPanel(null)} />
      )}
    </main>
  );
}

function LoadingMessages() {
  return (
    <div className="loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="msg skeleton" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="msg-gutter"><div className="sk sk-avatar" /></div>
          <div className="msg-main"><div className="sk sk-name" /><div className="sk sk-line" /><div className="sk sk-line short" /></div>
        </div>
      ))}
    </div>
  );
}
