import { useEffect, useRef, useState } from 'react';
import { Activity } from './Activity';
import { IDLE_ACTIVITY, activityFromEvent, allDisconnected, withActivity, withoutActivity, type ChatActivity } from '@/lib/activity';
import { archivedChats, isArchived, liveChats, loadItems, pickChatToShow, relativeTime, saveItems, titleFromText, type Chat as ChatRecord } from '@/lib/chats';
import { findByName } from '@/lib/modmatch';
import { modFromProposal } from '@/lib/mods';
import { rpc, type AgentPortRequest } from '@/lib/rpc';
import { RECONNECT_NOTE, looksUnfinished, reduceItems, unqueuedItem } from '@/lib/transcript';
import type { AgentEvent, ChatItem, ContentEvent, ElementRef, Mod, ModProposal } from '@/lib/types';

const SAVE_DEBOUNCE_MS = 400;

export function Chat({ tabId, pageUrl, host }: { tabId: number | null; pageUrl: string; host: string }) {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  /** False while the panel is still working out which chat to show, so nothing flashes. */
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  /**
   * Which chats are running right now, by chat id. Runs are per chat, not per panel: chat A can be
   * streaming on one tab while the user reads chat B, so "busy" is a question you ask about a chat,
   * never about the panel. `busy` below is this set's answer for the visible chat.
   */
  const [runningChats, setRunningChats] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * What the live activity line shows, PER CHAT. The indicator is about one conversation's run, and
   * several can be in flight at once, so a single state object would have shown chat A's tool call
   * to someone reading chat B — the same class of bug the chat-isolation fix removed everywhere
   * else. Every event updates its own chat's entry, including chats that are off screen, so
   * switching to a running chat shows that chat's real progress rather than starting from nothing.
   */
  const [activities, setActivities] = useState<ReadonlyMap<string, ChatActivity>>(() => new Map());
  /**
   * The last message sent in each chat, so Retry on a dead port resends into the chat the failed
   * message belonged to and not into whatever happens to be on screen.
   */
  const lastSentRef = useRef<Map<string, { text: string; refs?: ElementRef[] }>>(new Map());
  const [refs, setRefs] = useState<ElementRef[]>([]);
  const [picking, setPicking] = useState(false);
  /** The draft title while the switcher is in rename mode, or null when it is a select again. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** The chat the panel is showing, readable from the port listener, which outlives renders. */
  const chatIdRef = useRef<string | null>(null);
  /**
   * Chats whose restored transcript looked cut off mid-run, so the next event for each says so
   * once. Per chat, because two chats can both have been interrupted.
   */
  const reconnectRef = useRef<Set<string>>(new Set());
  /**
   * The debounced save for the visible chat: the id it was scheduled for, and its timer. Held in a
   * ref rather than an effect cleanup so a chat or host switch can FLUSH it — writing A's items
   * under B's id is precisely the bug this whole change is about.
   */
  const pendingSaveRef = useRef<{ chatId: string; items: ChatItem[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  /**
   * One write chain per chat id for background chats' transcripts, so a burst of events for a chat
   * the user is not looking at cannot interleave its read-modify-write cycles and lose rows.
   */
  const offscreenWritesRef = useRef<Map<string, Promise<ChatItem[]>>>(new Map());
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
  // The port listener is registered once and closes over the first render's state, so what it has
  // to read at event time lives in refs — and those refs are advanced eagerly by showChat() and
  // updateItems(), not a render later. An event arriving in the same tick as a chat switch must
  // already see the new chat, or it is filed against the wrong one, which is this whole bug.
  const itemsRef = useRef<ChatItem[]>(items);
  /** Is the chat currently on screen the one that is running? Never "is the panel busy". */
  const busy = chatId != null && runningChats.has(chatId);
  /**
   * The activity line for the chat on screen, and only that one. A chat with no entry has nothing
   * to say, which is how switching from a running chat to an idle one clears the line instantly.
   */
  const activity = (chatId != null ? activities.get(chatId) : undefined) ?? IDLE_ACTIVITY;

  // Pick up this site's chats and show the most recently updated live one, transcript and all. A
  // chat is only created on first send, so opening the panel on a new site does not litter storage
  // with empty chats. The list and the transcript are fetched together and committed in one go:
  // that way the panel never renders a chat id with someone else's items, and never shows the
  // empty state for a host that turns out to have a chat.
  useEffect(() => {
    const gen = ++genRef.current;
    const live = () => genRef.current === gen;
    // Whatever was scheduled belongs to the chat we are leaving, so write it under THAT id now,
    // and hand that chat over to the background path in case it is still running.
    flushSave();
    handOff(chatIdRef.current, itemsRef.current);
    setLoaded(false);
    showChat(null, []);
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
        const stored = await readItems(show.id);
        if (!live()) return;
        setChats(list);
        showChat(show.id, stored);
        markReconnect(show.id, stored);
        setLoaded(true);
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
      } catch {
        if (live()) setLoaded(true);
      }
    })();
  }, [host]);

  // Persist the visible chat's transcript, debounced so a streaming turn does not write on every
  // delta. The id is captured HERE, at schedule time, and the pending write is flushed before the
  // view moves — a timer that fired after a switch used to write the old chat's items under the
  // new chat's id, which is how transcripts from different chats ended up merged.
  useEffect(() => {
    if (!chatId || !loaded) return;
    scheduleSave(chatId, items);
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

  /**
   * Queue the visible chat's transcript for a debounced write under the id it belongs to.
   * Rescheduling replaces the pending write for that same id; a different id flushes first.
   */
  function scheduleSave(id: string, next: ChatItem[]) {
    const pending = pendingSaveRef.current;
    if (pending) {
      clearTimeout(pending.timer);
      if (pending.chatId !== id) void saveItems(pending.chatId, pending.items).catch(() => {});
    }
    const timer = setTimeout(() => {
      pendingSaveRef.current = null;
      void saveItems(id, next).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    pendingSaveRef.current = { chatId: id, items: next, timer };
  }

  /** Write any pending transcript now, under the id it was scheduled for. Called before a switch. */
  function flushSave() {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSaveRef.current = null;
    void saveItems(pending.chatId, pending.items).catch(() => {});
  }

  /**
   * Apply an event to a chat the user is NOT looking at: read its stored transcript, reduce, write
   * it back. Chained per chat id so a stream of deltas cannot interleave read-modify-write cycles.
   * This is what keeps a run complete while the user reads another chat, rather than either losing
   * its output or spilling it into whatever is on screen.
   */
  function applyOffscreen(id: string, e: AgentEvent) {
    const chain = offscreenChain(id);
    const next = chain.then(async (prev) => {
      let base = prev;
      if (reconnectRef.current.has(id)) {
        reconnectRef.current.delete(id);
        base = [...base, { kind: 'note', text: RECONNECT_NOTE }];
      }
      // An 'unqueued' for an invisible chat cannot put text back in the composer — that composer
      // belongs to the chat on screen — so the bubble simply goes away.
      const reduced = reduceItems(base, e);
      if (reduced !== prev) await saveItems(id, reduced).catch(() => {});
      return reduced;
    });
    offscreenWritesRef.current.set(id, next);
    void next.catch(() => {});
  }

  /** The tail of a background chat's write chain, started from storage the first time. */
  function offscreenChain(id: string): Promise<ChatItem[]> {
    const existing = offscreenWritesRef.current.get(id);
    if (existing) return existing;
    const started = loadItems(id).catch(() => [] as ChatItem[]);
    offscreenWritesRef.current.set(id, started);
    return started;
  }

  /**
   * A chat's transcript for putting on screen. It has to go through the same per-chat chain that
   * background events write on, or opening a chat that is mid-run would read storage from before
   * the write in flight and then overwrite it with that stale copy.
   */
  function readItems(id: string): Promise<ChatItem[]> {
    const next = offscreenChain(id).then((items) => items);
    offscreenWritesRef.current.set(id, next);
    return next;
  }

  /**
   * Hand a chat we are leaving over to the background path: its chain starts from exactly what was
   * on screen, so no event is applied to a stale copy in the gap between the flush and the first
   * offscreen write.
   */
  function handOff(id: string | null, current: ChatItem[]) {
    if (id) offscreenWritesRef.current.set(id, Promise.resolve(current));
  }

  function connect(): chrome.runtime.Port {
    if (portRef.current) return portRef.current;
    const port = chrome.runtime.connect({ name: 'agent' });
    port.onMessage.addListener((e: AgentEvent) => {
      // The activity line, folded in by the event's OWN chat. This happens above the routing
      // below, and for off-screen chats too: a run the user is not watching still has to have its
      // progress recorded, so switching to it shows where it actually is rather than nothing.
      setActivities((prev) => withActivity(prev, e.chatId, (a) => activityFromEvent(a, e)));

      // Route by the event's own chat, never by "the chat this port last started". One port serves
      // the whole panel, and the panel may well be showing a different chat than the one running.
      if (e.type === 'done') setRunningChats((prev) => withoutChat(prev, e.chatId));
      else setRunningChats((prev) => (prev.has(e.chatId) ? prev : new Set(prev).add(e.chatId)));

      // The background named the chat after its turn finished. This renames a row in the switcher,
      // not a message, so it is patched in place here rather than refetched — and it is done above
      // the routing below, because the switcher lists every chat on this host, not just the visible
      // one: a chat that named itself while you were reading another should still update its row.
      if (e.type === 'chat_title') {
        setChats((prev) => prev.map((c) => (c.id === e.chatId ? { ...c, title: e.title, titleSource: 'auto-model' } : c)));
      }

      if (e.chatId !== chatIdRef.current) {
        applyOffscreen(e.chatId, e);
        return;
      }

      if (e.type === 'accepted' && !titleFixRef.current) {
        // The background has now run touchChat, so the stored title and updatedAt are real.
        // Reading them back once per run keeps the switcher honest even if the optimistic title
        // guessed differently (e.g. a chat that already had a title).
        titleFixRef.current = true;
        void refreshChats();
      }
      if (e.type === 'unqueued') {
        // Only the chat on screen owns the composer, so only it gets its text back.
        const dropped = unqueuedItem(itemsRef.current, e.id);
        if (dropped) {
          setText((t) => (t.trim() ? `${t.trim()}\n${dropped.text}` : dropped.text));
          if (dropped.refs) setRefs((r) => [...r, ...dropped.refs!]);
        }
      }
      updateItems((prev) => {
        // A run that outlived the panel keeps streaming into a port we no longer hold. We cannot
        // recover the text we missed, so the first event back into that chat just says so.
        let base = prev;
        if (reconnectRef.current.has(e.chatId)) {
          reconnectRef.current.delete(e.chatId);
          base = [...base, { kind: 'note', text: RECONNECT_NOTE }];
        }
        return reduceItems(base, e);
      });
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      // The worker went away (or was restarted): nothing is streaming to us any more. Runs
      // themselves survive in the background and their transcripts are written there.
      setRunningChats(new Set());
      // The port is the panel's only link to every chat at once, so a dead port marks EVERY chat
      // that was mid-run as disconnected — not just the visible one. Each such chat then offers
      // its own Retry, which resends that chat's own last message.
      setActivities(allDisconnected);
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

  /**
   * Send now, or queue if a turn is running. Queued messages reach the model between its tool calls.
   *
   * `resend` lets a caller supply the message explicitly rather than reading it out of the composer,
   * which Retry needs: it runs from an event handler that closed over the previous render's state,
   * so putting the text back with setText and calling send() would send the stale (empty) value.
   */
  async function send(resend?: { text: string; refs?: ElementRef[] }) {
    const t = (resend?.text ?? text).trim();
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
        showChat(chat.id, itemsRef.current);
        setLoaded(true);
      } catch (e) {
        updateItems((prev) => [...prev, { kind: 'error', text: `Could not start a chat: ${e instanceof Error ? e.message : String(e)}` }]);
        return;
      }
    }
    // Only send references whose token still appears in the message.
    const used = (resend?.refs ?? refs).filter((r) => new RegExp(`@${escapeRe(r.token)}(?![\\w.#-])`).test(t));
    const msgId = crypto.randomUUID();
    // Queued only if THIS chat is already running. A run on another tab does not queue anything.
    const queued = runningChats.has(id);
    updateItems((prev) => [...prev, { kind: 'user', id: msgId, text: t, refs: used.length ? used : undefined, queued }]);
    setText('');
    setRefs([]);
    setRunningChats((prev) => (prev.has(id!) ? prev : new Set(prev).add(id!)));
    lastSentRef.current.set(id, { text: t, refs: used.length ? used : undefined });
    // Start THIS chat's line immediately, before any event comes back, so "is it stuck?" is
    // answered from the very first frame rather than once the background gets round to us. It is
    // filed under the chat the message went to, so sending and then switching away leaves the
    // indicator with the run rather than with the view.
    const at = Date.now();
    setActivities((prev) =>
      withActivity(prev, id!, (a) => ({
        phase: 'model',
        detail: 'waiting for model',
        startedAt: a.phase === 'idle' ? at : (a.startedAt ?? at),
        lastEventAt: at,
        queued: a.phase === 'idle' ? 0 : a.queued + 1,
      })),
    );
    const req: AgentPortRequest = { type: 'send', tabId, chatId: id, id: msgId, text: t, refs: used.length ? used : undefined };
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

  /** Stop the chat on screen. Only that chat: another tab's run is none of this button's business. */
  function abort() {
    if (!chatId) return;
    portRef.current?.postMessage({ type: 'abort', chatId } satisfies AgentPortRequest);
    // Only this chat's line goes quiet. The background still posts this chat's 'idle'/'done', but
    // clearing here means the button the user just pressed has a visible effect immediately.
    setActivities((prev) => withoutActivity(prev, chatId));
  }

  /**
   * Retry after the worker died: resend the message the dead port never delivered — into the chat
   * it belonged to, which is the chat whose line is offering the button, not merely "the current
   * chat". connect() will open a fresh port, which wakes the service worker back up.
   */
  function retry() {
    const id = chatId;
    if (!id) return;
    const last = lastSentRef.current.get(id);
    setActivities((prev) => withoutActivity(prev, id));
    setRunningChats((prev) => withoutChat(prev, id));
    if (last) void send(last);
  }

  /**
   * Leave the current chat. The run is deliberately NOT stopped: it belongs to its own chat and
   * keeps streaming into that chat's stored transcript, which is the whole point of the fix. All
   * that has to happen here is that the pending transcript write lands under the id it was made
   * for, before the view moves.
   */
  function detach() {
    flushSave();
    handOff(chatIdRef.current, itemsRef.current);
    // The activity entry is deliberately left alone: the run is not being stopped, so its progress
    // must go on being recorded while the user is elsewhere and be there again on the way back.
    titleFixRef.current = false;
    // A half-typed name belongs to the chat being left, so it is dropped rather than carried over.
    setRenaming(null);
  }

  /**
   * Change the visible transcript. The ref advances with the state rather than a render later, so
   * a burst of events in one tick all reduce from what the previous one produced, and a switch
   * that happens in the same tick hands off exactly what was on screen.
   */
  function updateItems(fn: (prev: ChatItem[]) => ChatItem[]) {
    const next = fn(itemsRef.current);
    if (next === itemsRef.current) return;
    itemsRef.current = next;
    setItems(next);
  }

  /**
   * Put a chat (or the empty composer) on screen. The ref moves first and in the same statement as
   * the state, so the port listener never sees a moment where the id and the items disagree — that
   * gap is how one chat's events landed in another chat's transcript.
   */
  function showChat(id: string | null, next: ChatItem[]) {
    chatIdRef.current = id;
    itemsRef.current = next;
    // On screen, this chat is written by the visible path alone; its background chain is done.
    if (id) offscreenWritesRef.current.delete(id);
    setChatId(id);
    setItems(next);
  }

  /** Remember that this chat's restored transcript stops mid-run, so its next event says so once. */
  function markReconnect(id: string, stored: ChatItem[]) {
    if (looksUnfinished(stored)) reconnectRef.current.add(id);
    else reconnectRef.current.delete(id);
  }

  /**
   * Show a stored chat: load its transcript, then commit id and items together. Generation-guarded
   * like the host effect, so a slow load cannot overwrite a chat the user has since moved on from.
   */
  function openChat(id: string) {
    const gen = ++genRef.current;
    detach();
    setLoaded(false);
    showChat(id, []);
    void readItems(id)
      .then((stored) => {
        if (genRef.current !== gen) return;
        showChat(id, stored);
        markReconnect(id, stored);
        setLoaded(true);
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
      })
      .catch(() => {
        if (genRef.current === gen) setLoaded(true);
      });
  }

  /**
   * Switching away from a chat that is mid-run is fine now: its events carry its own chat id, so
   * they go on filling in its stored transcript while the user reads something else.
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
    showChat(null, []);
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
      updateItems((prev) => [...prev, { kind: 'error', text: `Could not start the picker: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }

  async function tryProposal(p: ModProposal) {
    if (tabId == null) return;
    const r = await rpc({ type: 'mods.try', tabId, code: p.code });
    updateItems((prev) => [...prev, { kind: 'tool', id: crypto.randomUUID(), name: 'try', input: { description: 'Ran the proposed mod once' }, summary: r.ok ? `OK${r.logs.length ? ': ' + r.logs.join(' | ') : ''}` : r.error, isError: !r.ok }]);
  }

  /**
   * Save a proposal, updating the mod it revises rather than minting a new id. Asking the model to
   * change a mod produces a fresh proposal under the same name; without this, each save left another
   * copy behind and every copy ran on the page.
   */
  async function saveProposal(p: ModProposal, idx: number) {
    const existing = await findModByName(p.name);
    await rpc({ type: 'mods.save', mod: modFromProposal(p, existing) });
    updateItems((prev) => prev.map((it, i) => (i === idx && it.kind === 'proposal' ? { ...it, saved: true } : it)));
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
      <Activity
        phase={activity.phase}
        tool={activity.tool}
        detail={activity.detail}
        iteration={activity.iteration}
        startedAt={activity.startedAt}
        lastEventAt={activity.lastEventAt}
        writing={activity.writing}
        queued={activity.queued}
        disconnected={activity.disconnected}
        onStop={abort}
        onRetry={retry}
      />
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

/** The running set without one chat, or the same set when it was not in it (so React can skip). */
function withoutChat(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
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
