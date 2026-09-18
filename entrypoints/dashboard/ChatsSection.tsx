import { useEffect, useMemo, useRef, useState } from 'react';
import { isArchived, type Chat } from '@/lib/chats';
import {
  bulkTargets,
  chatOpenUrl,
  groupChatsByHost,
  HANDOFF_KEY,
  searchChats,
  timeLabel,
  toggleSelectAll,
  transcriptsToSearch,
  type ChatHandoff,
} from '@/lib/dashboard';
import { rpc } from '@/lib/rpc';
import type { ChatItem } from '@/lib/types';
import { TranscriptPreview, transcriptText } from './TranscriptPreview';

const SEARCH_DEBOUNCE_MS = 200;

export function ChatsSection({ chats, loaded, onChanged }: { chats: Chat[]; loaded: boolean; onChanged: () => void }) {
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  /** Transcript text by chat id, loaded lazily for search. Never evicted: a profile caps at 200 chats. */
  const [transcripts, setTranscripts] = useState<Map<string, string>>(new Map());
  const [preview, setPreview] = useState<{ id: string; items: ChatItem[] } | null>(null);
  const haveRef = useRef<Set<string>>(new Set());

  // Debounce the search box: every keystroke otherwise re-filters and, worse, queues transcript
  // reads for chats whose metadata did not match.
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [rawQuery]);

  // Load the transcripts a search needs, capped and newest-first (transcriptsToSearch decides
  // which). Results render from metadata immediately and gain the message-text matches as these
  // land, so typing is never blocked on storage.
  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    const ids = transcriptsToSearch(chats, query, haveRef.current);
    if (!ids.length) return;
    void (async () => {
      for (const id of ids) {
        if (cancelled) return;
        try {
          const items = await rpc({ type: 'chats.transcript', id });
          if (cancelled) return;
          haveRef.current.add(id);
          setTranscripts((prev) => new Map(prev).set(id, transcriptText(items)));
        } catch {
          // A transcript that will not load is simply not searchable; its metadata still matches.
          haveRef.current.add(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, chats]);

  const matching = useMemo(() => searchChats(chats, query, transcripts), [chats, query, transcripts]);
  const groups = useMemo(() => groupChatsByHost(matching), [matching]);
  const selection = bulkTargets(selected, matching);

  // A chat that has left the list (deleted elsewhere, or filtered out) must not keep the preview
  // pane open on content the user can no longer see in the list.
  useEffect(() => {
    if (openId && !chats.some((c) => c.id === openId)) {
      setOpenId(null);
      setPreview(null);
    }
  }, [chats, openId]);

  // The preview pane: read the stored transcript when a row is clicked.
  useEffect(() => {
    if (!openId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void rpc({ type: 'chats.transcript', id: openId })
      .then((items) => {
        if (!cancelled) setPreview({ id: openId, items });
      })
      .catch(() => {
        if (!cancelled) setPreview({ id: openId, items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [openId]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  /**
   * Reopen a chat on its page with the side panel showing it.
   *
   * chrome.sidePanel.open FIRST and synchronously, before any await: the call is only allowed
   * inside a user gesture, and the gesture is gone by the time a promise resolves. windowId (this
   * dashboard tab's window) rather than tabId, because the tab the chat is going to live in does
   * not exist yet — and a windowId-level open is what makes the panel global for the window, so it
   * is still open when the new tab becomes active.
   *
   * The rejection is caught, not awaited: automation and some Chrome states reject it even from a
   * real click, and the rest of the flow (handoff + tab) must happen either way.
   */
  function openChat(chat: Chat) {
    const url = chatOpenUrl(chat);
    if (!url) {
      setError(`"${chat.title}" has no page to reopen: its host was not recorded.`);
      return;
    }
    const windowId = chrome.windows.WINDOW_ID_CURRENT;
    try {
      const p = chrome.sidePanel.open({ windowId });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // Not a gesture any more, or the API is unavailable: the tab still opens, and the panel shows
      // this chat as soon as the user opens it by hand, because the handoff is written regardless.
    }
    void (async () => {
      try {
        const handoff: ChatHandoff = { chatId: chat.id, host: chat.host, at: Date.now() };
        await chrome.storage.session.set({ [HANDOFF_KEY]: handoff });
      } catch {
        // No session storage: the page still opens, the panel just restores its usual chat.
      }
      try {
        await chrome.tabs.create({ url, active: true });
      } catch (e) {
        fail(e);
      }
    })();
  }

  async function rename(id: string, title: string) {
    const t = title.trim();
    setRenamingId(null);
    if (!t) return;
    try {
      await rpc({ type: 'chats.rename', id, title: t });
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  async function setArchived(id: string, archived: boolean) {
    try {
      await rpc({ type: 'chats.archive', id, archived });
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  async function remove(chat: Chat) {
    if (!confirm(`Delete "${chat.title}"? This cannot be undone.`)) return;
    try {
      await rpc({ type: 'chats.delete', id: chat.id });
      if (openId === chat.id) setOpenId(null);
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  async function bulk(action: 'archive' | 'unarchive' | 'delete') {
    const ids = selection;
    if (!ids.length) return;
    if (action === 'delete' && !confirm(`Delete ${ids.length} chat${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    try {
      await rpc({ type: 'chats.bulk', ids, action });
      setSelected(new Set());
      if (action === 'delete' && openId && ids.includes(openId)) setOpenId(null);
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const openChatRecord = openId ? chats.find((c) => c.id === openId) : undefined;

  return (
    <>
      <div className="dash-toolbar">
        <input
          type="search"
          placeholder="Search chats by title, site or message text"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          data-testid="chat-search"
        />
        <span className="muted" data-testid="chat-count">
          {matching.length} of {chats.length} chat{chats.length === 1 ? '' : 's'} · {groups.length} site{groups.length === 1 ? '' : 's'}
        </span>
        <span className="row" style={{ flex: 1 }} />
        <button className="pill" onClick={() => setSelected(toggleSelectAll(selected, matching))} disabled={!matching.length}>
          {matching.length > 0 && matching.every((c) => selected.has(c.id)) ? 'Clear selection' : 'Select all'}
        </button>
      </div>

      {selection.length > 0 && (
        <div className="bulkbar" data-testid="chat-bulkbar">
          <span>
            {selection.length} selected
          </span>
          <span className="sep">·</span>
          <button className="pill" onClick={() => void bulk('archive')}>Archive</button>
          <button className="pill" onClick={() => void bulk('unarchive')}>Unarchive</button>
          <button className="pill danger" onClick={() => void bulk('delete')}>Delete</button>
          <span className="row" style={{ flex: 1 }} />
          <button className="pill" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}

      <div className="panes">
        <div>
          {!loaded && <div className="dash-empty">Loading…</div>}
          {loaded && !chats.length && <div className="dash-empty">No chats yet. Open the side panel on any site and describe how you want it to change.</div>}
          {loaded && chats.length > 0 && !matching.length && <div className="dash-empty">Nothing matches “{query}”.</div>}
          {groups.map((g) => (
            <section key={g.host} className="hostgroup" data-testid="hostgroup" data-host={g.host}>
              <div className="hostgroup-head">
                <span className="host">{g.host}</span>
                <span className="count" data-testid="hostgroup-count">
                  {g.chats.length} chat{g.chats.length === 1 ? '' : 's'}
                  {g.archivedCount > 0 && ` · ${g.archivedCount} archived`}
                </span>
              </div>
              <div className="rows">
                {g.chats.map((c) => (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    open={openId === c.id}
                    selected={selected.has(c.id)}
                    renaming={renamingId === c.id}
                    onToggleSelect={() => toggleOne(c.id)}
                    onOpenPreview={() => setOpenId((prev) => (prev === c.id ? null : c.id))}
                    onStartRename={() => setRenamingId(c.id)}
                    onRename={(title) => void rename(c.id, title)}
                    onCancelRename={() => setRenamingId(null)}
                    onOpen={() => openChat(c)}
                    onArchive={() => void setArchived(c.id, !isArchived(c))}
                    onDelete={() => void remove(c)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="pane-detail">
          {openChatRecord ? (
            <div className="detail" data-testid="chat-preview">
              <h3>{openChatRecord.title}</h3>
              <div className="detail-meta">
                {openChatRecord.host} · {timeLabel(openChatRecord.updatedAt).absolute}
                {openChatRecord.url && (
                  <>
                    {' · '}
                    <span className="break">{openChatRecord.url}</span>
                  </>
                )}
              </div>
              <div className="row" style={{ marginBottom: 12 }}>
                <button className="pill primary" onClick={() => openChat(openChatRecord)}>
                  Open with sidebar
                </button>
                <span className="muted" style={{ fontSize: 11 }}>
                  opens {chatOpenUrl(openChatRecord)} and points the side panel at this chat
                </span>
              </div>
              {preview?.id === openChatRecord.id ? <TranscriptPreview items={preview.items} /> : <div className="prev-note">Reading transcript…</div>}
            </div>
          ) : (
            <div className="dash-empty">Select a chat to read it here.</div>
          )}
        </div>
      </div>
    </>
  );
}

function ChatRow({
  chat,
  open,
  selected,
  renaming,
  onToggleSelect,
  onOpenPreview,
  onStartRename,
  onRename,
  onCancelRename,
  onOpen,
  onArchive,
  onDelete,
}: {
  chat: Chat;
  open: boolean;
  selected: boolean;
  renaming: boolean;
  onToggleSelect: () => void;
  onOpenPreview: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const archived = isArchived(chat);
  const t = timeLabel(chat.updatedAt);
  return (
    <div
      className={`rowcard${open ? ' selected' : ''}${archived ? ' dimmed' : ''}`}
      data-testid="chat-row"
      data-chat-id={chat.id}
      onClick={(e) => {
        // Only the row's own background opens the preview; a click on a control inside it is that
        // control's, not the row's.
        if ((e.target as HTMLElement).closest('button, input, a')) return;
        onOpenPreview();
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${chat.title}`}
        data-testid="chat-select"
      />
      <div className="body">
        {renaming ? (
          <input
            className="rename-input"
            defaultValue={chat.title}
            autoFocus
            data-testid="chat-rename-input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRename((e.target as HTMLInputElement).value);
              else if (e.key === 'Escape') onCancelRename();
            }}
            onBlur={(e) => onRename(e.target.value)}
          />
        ) : (
          <div className="title" data-testid="chat-title" title={chat.title}>
            {chat.title}
          </div>
        )}
        <div className="meta">
          <span className="break">{chat.host}</span>
          <span>·</span>
          <span title={t.absolute}>{t.relative}</span>
          <span>·</span>
          <span>{t.absolute}</span>
          {typeof chat.turns === 'number' && (
            <>
              <span>·</span>
              <span data-testid="chat-turns">
                {chat.turns} turn{chat.turns === 1 ? '' : 's'}
              </span>
            </>
          )}
          {archived && <span className="badge" data-testid="chat-archived">archived</span>}
        </div>
      </div>
      <div className="actions">
        <button className="pill primary" onClick={onOpen} data-testid="chat-open" title="Open this chat's page in a new tab with the side panel on it">
          Open
        </button>
        <button className="pill" onClick={onStartRename} data-testid="chat-rename">
          Rename
        </button>
        <button className="pill" onClick={onArchive} data-testid="chat-archive">
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        <button className="pill danger" onClick={onDelete} data-testid="chat-delete">
          Delete
        </button>
      </div>
    </div>
  );
}
