import { useEffect, useMemo, useRef, useState } from 'react';
import { isArchived, type Chat } from '@/lib/chats';
import {
  bulkTargets,
  chatOpenUrl,
  groupChatsByHost,
  HANDOFF_KEY,
  openChatOf,
  searchChats,
  staleTranscripts,
  timeLabel,
  toggleSelectAll,
  transcriptSearchKey,
  transcriptsToSearch,
  type ChatHandoff,
} from '@/lib/dashboard';
import { rpc } from '@/lib/rpc';
import { openChatPlan, PANEL_PATH, resolveScope, sidePanelAvailable } from '@/lib/sidepanel';
import type { Artifact } from '@/lib/artifact';
import type { ChatItem, Settings, SidePanelScope } from '@/lib/types';
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
  const [preview, setPreview] = useState<{ id: string; items: ChatItem[]; artifact: Artifact | null } | null>(null);
  /**
   * The updatedAt each cached transcript was read at, and by its keys the set of chats already
   * fetched (or attempted). A ref rather than state: the sweep writes it as it goes and nothing
   * renders from it, so a write here must not itself schedule a render — that is what made the
   * effect restart on its own output.
   */
  const stampsRef = useRef<Map<string, number>>(new Map());
  /**
   * This dashboard tab's own id, and the panel scope, both read ahead of any click.
   *
   * Both are needed INSIDE the Open handler, where nothing may be awaited before sidePanel.open.
   * Keeping them in state means the click reads two synchronous values instead of two promises.
   * The scope is kept current so flipping the setting in another tab takes effect here without a
   * reload, exactly as it does in the background worker.
   */
  const [myTabId, setMyTabId] = useState<number | undefined>(undefined);
  const [scope, setScope] = useState<SidePanelScope>('tab');

  // Debounce the search box: every keystroke otherwise re-filters and, worse, queues transcript
  // reads for chats whose metadata did not match.
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [rawQuery]);

  // Learn this tab's id and the scope up front, so the Open click can use both without awaiting.
  useEffect(() => {
    chrome.tabs
      .getCurrent()
      .then((t) => setMyTabId(t?.id))
      // No tabs permission or not in a tab: openChatPlan falls back to a new tab, which still works.
      .catch(() => setMyTabId(undefined));
    const read = () =>
      chrome.storage.local
        .get('settings')
        .then((r) => setScope(resolveScope(r.settings as Partial<Settings> | undefined)))
        .catch(() => {});
    void read();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.settings) void read();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Load the transcripts a search needs, capped and newest-first (transcriptsToSearch decides
  // which). Results render from metadata immediately and gain the message-text matches as these
  // land, so typing is never blocked on storage.
  //
  // Two things here are load-bearing, and both were wrong before.
  //
  // The dependency is a stable key, not `chats`. The array's identity changes on every storage
  // write — the dashboard refreshes on any chats or mods write, and a chat running in the side
  // panel writes several times a second — so an effect keyed on it restarted that often, and each
  // restart aborted the sweep partway. The key changes only when a chat appeared, disappeared or
  // was updated, which is the only news this effect has any use for.
  //
  // And an id is recorded BEFORE the cancellation check, not after. Recording it after meant the
  // one read that was in flight when a restart hit was never marked as fetched, so the next run
  // queued it again, and under sustained writes it was refetched forever: the transcripts that
  // needed the sweep most (the chat currently running) were the ones it could never finish.
  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    const ids = transcriptsToSearch(chats, query, new Set(stampsRef.current.keys()));
    if (!ids.length) return;
    // The updatedAt each read is answering, captured before the await: if the chat is written
    // again while its transcript is in flight, the stamp stays behind and the next sweep — which
    // the write itself triggers, because it moves the key — refetches it rather than caching text
    // that is already out of date.
    const at = new Map(chats.map((c) => [c.id, c.updatedAt]));
    void (async () => {
      for (const id of ids) {
        if (cancelled) return;
        stampsRef.current.set(id, at.get(id) ?? 0);
        try {
          const items = await rpc({ type: 'chats.transcript', id });
          if (cancelled) return;
          setTranscripts((prev) => new Map(prev).set(id, transcriptText(items)));
        } catch {
          // A transcript that will not load is simply not searchable; its metadata still matches.
          // The stamp stays, so the sweep does not retry it on a loop.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, transcriptSearchKey(chats)]);

  // Drop the cached transcripts of chats that have been written since they were read (and of chats
  // that are gone). Without this the cache is permanent: a chat that gains messages while the
  // dashboard is open goes on being searched by the text it had when it was first read. Dropping
  // the stamp is what re-queues it — transcriptsToSearch skips whatever stampsRef already holds.
  useEffect(() => {
    const stale = staleTranscripts(chats, stampsRef.current);
    if (!stale.length) return;
    for (const id of stale) stampsRef.current.delete(id);
    setTranscripts((prev) => {
      const next = new Map(prev);
      for (const id of stale) next.delete(id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptSearchKey(chats)]);

  const matching = useMemo(() => searchChats(chats, query, transcripts), [chats, query, transcripts]);
  const groups = useMemo(() => groupChatsByHost(matching), [matching]);
  const selection = bulkTargets(selected, matching);

  /**
   * The chat the preview pane is showing, derived from the data rather than remembered alongside
   * it. This is the ONE mechanism that closes a preview whose chat is gone: openId is a wish, and
   * a wish for a chat that no longer exists simply does not resolve, so the pane falls back to its
   * empty state on the same render the chat disappeared on.
   *
   * There used to be two more, both weaker and both now gone: an effect watching `chats` that
   * cleared openId one render late, and a guard in bulk() that checked the *filtered* selection, so
   * deleting the open chat while it was scrolled out of the search results missed it entirely.
   * Deriving cannot miss a case, because there is no case to remember.
   */
  const openChatRecord = openChatOf(chats, openId);

  // The preview pane: read the stored transcript for whichever chat is actually open. Keyed on the
  // derived record's id, so a deleted chat stops the read as well as hiding the pane.
  const openRecordId = openChatRecord?.id ?? null;
  useEffect(() => {
    if (!openRecordId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    // The transcript and the draft together: the pane shows what the chat produced above what it
    // said, and one render rather than two means the draft never arrives after the reader has
    // already scrolled.
    void Promise.all([
      rpc({ type: 'chats.transcript', id: openRecordId }),
      rpc({ type: 'artifact.get', chatId: openRecordId }).catch(() => null),
    ])
      .then(([items, artifact]) => {
        if (!cancelled) setPreview({ id: openRecordId, items, artifact });
      })
      .catch(() => {
        if (!cancelled) setPreview({ id: openRecordId, items: [], artifact: null });
      });
    return () => {
      cancelled = true;
    };
  }, [openRecordId]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  /** What Open promises, which differs by scope: this tab, or a new one. */
  const openTitle =
    scope === 'tab'
      ? "Go to this chat's page in this tab, with the side panel on it showing this chat"
      : "Open this chat's page in a new tab with the side panel on it";

  /**
   * Reopen a chat on its page with the side panel showing it.
   *
   * Every panel call happens FIRST and synchronously, before any await: sidePanel.open "may only be
   * called in response to a user action" and the gesture is gone by the time a promise resolves.
   * What is opened depends on the scope setting, and openChatPlan holds that decision with the
   * reasoning for it (lib/sidepanel.ts) — in short:
   *
   *  - 'tab' (the default): a TAB-specific panel on THIS dashboard tab, which is then navigated to
   *    the chat's page. A tab keeps its id across navigation and its panel options ride along, so
   *    the panel ends up attached to exactly the tab the site loads in — and to no other tab.
   *  - 'window', or "Open in new tab": the window-level open the old code did, plus a new tab.
   *
   * `tabId` is read from a state the component keeps up to date, not queried here: a query is an
   * await, and an await before open() risks the gesture.
   *
   * The rejection is caught, not awaited: automation and some Chrome states reject it even from a
   * real click, and the rest of the flow (handoff + navigation) must happen either way.
   */
  function openChat(chat: Chat, { newTab = false }: { newTab?: boolean } = {}) {
    const url = chatOpenUrl(chat);
    if (!url) {
      setError(`"${chat.title}" has no page to reopen: its host was not recorded.`);
      return;
    }
    const plan = openChatPlan(scope, myTabId, newTab);
    try {
      // Safari has no side panel, so there is nothing to attach and nothing to open: the page still
      // opens and the handoff below is still written, which is what the popup reads when it comes up
      // on that page. Asking first rather than letting the TypeError land in the catch, because the
      // catch is meant for a gesture that expired, not for a browser that was never going to work.
      if (!sidePanelAvailable()) {
        /* nothing to open */
      } else if (plan.tabPanel) {
        chrome.sidePanel.setOptions({ tabId: plan.tabPanel.tabId, path: PANEL_PATH, enabled: true }).catch(() => {});
        const p = chrome.sidePanel.open({ tabId: plan.tabPanel.tabId });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else if (plan.windowPanel) {
        const p = chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {
      // Not a gesture any more, or the API is unavailable: the page still opens, and the panel shows
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
        if (plan.navigation === 'navigate' && myTabId != null) {
          // Same tab, so the panel opened on it a moment ago stays attached. The dashboard is the
          // options page and one click away again; "Open in new tab" keeps it where it is.
          await chrome.tabs.update(myTabId, { url });
        } else {
          await chrome.tabs.create({ url, active: true });
        }
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
      // Same as bulk(): the pane closes because openChatRecord stops finding the chat, not because
      // a caller remembered to close it.
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
      // No "close the preview if I deleted the open chat" guard here: openChatRecord derives the
      // open chat from the current data, so a deleted one closes the pane by not being found. The
      // guard that used to live here tested the *filtered* selection and missed the open chat
      // whenever the search had scrolled it off screen.
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
                    openTitle={openTitle}
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
                <button className="pill primary" data-testid="chat-open-detail" onClick={() => openChat(openChatRecord)}>
                  Open with sidebar
                </button>
                <button
                  className="pill"
                  data-testid="chat-open-newtab"
                  title="Keep the dashboard open and load the page in a new tab. Open the panel there yourself."
                  onClick={() => openChat(openChatRecord, { newTab: true })}
                >
                  Open in new tab
                </button>
                <span className="muted" style={{ fontSize: 11 }}>
                  {scope === 'tab'
                    ? `goes to ${chatOpenUrl(openChatRecord)} in this tab, with the side panel on it showing this chat`
                    : `opens ${chatOpenUrl(openChatRecord)} and points the side panel at this chat`}
                </span>
              </div>
              {preview?.id === openChatRecord.id ? (
                <TranscriptPreview items={preview.items} artifact={preview.artifact} />
              ) : (
                <div className="prev-note">Reading transcript…</div>
              )}
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
  openTitle,
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
  openTitle: string;
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
          {/* The model this chat talks to, from the index. Absent on a chat that has not run since
              models became a per-chat choice, where nothing is shown rather than a guess. */}
          {chat.model?.model && (
            <>
              <span>·</span>
              <span className="break" data-testid="chat-model" title={chat.model.label ? `${chat.model.model} on ${chat.model.label}` : chat.model.model}>
                {chat.model.model}
              </span>
              {/* The Thinking level beside the model it applies to, and only when it is not the
                  default — a row saying "default" on every chat would be noise, not information. */}
              {chat.thinking && chat.thinking !== 'default' && (
                <span data-testid="chat-thinking" title={`This chat asks the model to think: ${chat.thinking}`}>
                  thinking: {chat.thinking}
                </span>
              )}
            </>
          )}
          {/* A chat that produced a draft mod, and how many versions it took. The count comes from
              the artifact id being present on the index plus the version count the artifact
              carries — the index holds only the flag, so this reads the flag and the preview reads
              the rest. */}
          {chat.artifactId && (
            <span className="badge" data-testid="chat-draft" title="This chat has a draft mod. Open it to see its versions.">
              draft{typeof chat.artifactVersions === 'number' ? ` · ${chat.artifactVersions} version${chat.artifactVersions === 1 ? '' : 's'}` : ''}
            </span>
          )}
          {/* Which installed mod this chat edits. It comes off the index mirror
              (Chat.editingModName), so the list costs no extra read — and it is the badge that
              matters most on this page, because it says a message in that chat rewrites a script
              that is already running. It sits after the draft badge, which says how much history
              there is; this one says what the history is FOR. */}
          {chat.editingModName && (
            <span className="badge" data-testid="chat-editing" title={`This chat edits the installed mod “${chat.editingModName}”. Saving its draft rewrites that mod in place.`}>
              editing · {chat.editingModName}
            </span>
          )}
          {archived && <span className="badge" data-testid="chat-archived">archived</span>}
        </div>
      </div>
      <div className="actions">
        <button className="pill primary" onClick={onOpen} data-testid="chat-open" title={openTitle}>
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
