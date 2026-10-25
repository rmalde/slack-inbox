import React, { useEffect, useRef } from 'react';
import Avatar from './Avatar';
import { plain } from '../lib/mrkdwn';
import { listTime } from '../lib/format';
import { ArchiveIcon, HashIcon, LockIcon, MuteIcon, SearchIcon, ChevronIcon } from './Icons';

function who(dir, id, botName, me) {
  if (id && id === me) return 'You';
  const u = id && dir.users[id];
  return (u && u.name) || botName || 'Someone';
}

function Row({ it, dir, selected, onSelect }) {
  const ref = useRef(null);
  useEffect(() => {
    if (selected && ref.current) ref.current.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const isChannel = it.convKind === 'channel';
  const threadInDm = !isChannel && it.kind === 'thread';
  const subject = it.kind === 'thread' && it.rootText != null ? plain(it.rootText, dir) : null;
  const latest = plain(it.lastText, dir);
  const showLatest = it.kind === 'dm' || (it.lastTs !== it.threadTs);
  const latestWho = who(dir, it.lastUser, it.lastBotName, dir.me);

  return (
    <button
      ref={ref}
      type="button"
      className={`row${selected ? ' selected' : ''}${it.unread ? ' unread' : ''}`}
      onClick={() => onSelect(it.key)}
      data-key={it.key}
    >
      <span className="row-dot" aria-hidden="true" />
      <div className="row-avatar">
        <Avatar user={it.avatarUser} botName={it.rootBotName || it.lastBotName} dir={dir} size={34} />
        {isChannel && (
          <span className="row-badge">{it.isPrivate ? <LockIcon size={9} /> : <HashIcon size={9} />}</span>
        )}
      </div>
      <div className="row-body">
        <div className="row-top">
          <span className="row-title">
            {isChannel ? (
              <>
                <span className="row-who">{who(dir, it.rootUser || it.lastUser, it.rootBotName || it.lastBotName, dir.me)}</span>
                <span className="row-in">in</span>
                <span className="row-chan">{it.title.replace(/^#/, '')}</span>
              </>
            ) : (
              <span className="row-who">{it.title}{threadInDm && <span className="row-in"> · thread</span>}</span>
            )}
            {it.muted && <MuteIcon size={11} className="row-muted" />}
          </span>
          <span className="row-time">{listTime(it.lastIncomingTs !== '0' ? it.lastIncomingTs : it.lastTs)}</span>
        </div>
        {subject != null && <div className="row-subject">{subject || 'Attachment'}</div>}
        {subject == null && it.kind === 'thread' && <div className="row-subject skeleton-line" />}
        {showLatest && (
          <div className="row-preview">
            {(it.kind === 'thread' || it.convKind === 'mpim' || it.lastFromMe) && <span className="row-preview-who">{latestWho}: </span>}
            {latest || 'Attachment'}
          </div>
        )}
        {(it.mention || it.newCount > 1) && it.unread && (
          <div className="row-chips">
            {it.mention && <span className="chip at">@ mention</span>}
            {it.newCount > 1 && <span className="chip">{it.newCount} new</span>}
          </div>
        )}
      </div>
    </button>
  );
}

export default function InboxList({ sections, dir, selectedKey, onSelect, view, setView, query, setQuery, counts, onArchiveAll, collapsed, toggleCollapsed, status, searchRef }) {
  return (
    <aside className="list-pane">
      <header className="list-header">
        <div className="drag" />
        <div className="list-title-row">
          <h1>{view === 'inbox' ? 'Inbox' : 'Archived'}</h1>
          <SyncDot status={status} />
        </div>
        <div className="seg" role="tablist">
          <button type="button" role="tab" className={view === 'inbox' ? 'on' : ''} onClick={() => setView('inbox')}>
            Inbox{counts.unread ? <span className="seg-n">{counts.unread}</span> : null}
          </button>
          <button type="button" role="tab" className={view === 'archived' ? 'on' : ''} onClick={() => setView('archived')}>Archived</button>
          <span className="seg-thumb" style={{ transform: view === 'inbox' ? 'translateX(0)' : 'translateX(100%)' }} />
        </div>
        <label className="search">
          <SearchIcon size={14} />
          <input ref={searchRef} placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
          {!query && <kbd>/</kbd>}
        </label>
      </header>
      <div className="list-scroll">
        {sections.map((s) => (
          <section key={s.id} className="list-section">
            {sections.length > 1 && (
              <div className="section-head">
                <button type="button" className={`section-toggle${collapsed[s.id] ? ' closed' : ''}`} onClick={() => toggleCollapsed(s.id)}>
                  <ChevronIcon size={12} />
                  <span>{s.label}</span>
                  <span className="section-n">{s.items.length}</span>
                </button>
                {view === 'inbox' && s.items.length > 0 && (
                  <button type="button" className="section-action" onClick={() => onArchiveAll(s.items.map((i) => i.key))} title={`Archive all in ${s.label}`}>
                    <ArchiveIcon size={13} /> Archive all
                  </button>
                )}
              </div>
            )}
            {!collapsed[s.id] && s.items.map((it) => (
              <Row key={it.key} it={it} dir={dir} selected={it.key === selectedKey} onSelect={onSelect} />
            ))}
            {!collapsed[s.id] && !s.items.length && sections.length > 1 && <div className="section-empty">{s.empty}</div>}
          </section>
        ))}
      </div>
    </aside>
  );
}

function SyncDot({ status }) {
  if (!status) return null;
  let cls = 'live';
  let label = 'Live';
  if (status.error) { cls = 'err'; label = status.error; }
  else if (status.phase === 'seeding' || status.phase === 'directory') {
    cls = 'busy';
    label = status.seedProgress ? `Catching up · ${status.seedProgress.page}/${status.seedProgress.pages || '…'}` : 'Catching up';
  }
  return (
    <span className={`sync ${cls}`} title={label}>
      <span className="sync-dot" />
      {cls !== 'live' && <span className="sync-label">{label}</span>}
    </span>
  );
}
