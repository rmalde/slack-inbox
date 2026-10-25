import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import { Mrkdwn, Emoji, plain } from '../lib/mrkdwn';
import { msgTime, dayLabel, dayKey, fullTime } from '../lib/format';
import { ArchiveIcon, UnreadIcon, ExternalIcon, MuteIcon, BellIcon, SendIcon, ThreadIcon, SmileIcon, FileIcon, HashIcon, LockIcon } from './Icons';

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

function Message({ m, dir, ctx, compact, isRoot, onReact, onOpenThread, isNew }) {
  const name = displayName(dir, m);
  return (
    <div className={`msg${compact ? ' compact' : ''}${isRoot ? ' root' : ''}${isNew ? ' is-new' : ''}`}>
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
        <button type="button" onClick={() => ctx.openInSlack(m.ts)} title="Open in Slack"><ExternalIcon size={14} /></button>
      </div>
    </div>
  );
}

function Composer({ item, dir, onSend, inputRef }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const drafts = useRef({});

  useEffect(() => {
    setText(drafts.current[item.key] || '');
    setError(null);
  }, [item.key]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text, inputRef]);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    const r = await onSend(t);
    setSending(false);
    if (r && r.ok) { setText(''); drafts.current[item.key] = ''; }
    else setError((r && r.error) || 'Could not send');
  };

  const target = item.kind === 'thread' ? 'Reply in thread' : `Message ${item.title}`;
  return (
    <div className="composer-wrap">
      <div className={`composer${sending ? ' sending' : ''}`}>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={`${target}…`}
          onChange={(e) => { setText(e.target.value); drafts.current[item.key] = e.target.value; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <button type="button" className="send" disabled={!text.trim() || sending} onClick={submit} aria-label="Send">
          <SendIcon size={15} />
        </button>
      </div>
      <div className="composer-hint">
        {error ? <span className="err">{error}</span> : <><kbd>↵</kbd> send <kbd>⇧↵</kbd> newline <kbd>esc</kbd> back to list</>}
      </div>
    </div>
  );
}

export default function Reader({ item, dir, webConnected, onArchive, onUnread, onToggleMute, onOpenThread, composerRef, onAfterSend }) {
  const [messages, setMessages] = useState(null);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const stick = useRef(true);
  const newSince = useRef(null);
  const key = item && item.key;
  const lastTs = item && item.lastTs;

  const load = useCallback(async () => {
    if (!key) return;
    const r = await window.api.messages(key);
    if (r.ok) { setMessages(r.messages); setError(null); }
    else setError(r.error);
  }, [key]);

  // Reset when switching items; capture the unread boundary before it's cleared.
  useEffect(() => {
    setMessages(null);
    setError(null);
    stick.current = true;
    newSince.current = item && item.unread ? item.openedTs : null;
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (key) load(); }, [lastTs]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !messages) return;
    if (stick.current) {
      const firstNew = el.querySelector('.new-divider');
      if (firstNew && newSince.current && firstNew.offsetTop < el.scrollHeight - el.clientHeight) {
        el.scrollTop = Math.max(0, firstNew.offsetTop - 80);
        newSince.current = null;
      } else el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (!item) return null;

  const ctx = {
    webConnected,
    openExternal: (u) => window.api.openExternal(u),
    openInSlack: (ts) => window.api.openInSlack({ key: item.key, ts }),
  };

  const react = async (m, name, remove) => {
    setMessages((ms) => ms && ms.map((x) => {
      if (x.ts !== m.ts) return x;
      let rs = x.reactions.map((r) => ({ ...r }));
      const r = rs.find((y) => y.name === name);
      if (remove) { if (r) { r.count -= 1; r.me = false; } rs = rs.filter((y) => y.count > 0); }
      else if (r) { if (!r.me) { r.count += 1; r.me = true; } }
      else rs.push({ name, count: 1, me: true });
      return { ...x, reactions: rs };
    }));
    await window.api.react({ channel: item.channel, ts: m.ts, name, remove });
  };

  const send = async (text) => {
    const r = await window.api.send({ key: item.key, text });
    if (r.ok) { stick.current = true; await load(); onAfterSend && onAfterSend(); }
    return r;
  };

  const isChannel = item.convKind === 'channel';
  const boundary = newSince.current;
  let prev = null;
  let newShown = false;

  return (
    <main className="reader">
      <header className="reader-header">
        <div className="drag" />
        <div className="reader-title">
          <div className="reader-kicker">
            {isChannel ? (item.isPrivate ? <LockIcon size={12} /> : <HashIcon size={12} />) : null}
            <span>{isChannel ? item.title.replace(/^#/, '') : item.convKind === 'mpim' ? 'Group message' : 'Direct message'}</span>
            {item.kind === 'thread' && <span className="dot-sep">Thread</span>}
            {item.ext && <span className="ext-tag">External</span>}
          </div>
          <h2>{item.kind === 'thread' && item.rootText != null
            ? (plain(item.rootText, dir).slice(0, 140) || item.title)
            : item.title}</h2>
        </div>
        <div className="reader-actions">
          <button type="button" className="tool" onClick={onToggleMute} title={item.muted ? 'Unmute here (⌘⇧M)' : 'Mute this conversation here (⌘⇧M)'}>
            {item.muted ? <BellIcon /> : <MuteIcon />}
          </button>
          <button type="button" className="tool" onClick={() => ctx.openInSlack()} title="Open thread in Slack (⌘⇧A)"><ExternalIcon /></button>
          <button type="button" className="tool" onClick={onUnread} title="Mark unread (u)"><UnreadIcon /></button>
          <button type="button" className="tool primary" onClick={onArchive} title={item.archived ? 'Move to Inbox (e)' : 'Archive (e)'}>
            <ArchiveIcon /> <span>{item.archived ? 'Unarchive' : 'Archive'}</span> <kbd>E</kbd>
          </button>
        </div>
      </header>

      <div className="reader-scroll" ref={scrollRef} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        <div className="reader-inner">
          {error && <div className="reader-error">Couldn’t load this conversation · {error}</div>}
          {!messages && !error && <LoadingMessages />}
          {messages && messages.map((m, i) => {
            const out = [];
            const isRoot = item.kind === 'thread' && i === 0;
            if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) {
              if (!(isRoot)) out.push(<div key={`d${m.ts}`} className="day"><span>{dayLabel(m.ts)}</span></div>);
            }
            if (boundary && !newShown && parseFloat(m.ts) > parseFloat(boundary) && m.user !== dir.me) {
              newShown = true;
              out.push(<div key={`n${m.ts}`} className="new-divider"><span>New</span></div>);
            }
            const compact = !isRoot && prev && prev.user === m.user && !m.botName === !prev.botName
              && parseFloat(m.ts) - parseFloat(prev.ts) < 300 && dayKey(prev.ts) === dayKey(m.ts) && !(i === 1 && item.kind === 'thread');
            out.push(
              <Message key={m.ts} m={m} dir={dir} ctx={ctx} compact={compact} isRoot={isRoot}
                isNew={newShown && parseFloat(m.ts) > parseFloat(boundary || 0)}
                onReact={react}
                onOpenThread={item.kind === 'dm' ? (mm) => onOpenThread(item.channel, mm.ts) : null} />
            );
            if (isRoot && messages.length > 1) {
              out.push(<div key="replies" className="replies-rule"><span>{messages.length - 1} {messages.length === 2 ? 'reply' : 'replies'}</span></div>);
            }
            prev = m;
            return out;
          })}
        </div>
      </div>

      <Composer item={item} dir={dir} onSend={send} inputRef={composerRef} />
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
