import { useEffect, useRef, useState } from 'react';
import { loadItems, relativeTime, saveItems, type Chat as ChatRecord } from '@/lib/chats';
import { modFromProposal } from '@/lib/mods';
import { rpc, type AgentPortRequest } from '@/lib/rpc';
import type { AgentEvent, ChatItem, ContentEvent, ElementRef, ModProposal } from '@/lib/types';

const SAVE_DEBOUNCE_MS = 400;

export function Chat({ tabId, pageUrl, host }: { tabId: number | null; pageUrl: string; host: string }) {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refs, setRefs] = useState<ElementRef[]>([]);
  const [picking, setPicking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** The chat the open port is running, so a switch does not misfile incoming events. */
  const portChatRef = useRef<string | null>(null);
  /** Set when the restored transcript looks like it was cut off mid-run, so the next port event says so. */
  const reconnectRef = useRef(false);
  /** A chat id this panel just created, so the restore effect leaves its in-progress transcript alone. */
  const freshRef = useRef<string | null>(null);

  // Pick up this site's chats and select the most recent one. A chat is only created on first send,
  // so opening the panel on a new site does not litter storage with empty chats.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    if (!host) {
      setChats([]);
      setChatId(null);
      setItems([]);
      setLoaded(true);
      return;
    }
    void rpc({ type: 'chats.list', host })
      .then((list) => {
        if (cancelled) return;
        setChats(list);
        setChatId(list[0]?.id ?? null);
        if (!list.length) {
          setItems([]);
          setLoaded(true);
        }
      })
      .catch(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [host]);

  // Restore a chat's transcript when it becomes the active one. Until it has loaded, `loaded` stays
  // false so the save effect below cannot write the previous chat's items under this chat's key.
  useEffect(() => {
    let cancelled = false;
    if (!chatId) return;
    // A chat this panel just created is already on screen (the message that created it); there is
    // nothing stored to restore, and reloading would wipe it.
    if (freshRef.current === chatId) {
      freshRef.current = null;
      return;
    }
    setLoaded(false);
    setItems([]);
    void loadItems(chatId)
      .then((stored) => {
        if (cancelled) return;
        setItems(stored);
        reconnectRef.current = looksUnfinished(stored);
        setLoaded(true);
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
      })
      .catch(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [chatId]);

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
            return next.map((it) => (it.kind === 'user' && it.id === e.id ? { ...it, queued: false } : it));
          case 'unqueued': {
            const dropped = next.find((it) => it.kind === 'user' && it.id === e.id) as Extract<ChatItem, { kind: 'user' }> | undefined;
            if (dropped) {
              setText((t) => (t.trim() ? `${t.trim()}\n${dropped.text}` : dropped.text));
              if (dropped.refs) setRefs((r) => [...r, ...dropped.refs!]);
            }
            return next.filter((it) => !(it.kind === 'user' && it.id === e.id));
          }
          case 'error':
            next.push({ kind: 'error', text: e.message });
            return next;
          case 'done':
            return next;
        }
      });
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
      try {
        const chat = await rpc({ type: 'chats.create', host });
        id = chat.id;
        freshRef.current = chat.id;
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
    connect().postMessage(req);
    // Reflect the new activity (and the title, on the first message) in the switcher.
    void rpc({ type: 'chats.list', host }).then(setChats).catch(() => {});
  }

  function abort() {
    portRef.current?.postMessage({ type: 'abort' } satisfies AgentPortRequest);
  }

  /**
   * Switching away from a chat that is mid-run would misfile the run's remaining events into the
   * chat we land on, so the run is stopped first. The model history is already saved either way.
   */
  function switchTo(id: string | null) {
    if (id === chatId) return;
    if (id === null) {
      newChat();
      return;
    }
    if (busy) abort();
    portChatRef.current = null;
    reconnectRef.current = false;
    setChatId(id);
  }

  /**
   * Clear the view and wait. The chat record itself is created by the first send, so hitting
   * "New chat" and changing your mind leaves nothing behind.
   */
  function newChat() {
    if (!host) return;
    if (busy) abort();
    portChatRef.current = null;
    reconnectRef.current = false;
    setChatId(null);
    setItems([]);
    setLoaded(true);
  }

  async function removeChat() {
    if (!chatId) return;
    const current = chats.find((c) => c.id === chatId);
    if (!confirm(`Delete "${current?.title ?? 'this chat'}"?`)) return;
    abort();
    await rpc({ type: 'chats.delete', id: chatId });
    const rest = chats.filter((c) => c.id !== chatId);
    portChatRef.current = null;
    reconnectRef.current = false;
    setChats(rest);
    setItems([]);
    // Fall through to the site's next most recent chat, or to the empty "New chat" state.
    setChatId(rest[0]?.id ?? null);
    if (!rest.length) setLoaded(true);
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

  async function saveProposal(p: ModProposal, idx: number) {
    await rpc({ type: 'mods.save', mod: modFromProposal(p) });
    setItems((prev) => prev.map((it, i) => (i === idx && it.kind === 'proposal' ? { ...it, saved: true } : it)));
  }

  const unsupported = !pageUrl || /^(chrome|edge|about|chrome-extension|devtools):/.test(pageUrl);

  return (
    <div className="chat">
      {!unsupported && host && chats.length > 0 && (
        <div className="chatbar">
          <select value={chatId ?? ''} onChange={(e) => switchTo(e.target.value || null)} title={`Chats on ${host}`}>
            <option value="">New chat…</option>
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} · {relativeTime(c.updatedAt)}
              </option>
            ))}
          </select>
          <button className="btn danger" onClick={() => void removeChat()} disabled={!chatId} title="Delete this chat">Delete</button>
        </div>
      )}
      <div className="messages">
        {items.length === 0 && (
          <div className="empty">
            {unsupported ? (
              <>Open a regular web page to start.</>
            ) : (
              <>
                Describe how you want this page to change.
                <br />
                <span className="muted">e.g. "hide the sidebar", "make the font bigger", "add a button that copies the title"</span>
              </>
            )}
          </div>
        )}
        {items.map((it, i) => {
          switch (it.kind) {
            case 'user':
              return (
                <div key={i} className={`msg user${it.queued ? ' queued' : ''}`}>
                  {it.queued && <div className="muted" style={{ fontSize: 11 }}>queued · will be sent between steps</div>}
                  {it.text}
                  {it.refs && (
                    <div className="row" style={{ marginTop: 4 }}>
                      {it.refs.map((r) => <span key={r.token} className="chip" title={r.selector}>@{r.token} → {r.label}</span>)}
                    </div>
                  )}
                </div>
              );
            case 'assistant':
              return <div key={i} className="msg assistant">{it.text}</div>;
            case 'note':
              return <div key={i} className="muted" style={{ fontSize: 11, textAlign: 'center' }}>{it.text}</div>;
            case 'tool':
              return (
                <details key={i} className={`tool${it.isError ? ' error' : ''}`}>
                  <summary>
                    {it.summary === undefined ? '⏳ ' : it.isError ? '✗ ' : '✓ '}
                    {it.name}
                    {typeof it.input.description === 'string' ? `: ${it.input.description}` : typeof it.input.selector === 'string' ? ` ${it.input.selector}` : ''}
                  </summary>
                  {typeof it.input.code === 'string' && <pre>{it.input.code}</pre>}
                  {it.summary && <pre>{it.summary}</pre>}
                </details>
              );
            case 'proposal':
              return (
                <div key={i} className="card">
                  <h4>{it.proposal.name}</h4>
                  <div className="desc">{it.proposal.description}</div>
                  <div className="row">{it.proposal.matches.map((m) => <span key={m} className="chip">{m}</span>)}</div>
                  <details>
                    <summary className="muted">Show code</summary>
                    <pre>{it.proposal.code}</pre>
                  </details>
                  <div className="row">
                    <button className="btn" onClick={() => void tryProposal(it.proposal)} disabled={tabId == null}>Try now</button>
                    <button className="btn primary" onClick={() => void saveProposal(it.proposal, i)} disabled={it.saved}>
                      {it.saved ? 'Saved & enabled' : 'Save & enable'}
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
              <span key={r.token} className="chip" title={r.selector}>
                @{r.token} → {r.label}{' '}
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
          placeholder={unsupported ? 'Open a web page first' : 'What should this page do differently? Use ⌖ to point at elements.'}
          disabled={unsupported}
        />
        <div className="row">
          <button className="btn" onClick={() => void pick()} disabled={picking || unsupported || tabId == null} title="Click an element on the page to reference it in your message">
            {picking ? 'Click an element…' : '⌖ Point at element'}
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
