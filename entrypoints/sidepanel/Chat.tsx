import { useEffect, useRef, useState } from 'react';
import { Activity } from './Activity';
import { Lightbox, PendingStrip, SentImages, type PendingImage } from './Attachments';
import { carriesFiles, fileFromDataUrlText, filesFromTransfer, processImageFile } from './images';
import { IDLE_ACTIVITY, activityFromEvent, allDisconnected, withActivity, withoutActivity, type ChatActivity } from '@/lib/activity';
import { putBlobs } from '@/lib/blobs';
import { archivedChats, isArchived, liveChats, loadItems, pickChatToShow, relativeTime, saveItems, titleFromText, type Chat as ChatRecord } from '@/lib/chats';
import { HANDOFF_KEY, resolveHandoff, type ChatHandoff } from '@/lib/dashboard';
import { ACCEPT_ATTR, MAX_IMAGES_PER_MESSAGE, capNote, emptyTextFor, type AttachedImage, type ImageThumb } from '@/lib/images';
import { findByName } from '@/lib/modmatch';
import { modFromProposal } from '@/lib/mods';
import { rpc, type AgentPortRequest } from '@/lib/rpc';
import { RECONNECT_NOTE, looksUnfinished, reduceItems, toolDotClass, toolDotState, toolRowTitle, unqueuedItem } from '@/lib/transcript';
import type { AgentEvent, ChatItem, ContentEvent, ElementRef, Mod, ModProposal } from '@/lib/types';

const SAVE_DEBOUNCE_MS = 400;

/**
 * What the composer holds for one chat while you are not looking at it.
 *
 * Attachments made this necessary and text came along with them. Dropping a mockup into chat A,
 * switching to B to check something and coming back had to leave the mockup where it was — it
 * belongs to the thing you were asking A, not to the panel — and the half-typed sentence beside it
 * is exactly the same kind of thing. So both are per chat, keyed by chat id, with the unsent chat
 * (no id yet) under a sentinel of its own.
 */
interface Draft {
  text: string;
  refs: ElementRef[];
  images: ComposerImage[];
}

/** A pending attachment: what the strip renders, plus the full-size copy that will be sent. */
interface ComposerImage extends PendingImage {
  full: AttachedImage;
}

const EMPTY_DRAFT: Draft = { text: '', refs: [], images: [] };

/** Where the draft of a chat that does not exist yet lives. A chat id is a UUID, so this is safe. */
const NEW_CHAT_DRAFT = 'new';

/**
 * A chatbar action label that can give up its tail when the bar is narrow.
 *
 * The switcher's <select> has to carry a chat title, and the two actions beside it were eating the
 * width it needed — "Full-width Wikipedia articles · n" truncated mid-word at the default side
 * panel size. The actions are the part that can afford to lose characters: RENAME and ARCHIVE are
 * still unmistakable as REN and ARCH next to a chat you are already looking at.
 *
 * The tail is CLIPPED rather than removed, exactly as the top bar's `.tab-action-label` is, so the
 * full word stays in the DOM: `title` and the accessibility tree keep it, and the smoke suite's
 * `hasText: 'Archive'` locators keep matching, because `display: none` would take the text out of
 * both. Above the chatbar's container breakpoint the tail comes back and the labels are whole.
 */
function ActionLabel({ head, tail }: { head: string; tail: string }) {
  return (
    <>
      {head}
      <span className="action-tail">{tail}</span>
    </>
  );
}

export function Chat({ tabId, pageUrl, host }: { tabId: number | null; pageUrl: string; host: string }) {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  /** False while the panel is still working out which chat to show, so nothing flashes. */
  const [loaded, setLoaded] = useState(false);
  /**
   * Every chat's unsent composer, by chat id (and NEW_CHAT_DRAFT for the one not created yet).
   * `text`, `refs` and `images` below are this map's answer for the chat on screen, so every
   * existing reader keeps working and nothing has to remember which chat it is writing into.
   */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => new Map());
  /** An inline complaint about the last paste or drop — a refused SVG, a file over the cap. */
  const [attachNote, setAttachNote] = useState<string | null>(null);
  /** The image the lightbox is showing, or null when it is closed. */
  const [viewing, setViewing] = useState<ImageThumb | null>(null);
  /** True while a file is being dragged over the panel, so the drop target is visible. */
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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
  const lastSentRef = useRef<Map<string, { text: string; refs?: ElementRef[]; images?: AttachedImage[] }>>(new Map());
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

  /** The draft key for the chat on screen: its id, or the sentinel for a chat not created yet. */
  const draftKey = chatId ?? NEW_CHAT_DRAFT;
  const draft = drafts.get(draftKey) ?? EMPTY_DRAFT;
  const { text, refs, images } = draft;

  /** Edit the visible chat's draft. Every composer write goes through here, so none can stray. */
  function editDraft(fn: (d: Draft) => Draft) {
    const key = chatIdRef.current ?? NEW_CHAT_DRAFT;
    setDrafts((prev) => {
      const next = new Map(prev);
      const updated = fn(prev.get(key) ?? EMPTY_DRAFT);
      if (!updated.text && !updated.refs.length && !updated.images.length) next.delete(key);
      else next.set(key, updated);
      return next;
    });
  }

  /** The composer's text, as a plain setter, so the existing call sites read unchanged. */
  function setText(value: string | ((prev: string) => string)) {
    editDraft((d) => ({ ...d, text: typeof value === 'function' ? value(d.text) : value }));
  }

  function setRefs(value: ElementRef[] | ((prev: ElementRef[]) => ElementRef[])) {
    editDraft((d) => ({ ...d, refs: typeof value === 'function' ? value(d.refs) : value }));
  }

  /**
   * A message that was created in the not-yet-a-chat slot has to follow its chat once the chat is
   * created, or the first send would leave its own attachments behind under the sentinel.
   */
  function adoptDraft(id: string) {
    setDrafts((prev) => {
      const pending = prev.get(NEW_CHAT_DRAFT);
      if (!pending) return prev;
      const next = new Map(prev);
      next.delete(NEW_CHAT_DRAFT);
      next.set(id, pending);
      return next;
    });
  }

  /** Empty the visible chat's composer once its message is on its way. */
  function clearDraft(id: string) {
    setDrafts((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  // Pick up this site's chats and show the most recently updated live one, transcript and all. A
  // chat is only created on first send, so opening the panel on a new site does not litter storage
  // with empty chats. The list and the transcript are fetched together and committed in one go:
  // that way the panel never renders a chat id with someone else's items, and never shows the
  // empty state for a host that turns out to have a chat.
  //
  // Unless the dashboard sent us here. Its "Open" writes a handoff to session storage and then
  // opens the page in a tab; when the panel lands on that host it opens THAT chat instead of the
  // most recent one, and consumes the handoff so a later mount does not reopen it again.
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
        const [list, handoff] = await Promise.all([rpc({ type: 'chats.list', host }), readHandoff()]);
        if (!live()) return;
        const { chat: show, clearHandoff } = resolveHandoff(handoff, host, list, pickChatToShow(list));
        if (clearHandoff) void chrome.storage.session.remove(HANDOFF_KEY).catch(() => {});
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
   * Write the pending transcript before the panel goes away.
   *
   * The save is debounced by 400ms so a streaming turn does not write on every delta, which means
   * there is always a window where the last thing that happened is in memory and not on disk. A
   * side panel is closed and reopened constantly — and a reopened panel reads storage and then
   * renders what it found, so a turn that ended inside that window came back missing its last rows
   * and, worse, the empty read was written straight back over it.
   *
   * pagehide fires on the close, on a reload and on a navigation, and is the last event a page is
   * guaranteed to get; the storage call it makes is fire-and-forget by necessity, but chrome
   * .storage.local accepts the write before the context is torn down.
   */
  useEffect(() => {
    const onHide = () => flushSave();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      // Unmounting is the same situation as a close: whatever is pending belongs on disk.
      flushSave();
    };
  }, []);

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
      //
      // 'chat_title' is deliberately neither: it is posted by the naming call, which runs AFTER
      // 'done' and is not part of the turn. Treating it as proof of life put the finished chat
      // straight back into runningChats, which left Stop and Queue on screen for a chat that had
      // stopped — with no activity line beside them, since the run really was over.
      if (e.type === 'done') setRunningChats((prev) => withoutChat(prev, e.chatId));
      else if (e.type !== 'chat_title') setRunningChats((prev) => (prev.has(e.chatId) ? prev : new Set(prev).add(e.chatId)));

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
        //
        // Its images do NOT come back with it. They are already in this chat's blob store, but the
        // composer holds the full-size copy and the transcript held only a thumbnail, so putting
        // them back as attachments would mean re-reading and re-decoding them to send a message the
        // user may not resend at all. The text returns; the pictures are mentioned in it.
        const dropped = unqueuedItem(itemsRef.current, e.id);
        if (dropped) {
          const n = dropped.images?.length ?? 0;
          const back = n ? `${dropped.text}\n[${n} attached image${n === 1 ? '' : 's'} were not resent — attach them again if you still want them]` : dropped.text;
          setText((t) => (t.trim() ? `${t.trim()}\n${back}` : back));
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

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  /**
   * Take some files: decode, downscale and re-encode each one, then add it to THIS chat's draft.
   *
   * Every rejection is an inline note rather than a thrown error or a silent drop — a refused SVG
   * and a 20 MB photo are both things the user did on purpose and deserve a sentence about.
   *
   * The chat id is captured before the first `await`. Processing a 6000px screenshot takes long
   * enough for a chat switch, and an attachment landing in whatever chat happens to be on screen
   * when the encoder finishes is exactly the isolation bug this panel spent a release removing.
   */
  async function attach(files: File[]) {
    if (!files.length) return;
    const key = chatIdRef.current ?? NEW_CHAT_DRAFT;
    const held = (drafts.get(key) ?? EMPTY_DRAFT).images.length;
    const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - held);
    const note = capNote(held, files.length);
    setAttachNote(note);
    const taking = files.slice(0, room);
    if (!taking.length) return;

    const results = await Promise.all(taking.map((f) => processImageFile(f)));
    const added: ComposerImage[] = [];
    const errors: string[] = [];
    for (const r of results) {
      if (r.ok) {
        added.push({
          id: crypto.randomUUID(),
          thumb: r.image.thumb,
          width: r.image.full.width,
          height: r.image.full.height,
          bytes: r.image.full.bytes,
          full: r.image.full,
          ...(r.image.full.name ? { name: r.image.full.name } : {}),
        });
      } else errors.push(r.error);
    }
    if (errors.length) setAttachNote(errors[0]!);
    else if (!note) setAttachNote(null);
    if (!added.length) return;

    // Written against the key we started with, not against "the current chat", and re-capped in
    // case another paste landed while these were encoding.
    setDrafts((prev) => {
      const next = new Map(prev);
      const current = prev.get(key) ?? EMPTY_DRAFT;
      next.set(key, { ...current, images: [...current.images, ...added].slice(0, MAX_IMAGES_PER_MESSAGE) });
      return next;
    });
  }

  function removeImage(id: string) {
    setAttachNote(null);
    editDraft((d) => ({ ...d, images: d.images.filter((img) => img.id !== id) }));
  }

  /**
   * A paste into the composer. Files win; a clipboard that carries only a data URL as text is
   * still an image someone meant to attach, so that is taken too.
   *
   * preventDefault runs only when something was actually taken, so pasting ordinary text still
   * pastes ordinary text.
   */
  function onPaste(e: React.ClipboardEvent) {
    if (unsupported) return;
    const files = filesFromTransfer(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      void attach(files);
      return;
    }
    const asText = e.clipboardData?.getData('text/plain') ?? '';
    const fromUrl = fileFromDataUrlText(asText);
    if (fromUrl) {
      e.preventDefault();
      void attach([fromUrl]);
    }
  }

  /** A drop on the composer or the transcript. Both land in the same place: this chat's draft. */
  function onDrop(e: React.DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(false);
    if (unsupported) return;
    void attach(filesFromTransfer(e.dataTransfer));
  }

  function onDragOver(e: React.DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (!unsupported) setDragging(true);
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
  async function send(resend?: { text: string; refs?: ElementRef[]; images?: AttachedImage[] }) {
    const attached: AttachedImage[] = resend?.images ?? images.map((img) => img.full);
    const thumbs = resend?.images ? [] : images.map((img) => img.thumb);
    // An empty box with pictures in it is a complete message; an empty box with nothing is not.
    // The text the model gets says plainly what was sent, so a bare "Attached 2 images" turn still
    // reads as a sentence in the history rather than as an empty one.
    const typed = (resend?.text ?? text).trim();
    const t = typed || (attached.length ? emptyTextFor(attached.length) : '');
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
          setText((cur) => (cur.trim() ? cur : typed));
          return;
        }
        id = chat.id;
        setChats((prev) => [chat, ...prev]);
        // The draft moves with the chat it was composed in, attachments and all, before showChat
        // repoints the composer at the new id.
        adoptDraft(chat.id);
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
    // The full-size images go to the chat's blob store once; what the transcript keeps is the
    // thumbnail and the hash that finds them again. A resend has no thumbnails to store (its
    // bubble is already on screen from the first attempt), so it skips this.
    const stored: ImageThumb[] = thumbs.length ? await putBlobs(id, attached, thumbs) : [];
    updateItems((prev) => [
      ...prev,
      { kind: 'user', id: msgId, text: t, refs: used.length ? used : undefined, images: stored.length ? stored : undefined, queued },
    ]);
    clearDraft(id);
    setAttachNote(null);
    setRunningChats((prev) => (prev.has(id!) ? prev : new Set(prev).add(id!)));
    lastSentRef.current.set(id, { text: t, refs: used.length ? used : undefined, images: attached.length ? attached : undefined });
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
    const req: AgentPortRequest = {
      type: 'send',
      tabId,
      chatId: id,
      id: msgId,
      text: t,
      refs: used.length ? used : undefined,
      images: attached.length ? attached : undefined,
    };
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
            <button className="btn" onClick={startRename} disabled={!chatId} title="Give this chat your own name. It will not be renamed automatically afterwards.">
              <ActionLabel head="Ren" tail="ame" />
            </button>
          )}
          {renaming !== null ? null : viewingArchived ? (
            <>
              <button className="btn" onClick={() => void setArchived(chatId!, false)} title="Move this chat back to the main list">
                <ActionLabel head="Unarch" tail="ive" />
              </button>
              <button className="btn danger" onClick={() => void removeChat()} title="Delete this chat for good">Delete</button>
            </>
          ) : (
            // Archive is reversible, so it stays a secondary button; coral is kept for Delete.
            <button className="btn" onClick={() => void setArchived(chatId!, true)} disabled={!chatId} title="Archive this chat: it moves to the Archived group and stops opening by default">
              <ActionLabel head="Arch" tail="ive" />
            </button>
          )}
        </div>
      )}
      <div className="messages" onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setDragging(false)}>
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
                  {it.images && it.images.length > 0 && <SentImages images={it.images} onOpen={setViewing} />}
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
                    {/* A wait_for that timed out takes the amber dot, not the coral one: the page
                        did not do the thing, which is a result, not a failure. */}
                    <span className={`dot${toolDotClass(toolDotState(it))}`} aria-hidden="true" />
                    <span>{toolRowTitle(it.name, it.input)}</span>
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
                  {/* The model said it could not run this one. Worth knowing before you save it. */}
                  {it.proposal.untestedReason && (
                    <div className="label untested">not tested on this page · {it.proposal.untestedReason}</div>
                  )}
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
      <div className={`composer${dragging ? ' dragging' : ''}`} onPaste={onPaste} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setDragging(false)}>
        {(refs.length > 0 || images.length > 0) && (
          <div className="row">
            {refs.map((r) => (
              <span key={r.token} className="chip ref" title={r.selector}>
                @{r.token} · {r.label}{' '}
                <button className="chip-x" onClick={() => removeRef(r.token)} title="Remove reference">×</button>
              </span>
            ))}
            <PendingStrip images={images} onRemove={removeImage} />
          </div>
        )}
        {attachNote && <div className="attach-note">{attachNote}</div>}
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
          placeholder={unsupported ? 'open a web page first' : 'what should this page do differently? paste or drop an image, or point at elements'}
          disabled={unsupported}
        />
        <div className="row">
          <button className="btn" onClick={() => void pick()} disabled={picking || unsupported || tabId == null} title="Click an element on the page to reference it in your message">
            {picking ? 'click an element…' : 'Point at element'}
          </button>
          <button
            className="btn"
            onClick={() => fileRef.current?.click()}
            disabled={unsupported || images.length >= MAX_IMAGES_PER_MESSAGE}
            title={`Attach a screenshot or mockup (PNG, JPEG, WebP or GIF; up to ${MAX_IMAGES_PER_MESSAGE})`}
          >
            Attach image
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_ATTR}
            multiple
            hidden
            onChange={(e) => {
              void attach(Array.from(e.target.files ?? []));
              // Cleared so picking the same file twice in a row fires onChange the second time.
              e.target.value = '';
            }}
          />
          <button className="btn" onClick={newChat} disabled={unsupported || !host || (!chatId && items.length === 0)}>New chat</button>
          <span className="grow" />
          {busy && <button className="btn danger" onClick={abort}>Stop</button>}
          <button className="btn primary" onClick={() => void send()} disabled={(!text.trim() && !images.length) || unsupported}>{busy ? 'Queue' : 'Send'}</button>
        </div>
      </div>
      {viewing && <Lightbox chatId={chatId} image={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * The dashboard's pending "open this chat" handoff, if there is one. Session storage can be
 * unavailable (it is not exposed to every context and can be cleared), and a missing handoff is the
 * normal case, so a failure here just means "no handoff" and the panel opens as it always did.
 */
async function readHandoff(): Promise<ChatHandoff | null> {
  try {
    const r = await chrome.storage.session.get(HANDOFF_KEY);
    const h = r[HANDOFF_KEY] as Partial<ChatHandoff> | undefined;
    return h && typeof h.chatId === 'string' && typeof h.host === 'string' && typeof h.at === 'number'
      ? { chatId: h.chatId, host: h.host, at: h.at }
      : null;
  } catch {
    return null;
  }
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
