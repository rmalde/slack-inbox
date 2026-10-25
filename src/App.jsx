import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InboxList from './components/InboxList';
import Reader from './components/Reader';
import { plain } from './lib/mrkdwn';
import { SettingsIcon, CheckIcon } from './components/Icons';

const EMPTY_DIR = { users: {}, channels: {}, me: null, customEmoji: {} };
const tsNum = (s) => parseFloat(s || 0);
const sortKey = (i) => tsNum(i.lastIncomingTs !== '0' ? i.lastIncomingTs : i.lastTs);

function loadPref(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

export default function App() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState(null);
  const [dir, setDir] = useState(EMPTY_DIR);
  const [view, setViewRaw] = useState('inbox');
  const setView = useCallback((v) => { setViewRaw((cur) => { if (cur !== v) setSelectedKey(null); return v; }); }, []);
  const [selectedKey, setSelectedKey] = useState(null);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState(null);
  const [collapsed, setCollapsed] = useState(() => loadPref('collapsed', {}));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(null);
  const composerRef = useRef(null);
  const searchRef = useRef(null);
  const undoRef = useRef(null);
  const toastT = useRef(null);

  const refresh = useCallback(async () => {
    const r = await window.api.list();
    setItems(r.items);
    setStatus(r.status);
  }, []);

  const refreshDir = useCallback(async () => {
    const d = await window.api.directory();
    setDir({ ...EMPTY_DIR, ...d });
  }, []);

  useEffect(() => {
    refresh();
    refreshDir();
    window.api.getSettings().then(setSettings);
    const offs = [
      window.api.on('inbox-changed', refresh),
      window.api.on('directory-changed', refreshDir),
      window.api.on('session-changed', refresh),
      window.api.on('select', (key) => { setViewRaw('inbox'); setSelectedKey(key); }),
    ];
    return () => offs.forEach((f) => f());
  }, [refresh, refreshDir]);

  // ---- derived lists --------------------------------------------------------

  const matches = useCallback((it) => {
    if (!query) return true;
    const q = query.toLowerCase();
    const u = (id) => (id && dir.users[id] && dir.users[id].name) || '';
    return [it.title, plain(it.rootText, dir), plain(it.lastText, dir), u(it.rootUser), u(it.lastUser)]
      .some((s) => s && s.toLowerCase().includes(q));
  }, [query, dir]);

  const sections = useMemo(() => {
    if (view === 'archived') {
      const arch = items.filter((i) => i.archived && matches(i)).sort((a, b) => tsNum(b.lastTs) - tsNum(a.lastTs)).slice(0, 400);
      return [{ id: 'archived', label: 'Archived', items: arch, empty: 'Nothing archived yet' }];
    }
    const live = items.filter((i) => !i.archived && matches(i)).sort((a, b) => sortKey(b) - sortKey(a));
    return [
      { id: 'you', label: 'For you', items: live.filter((i) => i.section === 'you'), empty: 'No DMs, mentions, or replies waiting' },
      { id: 'channels', label: 'Channels', items: live.filter((i) => i.section === 'channels'), empty: 'Channels are quiet' },
    ];
  }, [items, view, matches]);

  const flat = useMemo(() => sections.flatMap((s) => (collapsed[s.id] ? [] : s.items)), [sections, collapsed]);
  const counts = useMemo(() => {
    const inbox = items.filter((i) => !i.archived);
    return { inbox: inbox.length, unread: inbox.filter((i) => i.unread).length, archived: items.length - inbox.length };
  }, [items]);
  const selected = useMemo(() => items.find((i) => i.key === selectedKey) || null, [items, selectedKey]);

  // Mark opened when an item becomes the selection.
  useEffect(() => {
    if (selected && selected.unread) window.api.open(selected.key);
  }, [selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions --------------------------------------------------------------

  const showToast = (text, undo) => {
    clearTimeout(toastT.current);
    undoRef.current = undo || null;
    setToast({ text, id: Date.now(), undo: !!undo });
    toastT.current = setTimeout(() => setToast(null), 4500);
  };

  const neighborAfter = (keys) => {
    const gone = new Set(keys);
    const idx = flat.findIndex((i) => i.key === selectedKey);
    if (idx < 0) return selectedKey && gone.has(selectedKey) ? null : selectedKey;
    for (let j = idx + 1; j < flat.length; j++) if (!gone.has(flat[j].key)) return flat[j].key;
    for (let j = idx - 1; j >= 0; j--) if (!gone.has(flat[j].key)) return flat[j].key;
    return null;
  };

  const archive = (keys, label) => {
    if (!keys.length) return;
    const prevSel = selectedKey;
    const unarchiving = view === 'archived';
    if (keys.includes(selectedKey)) setSelectedKey(neighborAfter(keys));
    // Optimistic: flip locally, then persist.
    setItems((xs) => xs.map((x) => (keys.includes(x.key) ? { ...x, archived: !unarchiving, unread: unarchiving ? x.unread : false } : x)));
    if (unarchiving) {
      window.api.unarchive(keys);
      showToast(label || 'Moved to Inbox');
    } else {
      window.api.archive(keys);
      showToast(label || 'Archived', () => {
        window.api.unarchive(keys);
        setItems((xs) => xs.map((x) => (keys.includes(x.key) ? { ...x, archived: false } : x)));
        setSelectedKey(prevSel);
      });
    }
  };

  const undo = () => {
    const u = undoRef.current;
    if (!u) return;
    undoRef.current = null;
    u();
    setToast({ text: 'Restored', id: Date.now(), undo: false });
    clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(null), 1800);
  };

  const move = (d) => {
    if (!flat.length) return;
    const idx = flat.findIndex((i) => i.key === selectedKey);
    const next = idx < 0 ? (d > 0 ? 0 : flat.length - 1) : Math.min(flat.length - 1, Math.max(0, idx + d));
    setSelectedKey(flat[next].key);
  };

  const markUnread = () => {
    if (!selected) return;
    window.api.markUnread(selected.key);
    showToast('Marked unread');
    move(1);
  };

  const toggleMute = async () => {
    if (!selected) return;
    const on = await window.api.toggleMute(selected.channel);
    showToast(on ? `Muted ${selected.title} in Slack Inbox` : `Unmuted ${selected.title}`);
  };

  const toggleCollapsed = (id) => setCollapsed((c) => { const n = { ...c, [id]: !c[id] }; savePref('collapsed', n); return n; });

  // ---- keyboard ---------------------------------------------------------------

  const handlers = useRef({});
  handlers.current = { move, archive, markUnread, toggleMute, undo, selected, view, setView };

  useEffect(() => {
    const onCmd = (c) => {
      const h = handlers.current;
      if (c === 'archive' && h.selected) h.archive([h.selected.key]);
      else if (c === 'unread') h.markUnread();
      else if (c === 'open-slack' && h.selected) window.api.openInSlack({ key: h.selected.key });
      else if (c === 'mute') h.toggleMute();
      else if (c === 'next') h.move(1);
      else if (c === 'prev') h.move(-1);
      else if (c === 'view-inbox') h.setView('inbox');
      else if (c === 'view-archived') h.setView('archived');
    };
    const off = window.api.on('cmd', onCmd);
    const onKey = (e) => {
      const t = e.target;
      const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const h = handlers.current;
      const k = e.key;
      if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); h.move(1); }
      else if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); h.move(-1); }
      else if (k === 'u') { e.preventDefault(); h.markUnread(); }
      else if (k === 'z') { e.preventDefault(); h.undo(); }
      else if (k === 'o' && h.selected) { e.preventDefault(); window.api.openInSlack({ key: h.selected.key }); }
      else if (k === 'm') { e.preventDefault(); h.toggleMute(); }
      else if ((k === 'r' || k === 'Enter') && composerRef.current) { e.preventDefault(); composerRef.current.focus(); }
      else if (k === '/') { e.preventDefault(); searchRef.current && searchRef.current.focus(); }
      else if (k === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => { off(); window.removeEventListener('keydown', onKey); };
  }, []);

  // Pick something sensible on first load / view switch.
  useEffect(() => {
    if (selectedKey && flat.some((i) => i.key === selectedKey)) return;
    if (!selectedKey && flat.length) setSelectedKey(flat[0].key);
  }, [flat, selectedKey]);

  const setSetting = async (patch) => setSettings(await window.api.setSettings(patch));

  const inboxZero = view === 'inbox' && counts.inbox === 0 && status && status.phase === 'live' && !query;

  return (
    <div className="app">
      <InboxList
        sections={sections}
        dir={dir}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
        view={view}
        setView={setView}
        query={query}
        setQuery={setQuery}
        counts={counts}
        collapsed={collapsed}
        toggleCollapsed={toggleCollapsed}
        onArchiveAll={(keys) => archive(keys, `Archived ${keys.length} ${keys.length === 1 ? 'thread' : 'threads'}`)}
        status={status}
        searchRef={searchRef}
      />
      <div className="list-footer">
        {status && !status.webConnected && (
          <div className="connect-card">
            <div className="connect-text">
              <strong>Hide muted channels</strong>
              <span>Sign in to Slack once so the inbox can read your mute settings and show images.</span>
            </div>
            <button type="button" className="btn primary sm" onClick={async () => { await window.api.signIn(); refresh(); }}>Sign in</button>
          </div>
        )}
        <div className="footer-row">
          <span />
          <span className="footer-meta" title={status && status.webConnected ? 'Mutes synced from Slack' : 'Mutes: Slack Inbox only'}>
            {view === 'inbox'
              ? `${counts.inbox} ${counts.inbox === 1 ? 'conversation' : 'conversations'} · ${counts.unread} unread`
              : `${counts.archived} archived`}
          </span>
          <button type="button" className="icon-btn" onClick={() => setSettingsOpen((o) => !o)} aria-label="Settings"><SettingsIcon size={15} /></button>
        </div>
        {settingsOpen && settings && (
          <div className="popover" role="dialog">
            <Toggle label="Desktop notifications" sub="DMs, mentions, and threads you're in" on={settings.notifications} onChange={(v) => setSetting({ notifications: v })} />
            <Toggle label="Mark read in Slack on archive" sub="Clears Slack's unread badge too" on={settings.markReadInSlack} onChange={(v) => setSetting({ markReadInSlack: v })} />
            <div className="pop-sep" />
            {status && status.webConnected
              ? <button type="button" className="pop-item" onClick={async () => { await window.api.signOut(); refresh(); }}>Disconnect Slack web session</button>
              : <button type="button" className="pop-item" onClick={async () => { await window.api.signIn(); refresh(); }}>Sign in to Slack…</button>}
            <button type="button" className="pop-item" onClick={() => window.api.syncNow()}>Refresh now <kbd>⌘R</kbd></button>
            <div className="pop-keys">
              <span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>⌘⇧E</kbd> archive</span><span><kbd>Z</kbd> undo</span>
              <span><kbd>R</kbd> reply</span><span><kbd>U</kbd> unread</span><span><kbd>⌘⇧A</kbd> open in Slack</span>
              <span><kbd>M</kbd> mute here</span><span><kbd>/</kbd> filter</span>
            </div>
          </div>
        )}
      </div>

      {selected ? (
        <Reader
          item={selected}
          dir={dir}
          webConnected={status && status.webConnected}
          onArchive={() => archive([selected.key])}
          onUnread={markUnread}
          onToggleMute={toggleMute}
          composerRef={composerRef}
        />
      ) : (
        <main className="reader empty">
          <div className="drag" />
          {inboxZero ? (
            <div className="zero">
              <div className="zero-orb"><CheckIcon size={28} /></div>
              <h2>You’re all caught up</h2>
              <p>New DMs, mentions, and thread replies will land here.</p>
            </div>
          ) : (
            <div className="zero dim">
              {status && status.phase !== 'live' ? <p>Catching up on Slack…</p> : <p>Select a thread</p>}
              {status && status.error && <p className="err">{status.error}</p>}
            </div>
          )}
        </main>
      )}

      {toast && (
        <div className="toast" key={toast.id} role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" onClick={undo}>Undo <kbd>Z</kbd></button>}
        </div>
      )}
    </div>
  );
}

function Toggle({ label, sub, on, onChange }) {
  return (
    <button type="button" className="toggle-row" onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="toggle-text"><span>{label}</span><small>{sub}</small></span>
      <span className={`switch${on ? ' on' : ''}`}><span /></span>
    </button>
  );
}
