import { useEffect, useRef, useState } from 'react';
import { archivedChats, isArchived, liveChats, loadItems, pickChatToShow, relativeTime, saveItems, titleFromText, type Chat as ChatRecord } from '@/lib/chats';
import { findByName } from '@/lib/modmatch';
import { modFromProposal } from '@/lib/mods';
import { rpc, type AgentPortRequest } from '@/lib/rpc';
import type { AgentEvent, ChatItem, ContentEvent, ElementRef, Mod, ModProposal } from '@/lib/types';

const SAVE_DEBOUNCE_MS = 400;

export function Chat({ tabId, pageUrl, host }: { tabId: number | null; pageUrl: string; host: string }) {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  /** False while the panel is still working out which chat to show, so nothing flashes. */
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refs, setRefs] = useState<ElementRef[]>([]);
  const [picking, setPicking] = useState(false);
  /** The draft title while the switcher is in rename mode, or null when it is a select again. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** The chat the open port is running, so a switch does not misfile incoming events. */
  const portChatRef = useRef<string | null>(null);
  /** Set when the restored transcript looks like it was cut off mid-run, so the next port event says so. */
  const reconnectRef = useRef(false);
  /**
   * Bumped by every host change and every deliberate chat switch. Async work captures the value it
   * started under and drops its result if the number has moved on, so a slow lookup for one host
   * can never land on top of a later one's.
   */
  const genRef = useRef(0);
  /** Whether the title-refetch after the first accepted turn has already been done for this run. */
  const titleFixRef = useRef(false);
  /** The current host, readable from the port listener, which is registered once and outlives renders. */
  const hostRef = useRef(host);
  hostRef.current = host;

  // Pick up this site's chats and show the most recently updated live one, transcript and all. A
  // chat is only created on first send, so opening the panel on a new site does not litter storage
  // with empty chats. The list and the transcript are fetched together and committed in one go:
  // that way the panel never renders a chat id with someone else's items, and never shows the
  // empty state for a host that turns out to have a chat.
  useEffect(() => {
    const gen = ++genRef.current;
    const live = () => genRef.current === gen;
    setLoaded(false);
    setItems([]);
    setChatId(null);
    setChats([]);
    setRenaming(null);
    if (!host) {
      setLoaded(true);
      return;
    }
    void (async () => {
      try {
        const list = await rpc({ type: 'chats.list', host });
        if (!live()) return;
        const show = pickChatToShow(list);
        // Nothing to restore: land on an empty composer.
        if (!show) {
          setChats(list);
          setLoaded(true);
          return;
        }
        const stored = await loadItems(show.id);
        if (!live()) return;
        setChats(list);
        setChatId(show.id);
        setItems(stored);
        reconnectRef.current = looksUnfinished(stored);
        setLoaded(true);
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
      } catch {
        if (live()) setLoaded(true);
      }
    })();
  }, [host]);

  // Persist the transcript, debounced so a streaming turn does not write on every delta.
  useEffect(() => {
    if (!chatId || !loaded) return;
    const id = chatId;
    const t = setTimeout(() => void saveItems(id, items).catch(() => {}), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [items, chatId, loaded]);

  useEffect(() => {
    const onMsg = (msg: ContentEvent) => {
      if (msg?.type === 'picked') {
        setPicking(false);
        setRefs((prev) => {
          const token = uniqueToken(tokenFor(msg.element.selector), prev.map((r) => r.token));
          insertAtCursor(`@${token} `);
          return [...prev, { ...msg.element, token }];
        });
      } else if (msg?.type === 'pick-cancelled') setPicking(false);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  function connect(): chrome.runtime.Port {
    if (portRef.current) return portRef.current;
    const port = chrome.runtime.connect({ name: 'agent' });
    // A run that outlived the panel keeps streaming into a port we no longer hold. On the first
    // event after a reconnect we cannot recover the text we missed, so we just say so once.
    let first = true;
    port.onMessage.addListener((e: AgentEvent) => {
      setItems((prev) => {
        const next = [...prev];
        if (first) {
          first = false;
          if (reconnectRef.current) {
            reconnectRef.current = false;
            next.push({ kind: 'note', text: 'reconnected — earlier output from this run was not captured' });
          }
        }
        const last = next[next.length - 1];
        switch (e.type) {
          case 'text':
            if (last?.kind === 'assistant') next[next.length - 1] = { ...last, text: last.text + e.delta };
            else next.push({ kind: 'assistant', text: e.delta });
            return next;
          case 'tool_call':
            next.push({ kind: 'tool', id: e.id, name: e.name, input: e.input });
            return next;
          case 'tool_result': {
            const i = next.findIndex((x) => x.kind === 'tool' && x.id === e.id);
            if (i >= 0) next[i] = { ...(next[i] as Extract<ChatItem, { kind: 'tool' }>), summary: e.summary, isError: e.isError };
            return next;
          }
          case 'proposal':
            next.push({ kind: 'proposal', proposal: e.proposal });
            return next;
          case 'accepted':
            // The background has now run touchChat, so the stored title and updatedAt are real.
            // Reading them back once per run keeps the switcher honest even if the optimistic
            // title above guessed differently (e.g. a chat that already had a title).
            if (!titleFixRef.current) {
              titleFixRef.current = true;
              void refreshChats();
            }
            return next.map((it) => (it.kind === 'user' && it.id === e.id ? { ...it, queued: false } : it));
          case 'unqueued': {
            const dropped = next.find((it) => it.kind === 'user' && it.id === e.id) as Extract<ChatItem, { kind: 'user' }> | undefined;
            if (dropped) {
              setText((t) => (t.trim() ? `${t.trim()}\n${dropped.text}` : dropped.text));
              if (dropped.refs) setRefs((r) => [...r, ...dropped.refs!]);
            }
            return next.filter((it) => !(it.kind === 'user' && it.id === e.id));
          }
          case 'chat_title':
            // Handled outside the transcript: it renames a row in the switcher, not a message.
            return next;
          case 'error':
            next.push({ kind: 'error', text: e.message });
            return next;
          case 'done':
            return next;
        }
      });
      // The background named the chat after the turn finished. Patch the switcher in place rather
      // than refetching, so the new name appears the moment it is written.
      if (e.type === 'chat_title') setChats((prev) => prev.map((c) => (c.id === e.chatId ? { ...c, title: e.title, titleSource: 'auto-model' } : c)));
      if (e.type === 'done') setBusy(false);
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      portChatRef.current = null;
      setBusy(false);
    });
    portRef.current = port;
    return port;
  }

  /** Insert text at the caret in the composer and keep focus there. */
  function insertAtCursor(snippet: string) {
    const ta = textareaRef.current;
    setText((prev) => {
      if (!ta) return prev + snippet;
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? start;
      const before = prev.slice(0, start);
      const pad = before && !/\s$/.test(before) ? ' ' : '';
      const next = before + pad + snippet + prev.slice(end);
      const caret = (before + pad + snippet).length;
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
      return next;
    });
  }

  function removeRef(token: string) {
    setRefs((prev) => prev.filter((r) => r.token !== token));
    setText((prev) => prev.replace(new RegExp(`@${escapeRe(token)}(?![\\w.#-])\\s?`, 'g'), ''));
  }

  /** Send now, or queue if a turn is running. Queued messages reach the model between its tool calls. */
  async function send() {
    const t = text.trim();
    if (!t || tabId == null) return;
    // The chat is created lazily, on the first message that actually goes out.
    let id = chatId;
    if (!id) {
      // Creating it is a round trip, and the user can switch tabs during it. If the panel has moved
      // to another host (or another chat) by the time it lands, filing the message under the new
      // view would be wrong, so the text goes back in the composer for the user to resend.
      const gen = genRef.current;
      try {
        const chat = await rpc({ type: 'chats.create', host });
        if (genRef.current !== gen) {
          setText((cur) => (cur.trim() ? cur : t));
          return;
        }
        id = chat.id;
        setChats((prev) => [chat, ...prev]);
        setChatId(chat.id);
        setLoaded(true);
      } catch (e) {
        setItems((prev) => [...prev, { kind: 'error', text: `Could not start a chat: ${e instanceof Error ? e.message : String(e)}` }]);
        return;
      }
    }
    // Only send references whose token still appears in the message.
    const used = refs.filter((r) => new RegExp(`@${escapeRe(r.token)}(?![\\w.#-])`).test(t));
    const msgId = crypto.randomUUID();
    setItems((prev) => [...prev, { kind: 'user', id: msgId, text: t, refs: used.length ? used : undefined, queued: busy }]);
    setText('');
    setRefs([]);
    setBusy(true);
    const req: AgentPortRequest = { type: 'send', tabId, chatId: id, id: msgId, text: t, refs: used.length ? used : undefined };
    portChatRef.current = id;
    titleFixRef.current = false;
    connect().postMessage(req);
    // Reflect the new activity in the switcher right away. The background derives the title from
    // this same first message (touchChat), but it writes it only once the run has started — after
    // a refetch here would have read the index — so the title is set optimistically by the same
    // rule the background uses, and confirmed by the refetch on the first 'accepted' event below.
    // Without this the switcher said "New chat" until the panel was reloaded.
    setChats((prev) =>
      prev.map((c) => (c.id !== id ? c : { ...c, updatedAt: Date.now(), archivedAt: undefined, title: c.title && c.title !== 'New chat' ? c.title : titleFromText(t) })),
    );
    void refreshChats();
  }

  /** Re-read this host's chat index into the switcher, guarded against a host switch mid-flight. */
  async function refreshChats() {
    const h = hostRef.current;
    if (!h) return;
    const gen = genRef.current;
    try {
      const list = await rpc({ type: 'chats.list', host: h });
      if (genRef.current === gen) setChats(list);
    } catch {
      /* the switcher keeps what it had */
    }
  }

  function abort() {
    portRef.current?.postMessage({ type: 'abort' } satisfies AgentPortRequest);
  }

  /** Stop any run and forget the port's chat, before the view lands somewhere else. */
  function detach() {
    if (busy) abort();
    portChatRef.current = null;
    reconnectRef.current = false;
    titleFixRef.current = false;
    // A half-typed name belongs to the chat being left, so it is dropped rather than carried over.
    setRenaming(null);
  }

  /**
   * Show a stored chat: load its transcript, then commit id and items together. Generation-guarded
   * like the host effect, so a slow load cannot overwrite a chat the user has since moved on from.
   */
  function openChat(id: string) {
    const gen = ++genRef.current;
    detach();
    setLoaded(false);
    setItems([]);
    setChatId(id);
    void loadItems(id)
      .then((stored) => {
        if (genRef.current !== gen) return;
        setItems(stored);
        reconnectRef.current = looksUnfinished(stored);
        setLoaded(true);
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
      })
      .catch(() => {
        if (genRef.current === gen) setLoaded(true);
      });
  }

  /**
   * Switching away from a chat that is mid-run would misfile the run's remaining events into the
   * chat we land on, so the run is stopped first. The model history is already saved either way.
   */
  function switchTo(id: string | null) {
    if (id === chatId) return;
    if (id === null) newChat();
    else openChat(id);
  }

  /**
   * Clear the view and wait. The chat record itself is created by the first send, so hitting
   * "New chat" and changing your mind leaves nothing behind — reopening the panel comes back to
   * the last real chat, which is what the owner asked for.
   */
  function newChat() {
    if (!host) return;
    ++genRef.current;
    detach();
    setChatId(null);
    setItems([]);
    setLoaded(true);
  }

  /** Where to land after the current chat leaves the live list: its most recent live sibling. */
  function fallBackTo(rest: ChatRecord[]) {
    const next = pickChatToShow(rest);
    if (next) openChat(next.id);
    else newChat();
  }

  async function removeChat() {
    if (!chatId) return;
    const current = chats.find((c) => c.id === chatId);
    if (!confirm(`Delete "${current?.title ?? 'this chat'}"?`)) return;
    detach();
    await rpc({ type: 'chats.delete', id: chatId });
    const rest = chats.filter((c) => c.id !== chatId);
    setChats(rest);
    fallBackTo(rest);
  }

  /**
   * Archive is the switcher's primary "I'm done with this" action. It is reversible — the chat
   * moves to the Archived group, still readable and writable — so it asks for no confirmation.
   */
  async function setArchived(id: string, archived: boolean) {
    const at = Date.now();
    // Optimistic, so the switcher regroups immediately rather than after a refetch.
    const next = chats.map((c) => (c.id === id ? { ...c, archivedAt: archived ? at : undefined } : c));
    setChats(next);
    try {
      await rpc({ type: 'chats.archive', id, archived });
    } catch {
      setChats(chats); // put it back where it was
      return;
    }
    if (archived && id === chatId) {
      detach();
      fallBackTo(next);
    }
  }

  /** Turn the switcher into a text input holding the current title, selected for replacement. */
  function startRename() {
    if (!chatId) return;
    setRenaming(chats.find((c) => c.id === chatId)?.title ?? '');
    requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
  }

  /**
   * Commit the typed title. It becomes titleSource 'user' in storage, which is what stops the model
   * from renaming this chat at its 4th turn, so the optimistic update below records that too.
   */
  async function commitRename() {
    const id = chatId;
    const title = (renaming ?? '').trim();
    setRenaming(null);
    if (!id || !title) return;
    const before = chats;
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title, titleSource: 'user' } : c)));
    try {
      await rpc({ type: 'chats.rename', id, title });
    } catch {
      setChats(before); // the rename did not land; show what is actually stored
    }
  }

  async function pick() {
    if (tabId == null) return;
    setPicking(true);
    try {
      await rpc({ type: 'page.pick', tabId });
    } catch (e) {
      setPicking(false);
      setItems((prev) => [...prev, { kind: 'error', text: `Could not start the picker: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }

  async function tryProposal(p: ModProposal) {
    if (tabId == null) return;
    const r = await rpc({ type: 'mods.try', tabId, code: p.code });
    setItems((prev) => [...prev, { kind: 'tool', id: crypto.randomUUID(), name: 'try', input: { description: 'Ran the proposed mod once' }, summary: r.ok ? `OK${r.logs.length ? ': ' + r.logs.join(' | ') : ''}` : r.error, isError: !r.ok }]);
  }

  /**
   * Save a proposal, updating the mod it revises rather than minting a new id. Asking the model to
   * change a mod produces a fresh proposal under the same name; without this, each save left another
   * copy behind and every copy ran on the page.
   */
  async function saveProposal(p: ModProposal, idx: number) {
    const existing = await findModByName(p.name);
    await rpc({ type: 'mods.save', mod: modFromProposal(p, existing) });
    setItems((prev) => prev.map((it, i) => (i === idx && it.kind === 'proposal' ? { ...it, saved: true } : it)));
  }

  const unsupported = !pageUrl || /^(chrome|edge|about|chrome-extension|devtools):/.test(pageUrl);
  const live = liveChats(chats);
  const archived = archivedChats(chats);
  const current = chatId ? chats.find((c) => c.id === chatId) : undefined;
  const viewingArchived = !!current && isArchived(current);

  return (
    <div className="chat">
      {!unsupported && host && chats.length > 0 && (
        <div className="chatbar">
          {renaming !== null ? (
            <input
              ref={renameRef}
              className="rename"
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setRenaming(null);
                }
              }}
              onBlur={() => setRenaming(null)}
              placeholder="Name this chat"
              aria-label="Chat name"
            />
          ) : (
            <select value={chatId ?? ''} onChange={(e) => switchTo(e.target.value || null)} title={`Chats on ${host}`}>
              <option value="">New chat…</option>
              {live.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} · {relativeTime(c.updatedAt)}
                </option>
              ))}
              {archived.length > 0 && (
                <optgroup label="Archived">
                  {archived.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} · {relativeTime(c.updatedAt)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          {renaming !== null ? (
            // Mousedown, not click: the input's blur would close rename mode before a click landed.
            <button className="btn primary" onMouseDown={(e) => e.preventDefault()} onClick={() => void commitRename()} title="Save this name">Save</button>
          ) : (
            <button className="btn" onClick={startRename} disabled={!chatId} title="Give this chat your own name. It will not be renamed automatically afterwards.">Rename</button>
          )}
          {renaming !== null ? null : viewingArchived ? (
            <>
              <button className="btn" onClick={() => void setArchived(chatId!, false)} title="Move this chat back to the main list">Unarchive</button>
              <button className="btn danger" onClick={() => void removeChat()} title="Delete this chat for good">Delete</button>
            </>
          ) : (
            // Archive is reversible, so it stays a secondary button; coral is kept for Delete.
            <button className="btn" onClick={() => void setArchived(chatId!, true)} disabled={!chatId} title="Archive this chat: it moves to the Archived group and stops opening by default">
              Archive
            </button>
          )}
        </div>
      )}
      <div className="messages">
        {/* Until the lookup resolves we do not know whether this host has a chat to restore, so
            neither the empty state nor a transcript is shown — the panel must not flash "describe
            how you want this page to change" over a conversation that is about to appear. */}
        {!loaded && !unsupported && <div className="empty muted">loading…</div>}
        {loaded && items.length === 0 && (
          <div className="empty">
            {unsupported ? (
              <>open a regular web page to start</>
            ) : (
              <>
                describe how this page should change
                <br />
                <span className="muted">hide the sidebar · make the font bigger · add a button that copies the title</span>
              </>
            )}
          </div>
        )}
        {items.map((it, i) => {
          switch (it.kind) {
            case 'user':
              return (
                <div key={i} className={`msg user${it.queued ? ' queued' : ''}`}>
                  {it.queued && <div className="label" style={{ marginBottom: 6 }}>queued · sends between steps</div>}
                  {it.text}
                  {it.refs && (
                    <div className="row" style={{ marginTop: 8 }}>
                      {it.refs.map((r) => <span key={r.token} className="chip ref" title={r.selector}>@{r.token} · {r.label}</span>)}
                    </div>
                  )}
                </div>
              );
            case 'assistant':
              return <div key={i} className="msg assistant">{it.text}</div>;
            case 'note':
              return <div key={i} className="label" style={{ textAlign: 'center' }}>{it.text}</div>;
            case 'tool':
              // The dot carries the state the glyphs used to: volt when it came back clean, amber
              // while it is still running, coral when it failed. Only volt glows.
              return (
                <details key={i} className={`tool${it.isError ? ' error' : ''}`}>
                  <summary>
                    <span className={`dot${it.summary === undefined ? ' running' : it.isError ? ' error' : ''}`} aria-hidden="true" />
                    <span>
                      {it.name}
                      {typeof it.input.description === 'string' ? `: ${it.input.description}` : typeof it.input.selector === 'string' ? ` ${it.input.selector}` : ''}
                    </span>
                  </summary>
                  {typeof it.input.code === 'string' && <pre>{it.input.code}</pre>}
                  {it.summary && <pre>{it.summary}</pre>}
                </details>
              );
            case 'proposal':
              // The hero of this screen: the one card that takes the glow.
              return (
                <div key={i} className="card hero">
                  <div>
                    <div className="label">proposed mod</div>
                    <h4>{it.proposal.name}</h4>
                  </div>
                  <div className="desc">{it.proposal.description}</div>
                  <div className="row">{it.proposal.matches.map((m) => <span key={m} className="chip">{m}</span>)}</div>
                  <details>
                    <summary>▼ code</summary>
                    <pre>{it.proposal.code}</pre>
                  </details>
                  <div className="row">
                    <button className="btn" onClick={() => void tryProposal(it.proposal)} disabled={tabId == null}>Run once</button>
                    <button className="btn primary" onClick={() => void saveProposal(it.proposal, i)} disabled={it.saved}>
                      {it.saved ? 'Saved · enabled' : 'Save & enable'}
                    </button>
                  </div>
                </div>
              );
            case 'error':
              return <div key={i} className="error">{it.text}</div>;
          }
        })}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        {refs.length > 0 && (
          <div className="row">
            {refs.map((r) => (
              <span key={r.token} className="chip ref" title={r.selector}>
                @{r.token} · {r.label}{' '}
                <button className="chip-x" onClick={() => removeRef(r.token)} title="Remove reference">×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={unsupported ? 'open a web page first' : 'what should this page do differently? point at elements to reference them'}
          disabled={unsupported}
        />
        <div className="row">
          <button className="btn" onClick={() => void pick()} disabled={picking || unsupported || tabId == null} title="Click an element on the page to reference it in your message">
            {picking ? 'click an element…' : 'Point at element'}
          </button>
          <button className="btn" onClick={newChat} disabled={unsupported || !host || (!chatId && items.length === 0)}>New chat</button>
          <span className="grow" />
          {busy && <button className="btn danger" onClick={abort}>Stop</button>}
          <button className="btn primary" onClick={() => void send()} disabled={!text.trim() || unsupported}>{busy ? 'Queue' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}

/** The saved mod a proposal of this name would revise, or undefined to save a new one. */
async function findModByName(name: string): Promise<Mod | undefined> {
  try {
    return findByName(await rpc({ type: 'mods.list' }), name);
  } catch {
    return undefined; // could not check; saving a new mod is better than failing the save
  }
}

/**
 * Did this transcript stop mid-turn? A tool row without a result, or a message still marked queued,
 * means the panel went away while the background was working.
 */
export function looksUnfinished(items: ChatItem[]): boolean {
  return items.some((it) => (it.kind === 'tool' && it.summary === undefined) || (it.kind === 'user' && it.queued === true));
}

/** A short, readable token from a selector's last segment, e.g. `#main-nav > a.logo` → `a.logo`. */
function tokenFor(selector: string): string {
  const last = selector.split('>').pop()?.trim() ?? selector;
  const cleaned = last.replace(/:nth-of-type\(\d+\)/g, '').replace(/[^\w.#-]/g, '');
  return cleaned.replace(/^\./, '').slice(0, 24) || 'el';
}

function uniqueToken(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}${i}`)) return `${base}${i}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
