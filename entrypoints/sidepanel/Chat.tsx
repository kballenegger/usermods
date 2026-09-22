import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity } from './Activity';
import { openDashboard } from './App';
import { ArtifactPanel } from './ArtifactPanel';
import { Lightbox, PendingStrip, SentImages, type PendingImage } from './Attachments';
import { Markdown } from './Markdown';
import { ModelPicker, NEXT_TURN_NOTE } from './ModelPicker';
import { useConnections } from './useConnections';
import { carriesFiles, fileFromDataUrlText, filesFromTransfer, processImageFile } from './images';
import { proposalCardLabel, proposalCardState, toSource, type Artifact } from '@/lib/artifact';
import { modsForUrl } from '@/lib/modmatch';
import { ModPicker } from './components/ModPicker';
import { IDLE_ACTIVITY, activityFromEvent, allDisconnected, withActivity, withoutActivity, type ChatActivity } from '@/lib/activity';
import { putBlobs } from '@/lib/blobs';
import { archivedChats, isArchived, liveChats, loadItems, pickChatToShow, relativeTime, saveItems, titleFromText, type Chat as ChatRecord } from '@/lib/chats';
import { ArchiveIcon, ChevronDownIcon, CloseIcon, DashboardIcon, DeleteIcon, EditModIcon, PlusIcon, QueueIcon, RenameIcon, SendIcon, StopIcon, UnarchiveIcon } from './components/icons';
import { MenuButton } from './components/Menu';
import { Sheet, SheetRow } from './components/Sheet';
import { useShell } from './shell';
import { SEND_LABEL, draftPill, foldToolRows, nextSheet, sendMode, stepsSummary, type ChatSheet, type SheetEvent } from '@/lib/compactshell';
import { targetChip } from '@/lib/mobile';
import { mutateConnections, rememberModel, resolveSelection, sameSelection, saveModelChoice, saveThinkingChoice, selectionForChat, thinkingForChat, type ModelSelection } from '@/lib/connections';
import type { ThinkingLevel } from '@/lib/thinking';
import { exportFilename, HANDOFF_KEY, resolveHandoff, type ChatHandoff } from '@/lib/dashboard';
import { ACCEPT_ATTR, MAX_IMAGES_PER_MESSAGE, capNote, emptyTextFor, type AttachedImage, type ImageThumb } from '@/lib/images';
import { rpc, type AgentPortRequest } from '@/lib/rpc';
import { INTERRUPTED_TEXT, RESUME_HINT, RESUME_LABEL, type ResumableRun } from '@/lib/runstate';
import { tombstone } from '@/lib/storagequeue';
import { lastModel, modelRowText, reduceItems, repairRowGap, settleInterrupted, toolDotClass, toolDotState, toolRowTitle, unqueuedItem } from '@/lib/transcript';
import type { AgentEvent, ChatItem, ContentEvent, ElementRef, Mod, ModProposal } from '@/lib/types';

const SAVE_DEBOUNCE_MS = 400;

/** Whether this engine sizes a textarea from its content by itself (Chrome 123+; not every WebKit). */
const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

/**
 * The answer "Keep both" gives to the duplicate question: save a NEW mod, do not ask again.
 *
 * It is a sentinel rather than a second flag on the request because the question has exactly three
 * answers — update that one, update a different one, or make a new one — and one field that can
 * carry all three keeps the background's branch a single lookup instead of two booleans that can
 * contradict each other. The background finds no mod with this id and falls through to creating.
 */
const NEW_MOD = 'new';

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

export function Chat({ tabId, pageUrl, host, onOpenSettings }: { tabId: number | null; pageUrl: string; host: string; onOpenSettings?: () => void }) {
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
   * Chats whose last run stopped short with its progress saved — the model request failed for good,
   * or the run died with the service worker — and can be carried on with Resume. Per chat, like
   * everything else here. The background's run records are the source of truth (lib/runstate.ts):
   * this is filled from 'agent.attach' when the panel opens and kept current by events after that,
   * so the button survives a panel reload and appears for a run that died while the panel was shut.
   */
  const [resumable, setResumable] = useState<ReadonlyMap<string, ResumableRun>>(() => new Map());
  /** The same, readable from async code that outlives a render. Advanced with the state. */
  const resumableRef = useRef<ReadonlyMap<string, ResumableRun>>(resumable);
  /** Chats the background reported as running when we attached, so a row still in flight is not mistaken for a lost one. */
  const liveAtAttachRef = useRef<ReadonlySet<string>>(new Set());
  /** `runningChats`, readable from the port's disconnect handler. */
  const runningRef = useRef<ReadonlySet<string>>(runningChats);
  runningRef.current = runningChats;
  /**
   * Resolves once the background has answered 'agent.attach'. Nothing reads a stored transcript
   * before it: until then the background may still be writing out rows it kept while no panel was
   * open, and a read that beat that write would put a stale transcript on screen and then save it
   * back over the complete one.
   */
  const attachedRef = useRef<Promise<void> | null>(null);
  /**
   * The last message sent in each chat, so Retry on a dead port resends into the chat the failed
   * message belonged to and not into whatever happens to be on screen.
   */
  const lastSentRef = useRef<Map<string, { text: string; refs?: ElementRef[]; images?: AttachedImage[] }>>(new Map());
  /**
   * The visible chat's draft mod, or null when it has none. Per chat, like everything else here: it
   * is re-read on every chat switch and an 'artifact' event is applied only when it belongs to the
   * chat on screen, so a run in another tab cannot swap the draft you are looking at.
   */
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  /** The version the strip has selected. Follows the current version unless the user picks one. */
  const [shownVersion, setShownVersion] = useState<number | null>(null);
  /** What Save/Update last did, shown under the bar for a moment. */
  const [artifactNote, setArtifactNote] = useState('');
  /**
   * Every installed mod, for the empty state's shortcuts and the picker. Read once and refreshed on
   * any write to the mods key, so installing a mod in another tab makes it pickable here without a
   * panel reload.
   */
  const [mods, setMods] = useState<Mod[]>([]);
  /** Open when the user asked to pick a mod to edit. */
  const [pickingMod, setPickingMod] = useState(false);
  /**
   * The save that stopped to ask. An unlinked draft whose name and reach match an installed mod
   * could be a revision of it or a deliberate second mod, and only the user knows which — so the
   * save comes back with the question instead of an answer, and this holds it until they choose.
   */
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  /**
   * The compact shell (the Safari popup on iPhone and iPad). There the chat view keeps only the
   * transcript and a one-row composer on screen; the switcher, the model, the draft and the
   * attachments are each one tap away in a bottom sheet. `sheet` is which one is up, and every
   * change to it goes through nextSheet (lib/compactshell.ts). Always null in the side panel and
   * the Mac popover, which render exactly as they did before any of this existed.
   */
  const shell = useShell();
  const compact = shell.compact;
  const [sheet, setSheet] = useState<ChatSheet | null>(null);
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  /** Which control the model sheet hands focus back to: the chip in the bar, or "+". */
  const modelOpenerRef = useRef<React.RefObject<HTMLButtonElement | null>>(modelChipRef);
  /** The draft title while the switcher is in rename mode, or null when it is a select again. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** The chat the panel is showing, readable from the port listener, which outlives renders. */
  const chatIdRef = useRef<string | null>(null);
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

  // ---- which model this chat talks to (ModelPicker, lib/connections.ts) ----
  const providers = useConnections();
  /** The model picked for a chat that does not exist yet; it travels with the first send. */
  const [pendingModel, setPendingModel] = useState<ModelSelection | null>(null);
  /** The Thinking level picked for a chat that does not exist yet; it travels with the first send. */
  const [pendingThinking, setPendingThinking] = useState<ThinkingLevel | null>(null);
  /** Chats whose model was changed while a run was in flight, until that run's chain ends. */
  const [swappedMidRun, setSwappedMidRun] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The visible chat's selection: its own if it has one, else what a new chat defaults to (the last
   * model picked). Resolved against the connections as they are now, so a provider removed or
   * signed out while this chat was open shows up here as a problem, not as a different provider.
   */
  const chatRecord = chatId ? chats.find((c) => c.id === chatId) : undefined;
  const selection = selectionForChat(chatId ? chatRecord : { model: pendingModel ?? undefined }, providers.state, providers.last, providers.signedIn);
  const modelResolved = resolveSelection(selection, providers.state, providers.signedIn);
  const modelReady = providers.ready && modelResolved.ok;
  const modelReadyRef = useRef(modelReady);
  modelReadyRef.current = modelReady;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /**
   * A swap made while a run is in flight waits for the next turn: the background reads the chat's
   * selection when a run STARTS. Said only when it is true — the run really did start on another
   * model (the transcript's last model row is what it is on) — and only after a mid-run change, so
   * the moment between pressing Send and the run reporting its model never flashes it.
   */
  const runningOn = lastModel(items);
  const swapWaits = busy && chatId != null && swappedMidRun.has(chatId) && !!runningOn && !sameSelection(runningOn, selection);

  /**
   * The visible chat's Thinking level: its own if it has one, else the last level picked — the same
   * rule the model follows, so a new chat starts where the user left off on both counts.
   */
  const thinking = thinkingForChat(chatId ? chatRecord : { thinking: pendingThinking ?? undefined }, providers.lastThinking);

  // Read at send time rather than closed over, for the same reason selectionRef is: the chat is
  // created in a round trip the user can change the level during.
  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;

  function chooseThinking(next: ThinkingLevel) {
    void saveThinkingChoice(next);
    const id = chatIdRef.current;
    if (!id) {
      setPendingThinking(next);
      return;
    }
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, thinking: next } : c)));
    // Same timing as a model swap: the background reads the level when a run STARTS, so changing it
    // mid-run applies to the next turn and the reply in flight keeps the level it began with.
    if (runningRef.current.has(id)) setSwappedMidRun((prev) => new Set(prev).add(id));
    void rpc({ type: 'chats.setThinking', id, thinking: next }).catch(() => {});
  }

  function chooseModel(next: ModelSelection, typed: boolean) {
    void saveModelChoice(next);
    // An id typed by hand is remembered on its connection, so it is offered next time.
    if (typed) void mutateConnections((state) => rememberModel(state, next.connectionId, next.model));
    const id = chatIdRef.current;
    if (!id) {
      setPendingModel(next);
      return;
    }
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, model: next } : c)));
    if (runningRef.current.has(id)) setSwappedMidRun((prev) => new Set(prev).add(id));
    void rpc({ type: 'chats.setModel', id, model: next }).catch(() => {});
  }
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
        const [list, handoff] = await Promise.all([rpc({ type: 'chats.list', host }), readHandoff(), ensureAttached()]);
        if (!live()) return;
        const { chat: show, clearHandoff } = resolveHandoff(handoff, host, list, pickChatToShow(list));
        if (clearHandoff) void chrome.storage.session.remove(HANDOFF_KEY).catch(() => {});
        // Nothing to restore: land on an empty composer.
        if (!show) {
          setChats(list);
          setLoaded(true);
          return;
        }
        const stored = loadRepaired(show.id, await readItems(show.id));
        if (!live()) return;
        setChats(list);
        showChat(show.id, stored);
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

  // Every installed mod, for the empty state's shortcuts and the picker. It follows the storage key
  // rather than being read once, so a mod installed on the Mods tab is offered here immediately.
  useEffect(() => {
    const read = () => rpc({ type: 'mods.list' }).then(setMods).catch(() => {});
    void read();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'mods' in changes) void read();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

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
      // An 'unqueued' for an invisible chat cannot put text back in the composer — that composer
      // belongs to the chat on screen — so the bubble simply goes away.
      const reduced = reduceItems(prev, e);
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
    // Not before the background has handed the transcript over: see attachedRef.
    const started = (attachedRef.current ?? Promise.resolve()).then(() => loadItems(id)).catch(() => [] as ChatItem[]);
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
      if (e.type === 'done') {
        setRunningChats((prev) => withoutChat(prev, e.chatId));
        setSwappedMidRun((prev) => withoutChat(prev, e.chatId));
      }
      else if (e.type !== 'chat_title') setRunningChats((prev) => (prev.has(e.chatId) ? prev : new Set(prev).add(e.chatId)));

      // Whether this chat can be resumed. A failure that kept its progress says so on the event; a
      // run that is demonstrably going again (a fresh status, a message entering the conversation)
      // means whatever stopped short before is no longer the thing to resume.
      if (e.type === 'error' && e.resumable) markResumable(e.chatId, { state: 'failed', error: e.message });
      else if (e.type === 'accepted' || (e.type === 'status' && e.phase !== 'idle')) markResumable(e.chatId, null);

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

      // The draft gained a version. The event carries only the number — the artifact itself is in
      // storage, written by the background before this was posted — so the panel re-reads rather
      // than reconstructing it, and follows the new version unless the user is reading an old one.
      if (e.type === 'artifact') {
        void refreshArtifact(e.chatId);
        setShownVersion(null);
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
      // No "reconnected" note here any more. A run that outlives the panel is recorded by the
      // background while no panel is attached, so an event arriving on this port never follows a
      // stretch nobody kept; the one gap that can still lose rows is found when a transcript is
      // LOADED (loadRepaired), which is the only place there is evidence of it.
      updateItems((prev) => reduceItems(prev, e));
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      // An idle worker going to sleep closes the port too, and that is nothing: the next send or
      // resume opens a new one. It only matters when something was running.
      const hadRuns = runningRef.current.size > 0;
      setRunningChats(new Set());
      if (!hadRuns) return;
      // The worker died under a run. Runs live in its memory, so they died with it — but their
      // conversations are checkpointed after every step, so nothing the user saw is lost. The port
      // is the panel's only link to every chat at once, so EVERY chat that was mid-run is marked
      // disconnected, and then the worker is asked what it knows: waking it makes it mark those
      // runs interrupted, and each chat's line is replaced by its own Resume.
      setActivities(allDisconnected);
      void attachToWorker();
    });
    portRef.current = port;
    return port;
  }

  /** Record (or clear) a chat's resumable state, ref first so async readers never see it stale. */
  function markResumable(id: string, run: ResumableRun | null) {
    const prev = resumableRef.current;
    if (run ? prev.get(id)?.state === run.state && prev.get(id)?.error === run.error : !prev.has(id)) return;
    const next = new Map(prev);
    if (run) next.set(id, run);
    else next.delete(id);
    resumableRef.current = next;
    setResumable(next);
  }

  /**
   * Open the port and ask the background where things stand: which chats are running (and what
   * each is doing), and which can be resumed. This is what makes a panel opened in the middle of a
   * run show that run — Stop, the activity line, Queue instead of Send — rather than a transcript
   * that looks finished until the next message is sent.
   *
   * Never rejects. If the worker cannot be reached the panel simply knows nothing more than it did.
   */
  async function attachToWorker(): Promise<boolean> {
    try {
      connect();
      const state = await rpc({ type: 'agent.attach' });
      const running = new Set(Object.keys(state.running));
      liveAtAttachRef.current = running;
      const nextResumable = new Map(Object.entries(state.resumable));
      resumableRef.current = nextResumable;
      setResumable(nextResumable);
      setRunningChats((prev) => new Set([...prev, ...running]));
      const now = Date.now();
      setActivities((prev) => {
        const next = new Map<string, ChatActivity>();
        // A chat the worker is not running has no line, whatever this panel believed a moment ago:
        // that is how a 'disconnected' line gives way to the Resume row.
        for (const [id, a] of prev) if (running.has(id) && !a.disconnected) next.set(id, a);
        for (const [id, r] of Object.entries(state.running)) {
          if (next.has(id)) continue;
          const base: ChatActivity = { ...IDLE_ACTIVITY, phase: 'model', detail: 'working', startedAt: r.startedAt, lastEventAt: now };
          next.set(id, r.status ? { ...activityFromEvent(base, r.status, now), startedAt: r.startedAt } : base);
        }
        return next;
      });
      // The chat on screen may be one whose run just turned out to be dead: tidy what it left.
      const visible = chatIdRef.current;
      if (visible) updateItems((prev) => settle(visible, prev));
      return true;
    } catch {
      return false;
    }
  }

  /** attachToWorker(), once per panel. Everything that reads a stored transcript waits on this. */
  function ensureAttached(): Promise<void> {
    attachedRef.current ??= attachToWorker().then(() => {});
    return attachedRef.current;
  }

  /**
   * A transcript whose run was INTERRUPTED still claims things are happening: a tool row with no
   * result, a bubble marked queued. settleInterrupted closes the first and removes the second, and
   * the removed text goes back in the composer when that chat is the one on screen (or about to
   * be) — the same thing Stop does with a queued message, for the same reason.
   */
  function settle(id: string, stored: ChatItem[]): ChatItem[] {
    if (resumableRef.current.get(id)?.state !== 'interrupted') return stored;
    const { items: settled, dropped } = settleInterrupted(stored);
    if (dropped.length) {
      const back = dropped.map((d) => d.text).join('\n');
      setDrafts((prev) => {
        const cur = prev.get(id) ?? EMPTY_DRAFT;
        if (cur.text.includes(back)) return prev;
        const next = new Map(prev);
        next.set(id, { ...cur, text: cur.text.trim() ? `${cur.text.trim()}\n${back}` : back });
        return next;
      });
    }
    return settled;
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
    // No usable model: the line under the box already says why and what to do. Nothing is sent, and
    // what was typed stays where it is.
    if (!modelReadyRef.current) return;
    // The chat is created lazily, on the first message that actually goes out.
    let id = chatId;
    if (!id) {
      // Creating it is a round trip, and the user can switch tabs during it. If the panel has moved
      // to another host (or another chat) by the time it lands, filing the message under the new
      // view would be wrong, so the text goes back in the composer for the user to resend.
      const gen = genRef.current;
      try {
        const chat = await rpc({ type: 'chats.create', host, model: selectionRef.current, thinking: thinkingRef.current });
        if (genRef.current !== gen) {
          setText((cur) => (cur.trim() ? cur : typed));
          return;
        }
        id = chat.id;
        setPendingModel(null);
        setPendingThinking(null);
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
    // A new message supersedes whatever stopped short before it: the background starts a fresh
    // run on top of the saved conversation, so there is nothing left to resume.
    markResumable(id, null);
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
   * Carry on a run that failed or was interrupted, from the conversation the background saved.
   *
   * Nothing is added to the transcript and no text is sent: the request is "continue chat X", and
   * the model gets the same conversation it had, tool results included. That is the difference
   * between this and typing the prompt again, which is what the owner was having to do.
   */
  function resume() {
    const id = chatId;
    if (!id || tabId == null || runningChats.has(id)) return;
    markResumable(id, null);
    setRunningChats((prev) => new Set(prev).add(id));
    const at = Date.now();
    setActivities((prev) => withActivity(prev, id, () => ({ phase: 'model', detail: 'resuming', startedAt: at, lastEventAt: at, queued: 0 })));
    titleFixRef.current = true;
    connect().postMessage({ type: 'resume', tabId, chatId: id } satisfies AgentPortRequest);
  }

  /**
   * Retry after the port died and the automatic re-attach did not get through. Ask the worker
   * again first: if the run is still going the line simply comes back, and if it died the chat is
   * now resumable and says so. Only when the worker knows nothing about this chat at all — the
   * message never reached it — is the message sent again, into the chat it belonged to.
   */
  async function retry() {
    const id = chatId;
    if (!id) return;
    const ok = await attachToWorker();
    if (!ok) return;
    if (liveAtAttachRef.current.has(id) || resumableRef.current.has(id)) return;
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
    // The draft belongs to the chat, so it goes with it. It is cleared rather than kept until the
    // new one loads: showing chat A's draft over chat B's transcript, even for one frame, is the
    // same class of mistake as showing A's messages there.
    setArtifact(null);
    setShownVersion(null);
    setArtifactNote('');
    if (id) void refreshArtifact(id);
  }

  /**
   * Re-read a chat's draft from storage. Generation-guarded like every other async read here, so a
   * slow load for the chat you just left cannot land on the one you are now looking at.
   */
  async function refreshArtifact(id: string) {
    const gen = genRef.current;
    try {
      const a = await rpc({ type: 'artifact.get', chatId: id });
      if (genRef.current !== gen || chatIdRef.current !== id) return;
      setArtifact(a);
    } catch {
      /* no draft is the same as a draft we could not read: the panel simply does not appear */
    }
  }

  /**
   * A stored transcript, made truthful before it is shown: an interrupted run's dangling rows are
   * closed (settle), and a transcript that is genuinely missing rows says so, once, in words that
   * claim no more than that (repairRowGap in lib/transcript.ts has the rule and the reasons).
   *
   * "Running" is asked of BOTH what the worker reported at attach and what this panel has seen
   * since. The second half matters: a chat that started running after the panel opened, was
   * switched away from and is now switched back to has a tool row with no result because the tool
   * is running — and the old check, which only knew about the moment of attach, called that lost
   * output. A repaired transcript is written back, so the note is part of the chat from then on
   * rather than something each reload rediscovers.
   */
  function loadRepaired(id: string, raw: ChatItem[]): ChatItem[] {
    const settled = settle(id, raw);
    const repaired = repairRowGap(settled, {
      running: liveAtAttachRef.current.has(id) || runningRef.current.has(id),
      interrupted: resumableRef.current.get(id)?.state === 'interrupted',
    });
    if (repaired !== settled) void saveItems(id, repaired).catch(() => {});
    return repaired;
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
      .then((raw) => {
        if (genRef.current !== gen) return;
        const stored = loadRepaired(id, raw);
        showChat(id, stored);
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

  /**
   * Delete the chat on screen.
   *
   * The ordering here is the panel's half of the resurrection fix (lib/storagequeue.ts holds the
   * background's). Deleting used to `detach()` first, which FLUSHES the pending transcript write
   * for the very chat about to be deleted and leaves an entry in the offscreen write chain for it
   * — so the delete removed 'chat:<id>:items' and then one of those writes put it back. The chat
   * was gone from the index but its transcript was not, and the next thing to touch the index from
   * a snapshot taken before the delete brought the row back to match.
   *
   * So: tombstone first (saveItems in lib/chats drops writes for a tombstoned id, in this context
   * as well as in the background), then drop this chat's pending and offscreen writes outright,
   * and only then leave the chat. Nothing is flushed for a chat that is being deleted — the
   * transcript is about to be removed, so writing it first is pure waste and a chance to lose.
   */
  async function removeChat() {
    if (!chatId) return;
    const current = chats.find((c) => c.id === chatId);
    if (!confirm(`Delete "${current?.title ?? 'this chat'}"?`)) return;
    const doomed = chatId;
    tombstone(doomed);
    const pending = pendingSaveRef.current;
    if (pending?.chatId === doomed) {
      clearTimeout(pending.timer);
      pendingSaveRef.current = null;
    }
    offscreenWritesRef.current.delete(doomed);
    detach();
    offscreenWritesRef.current.delete(doomed); // detach's handOff re-adds it; it must not survive
    await rpc({ type: 'chats.delete', id: doomed });
    const rest = chats.filter((c) => c.id !== doomed);
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
   * Save the draft, which is what the proposal card's Save became.
   *
   * The mod a chat produces is now identified by the artifact's linkedModId, not by matching the
   * proposal's NAME against the installed mods. The old rule guessed: rename a mod in the dashboard
   * — or let the model retype its name with a different capital — and the next save minted a second
   * copy, with both of them running on the page. An id cannot drift, so the second save updates the
   * first save's mod and the count stays at one.
   */
  async function saveArtifact(overwriteModId?: string) {
    if (!chatId || !artifact) return;
    try {
      // NEW_MOD is "Keep both": it answers the duplicate question with "neither of the installed
      // ones", which the background reads as an instruction to go ahead and create. A plain
      // `undefined` could not say that — it is also what an ordinary first Save sends, and the
      // guard would simply ask the same question again.
      const r = await rpc({ type: 'artifact.save', chatId, ...(overwriteModId ? { overwriteModId } : {}) });
      // The save stopped to ask which mod the user meant. Nothing has been written; the panel puts
      // the question on screen and calls back with their answer.
      if ('duplicate' in r) {
        setDuplicate(r.duplicate);
        return;
      }
      setDuplicate(null);
      setArtifact(r.artifact);
      setArtifactNote(
        r.relinked
          ? `The mod this chat saved was deleted, so “${r.mod.name}” was created again.`
          : r.created
            ? `Saved “${r.mod.name}” · enabled`
            : `Updated “${r.mod.name}” in place`,
      );
      // The switcher's "Editing" label comes off the chat index, which the background has just
      // written, so the list is refetched to pick it up.
      void rpc({ type: 'chats.list', host }).then((list) => setChats(list)).catch(() => {});
      // Nothing is stamped on the transcript. Which card reads as saved is derived from the
      // artifact's savedVersion every render — see proposalCardState. Writing a boolean onto the
      // rows instead is what made a LATER proposal inherit an earlier save: the flag said "this
      // chat saved something", the card read it as "this script is installed", and after the model
      // revised the draft those two stopped being the same statement.
    } catch (e) {
      updateItems((prev) => [...prev, { kind: 'error', text: `Could not save the draft: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }

  /**
   * Stop this draft from being an edit of its mod: "Save as a new mod instead".
   *
   * It breaks the link and nothing else. The mod keeps its id, its source, its on/off state and its
   * GM values, and goes on running exactly as it did — detaching is not deleting, and there is no
   * path from this button to a mod disappearing. What changes is only what the NEXT Save does: it
   * creates a separate mod rather than writing over that one.
   */
  async function detachArtifact() {
    if (!chatId || !artifact) return;
    const was = artifact.name;
    try {
      setArtifact(await rpc({ type: 'artifact.detach', chatId }));
      setArtifactNote(`Detached. Saving now creates a new mod; “${was}” is untouched and still installed.`);
      void rpc({ type: 'chats.list', host }).then((list) => setChats(list)).catch(() => {});
    } catch (e) {
      updateItems((prev) => [...prev, { kind: 'error', text: `Could not detach the draft: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }

  /**
   * Bring an installed mod into a chat to edit it — the empty state's shortcuts and the picker.
   *
   * The decision of WHICH chat is the background's (rpc 'mods.edit'), shared with the Mods tab, the
   * dashboard and the open_mod tool, so all five entry points behave identically. All this does is
   * follow it: switch to the chat it names, refresh the list, and say what happened.
   */
  async function editMod(mod: Mod) {
    setPickingMod(false);
    try {
      const r = await rpc({ type: 'mods.edit', modId: mod.id, host, model: selectionRef.current, ...(chatId ? { currentChatId: chatId } : {}) });
      const list = await rpc({ type: 'chats.list', host });
      setChats(list);
      if (r.chatId !== chatIdRef.current) openChat(r.chatId);
      else setArtifact(r.artifact);
      const where = r.reused
        ? `Opened the chat that made “${r.mod.name}”.`
        : r.created
          ? `Started a new chat to edit “${r.mod.name}”. Your other draft is untouched.`
          : `Editing “${r.mod.name}”.`;
      // A mod that does not run here is worth saying out loud: the page tools will look at THIS
      // page, which is not where the mod does its work, and a user who does not know that reads
      // every "I can't find that element" as the product being broken.
      const scope = r.runsHere
        ? ''
        : r.likelyUrl
          ? ` It does not run on this page — tools will inspect the tab you are on. It runs on ${r.likelyUrl}.`
          : ' It does not run on this page — tools will inspect the tab you are on.';
      setArtifactNote(`${where}${scope}`);
    } catch (e) {
      updateItems((prev) => [...prev, { kind: 'error', text: `Could not open that mod: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }

  /** Run the draft's current version once, the way Try on a proposal card always has. */
  async function tryArtifact() {
    if (!artifact) return;
    const v = artifact.versions.find((x) => x.n === artifact.current);
    if (v) await tryProposal({ name: v.name, description: v.description, matches: v.matches, code: v.code });
  }

  /** Download the current version as a .user.js, header and all. */
  function exportArtifact() {
    if (!artifact) return;
    const blob = new Blob([toSource(artifact)], { type: 'text/javascript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFilename(artifact.name);
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function renameArtifact(name: string) {
    if (!chatId) return;
    try {
      setArtifact(await rpc({ type: 'artifact.rename', chatId, name }));
      setShownVersion(null);
    } catch (e) {
      updateItems((prev) => [...prev, { kind: 'error', text: `Could not rename the draft: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }

  /**
   * Roll the draft back. The version is APPENDED, not restored over the top (lib/artifact.ts), so
   * the versions after it are still there and the rollback is itself undoable.
   */
  async function rollbackArtifact(version: number) {
    if (!chatId) return;
    try {
      setArtifact(await rpc({ type: 'artifact.rollback', chatId, version }));
      setShownVersion(null);
      setArtifactNote(`Rolled back to v${version}, kept as a new version.`);
    } catch (e) {
      updateItems((prev) => [...prev, { kind: 'error', text: `Could not roll back: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }

  // ---- the compact shell's sheets (iPhone, iPad); inert everywhere else ----

  function sheetDo(event: SheetEvent) {
    setSheet((cur) => nextSheet(cur, event, { hasDraft: !!artifact }));
  }
  const closeSheet = () => sheetDo({ type: 'close' });

  // A sheet about "this chat" must not outlive the chat it was opened on, the draft sheet must not
  // outlive its draft, and the save that stopped to ask takes over from whatever was up.
  useEffect(() => {
    setSheet((cur) => nextSheet(cur, { type: 'chat-changed' }, { hasDraft: true }));
  }, [chatId]);
  useEffect(() => {
    if (!artifact) setSheet((cur) => (cur === 'draft' ? null : cur));
  }, [artifact]);
  useEffect(() => {
    if (duplicate) setSheet(null);
  }, [duplicate]);
  // The rename form lives inside the chat sheet in this shell, so however that sheet goes away
  // (closed, replaced, the chat changing under it) an unfinished rename goes with it. Outside the
  // compact shell `sheet` never changes and this never fires.
  useEffect(() => {
    if (compact && sheet !== 'chat') setRenaming(null);
  }, [compact, sheet]);

  /**
   * Grow the message box with its text where CSS cannot. `field-sizing: content` does this on
   * Chrome (styles.css); the Safari versions this ships to do not all have it, and the box starts
   * at ONE line everywhere now, so without this a second sentence would scroll out of sight inside
   * a one-line slot. The compact shell always sizes by hand (mobile.css pins `field-sizing:
   * fixed`); the Mac popover does so only when the engine lacks the property. The cap is the
   * stylesheet's max-height, and past it the text scrolls inside the box.
   */
  useLayoutEffect(() => {
    if (!compact && FIELD_SIZING) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves the borders out and the box is border-box, so they are added back.
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, [compact, text, chatId, loaded]);

  /**
   * Which transcript rows fold into an "N steps" line on a phone: the first row of each folded run
   * maps to the whole run, the rest of the run to 'folded' (drawn inside the first). Empty outside
   * the compact shell, where every tool row is drawn as it always has been.
   */
  const folds = useMemo(() => {
    const map = new Map<number, number[] | 'folded'>();
    if (!compact) return map;
    for (const block of foldToolRows(items)) {
      if (block.kind !== 'steps') continue;
      block.indices.forEach((index, k) => map.set(index, k === 0 ? block.indices : 'folded'));
    }
    return map;
  }, [compact, items]);

  const unsupported = !pageUrl || /^(chrome|edge|about|chrome-extension|devtools):/.test(pageUrl);
  /**
   * The installed mods that run on the page in front of the user, for the empty state's shortcuts.
   * The same function the model's prompt block uses (lib/modmatch modsForUrl), so what the user is
   * offered and what the model is told about are the same list by construction.
   */
  const modsHere = mods.filter((m) => modsForUrl([m], pageUrl).length > 0);
  /**
   * The name of the mod this chat is editing, or ''. Resolved from the live mod list rather than
   * remembered, so a mod renamed on the Mods tab is named correctly here, and a mod that has since
   * been DELETED resolves to nothing — which is right: the chat is no longer editing anything that
   * exists, and claiming otherwise would be the panel lying about what Save is going to do.
   */
  const editingModName = artifact?.linkedModId ? (mods.find((m) => m.id === artifact.linkedModId)?.name ?? '') : '';
  const live = liveChats(chats);
  const archived = archivedChats(chats);
  const current = chatId ? chats.find((c) => c.id === chatId) : undefined;
  const viewingArchived = !!current && isArchived(current);
  /** The visible chat's stopped-short run, if it has one and is not already going again. */
  const resumeState = chatId && !busy ? resumable.get(chatId) : undefined;
  const lastIsError = items[items.length - 1]?.kind === 'error';
  // The compact shell's derived values. Cheap, and unused outside it.
  const pill = compact && artifact ? draftPill(artifact, editingModName) : null;
  const mode = sendMode({ busy, hasContent: !!text.trim() || images.length > 0 });
  const site = targetChip(pageUrl);
  function openModelSheet(opener: React.RefObject<HTMLButtonElement | null>) {
    modelOpenerRef.current = opener;
    sheetDo({ type: 'open', sheet: 'model' });
  }
  /**
   * The Resume affordance. It belongs to the error it follows, so it renders INSIDE the last error
   * row when there is one (the error text stays exactly where it was, above the button), and as a
   * row of its own when the run was interrupted and there is no error to attach it to.
   */
  const resumeBlock = resumeState ? (
    <div className="resume" data-testid="resume" data-resume-state={resumeState.state}>
      <span className="resume-hint">{RESUME_HINT}</span>
      <button className="btn primary" data-action="resume" onClick={resume} disabled={tabId == null || unsupported}>
        {RESUME_LABEL}
      </button>
    </div>
  ) : null;

  return (
    <div className="chat">
      {/* The chat bar: the switcher, the model, and what you do to this chat. It is on screen
          whenever there is a page to act on — not only once a chat exists — because the model
          chip lives here and a chat with no model yet is exactly the one that needs it. */}
      {!compact && !unsupported && host && (
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
                <option key={c.id} value={c.id} title={chatOptionTitle(c)}>
                  {chatOptionLabel(c)}
                </option>
              ))}
              {archived.length > 0 && (
                <optgroup label="Archived">
                  {archived.map((c) => (
                    <option key={c.id} value={c.id} title={chatOptionTitle(c)}>
                      {chatOptionLabel(c)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          {/* Which model this chat talks to, and how hard it thinks, as one chip that opens the
              picker over the transcript. It is in this bar rather than in the composer because the
              model is a property of the chat, not of the message being typed, and because it is
              changed rarely: the composer is looked at all the time and is kept to one row. While
              a rename is in progress the bar is the field and Save, nothing else. */}
          {renaming === null && providers.ready && (
            <ModelPicker
              state={providers.state}
              signedIn={providers.signedIn}
              selection={selection}
              resolved={modelResolved}
              onSelect={chooseModel}
              onManage={() => onOpenSettings?.()}
              thinking={thinking}
              onThinking={chooseThinking}
            />
          )}
          {/* Editing a mod is a first-class way to start, so it sits with the chat's own actions
              rather than behind the Mods tab. It is enabled whether or not this chat has anything
              in it: picking a mod from a chat that is mid-draft opens a NEW chat for it (the
              background's editModPlan decides), so this can never cost the user their work. */}
          {renaming === null && (
            <button
              className="btn action"
              data-action="edit-mod"
              onClick={() => setPickingMod((v) => !v)}
              aria-expanded={pickingMod}
              aria-label="Edit a mod"
              title="Open one of your installed mods in a chat and keep building on it"
              data-testid="edit-a-mod"
            >
              <EditModIcon />
              <span className="action-label">Edit a mod</span>
            </button>
          )}
          {renaming !== null ? (
            // Mousedown, not click: the input's blur would close rename mode before a click landed.
            <button className="btn primary" data-action="save-name" onMouseDown={(e) => e.preventDefault()} onClick={() => void commitRename()} title="Save this name">Save</button>
          ) : (
            <button
              className="btn action"
              data-action="rename"
              onClick={startRename}
              disabled={!chatId}
              aria-label="Rename"
              title="Give this chat your own name. It will not be renamed automatically afterwards."
            >
              <RenameIcon />
              <span className="action-label">Rename</span>
            </button>
          )}
          {renaming !== null ? null : viewingArchived ? (
            <>
              <button
                className="btn action"
                data-action="unarchive"
                onClick={() => void setArchived(chatId!, false)}
                aria-label="Unarchive"
                title="Move this chat back to the main list"
              >
                <UnarchiveIcon />
                <span className="action-label">Unarchive</span>
              </button>
              <button
                className="btn action danger"
                data-action="delete"
                onClick={() => void removeChat()}
                aria-label="Delete"
                title="Delete this chat for good"
              >
                <DeleteIcon />
                <span className="action-label">Delete</span>
              </button>
            </>
          ) : (
            // Archive is reversible, so it stays a secondary button; coral is kept for Delete.
            <button
              className="btn action"
              data-action="archive"
              onClick={() => void setArchived(chatId!, true)}
              disabled={!chatId}
              aria-label="Archive"
              title="Archive this chat: it moves to the Archived group and stops opening by default"
            >
              <ArchiveIcon />
              <span className="action-label">Archive</span>
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
        {/* The mods already running on this page, offered as one tap each.
            This is the empty state doing the job the owner's report was about: the answer to "how
            do I keep adding to a mod" should be on screen before you type anything, not something
            you have to know to ask for. With nothing installed here it renders nothing at all, so
            a first-run panel is exactly as it was. */}
        {loaded && items.length === 0 && !unsupported && modsHere.length > 0 && (
          <div className="empty-mods" data-testid="empty-mods">
            <div className="label">or keep building on a mod that runs here</div>
            {modsHere.map((m) => (
              <button
                key={m.id}
                className="btn"
                onClick={() => void editMod(m)}
                title={`Open “${m.name}” in this chat and keep building on it`}
                data-testid="empty-mod"
                data-mod-id={m.id}
              >
                Edit {m.name}
              </button>
            ))}
          </div>
        )}
        {items.map((it, i) => {
          // A phone folds a long run of tool rows into one line (see `folds` above).
          const fold = folds.get(i);
          if (fold === 'folded') return null;
          if (fold) return <StepsRow key={i} tools={fold.map((n) => items[n]).filter((t): t is ToolItem => t?.kind === 'tool')} />;
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
              // Markdown, not plain text: every model writes it whether or not it was asked to, so
              // rendering verbatim showed `**bold**` with its asterisks. `streaming` is true only
              // for the row still being written into — the last one, while this chat is busy — so
              // an unterminated ** or ``` renders as what it is about to become instead of
              // flickering between a paragraph and a code block on every delta. See Markdown.tsx.
              return <div key={i} className="msg assistant"><Markdown text={it.text} streaming={busy && i === items.length - 1} /></div>;
            case 'note':
              return <div key={i} className="label" style={{ textAlign: 'center' }}>{it.text}</div>;
            case 'model': {
              // Where the model changed. The first one is where the chat started, which the
              // composer already says, so it draws nothing (modelRowText returns null for it).
              const label = modelRowText(items, i);
              return label ? (
                <div key={i} className="model-marker" data-testid="model-marker">
                  <span>{label}</span>
                </div>
              ) : null;
            }
            case 'tool':
              // The dot carries the state the glyphs used to: volt when it came back clean, amber
              // while it is still running, coral when it failed. Only volt glows.
              return <ToolRow key={i} item={it} />;
            case 'proposal': {
              // The hero of this screen: the one card that takes the glow.
              //
              // What changed when drafts arrived is what the card MEANS. It used to be the live
              // thing — the only place the script existed, with the buttons that acted on it. Now
              // the draft panel below is the live thing and this is the moment it changed: the card
              // says which version it became, and its button takes you there rather than acting on
              // its own frozen copy. That is what stops the transcript and the panel disagreeing
              // about what "the mod" is after four proposals.
              const version = it.version;
              // Saved-ness is a fact about the DRAFT, read fresh every render, never a flag left on
              // the row. A card is 'saved' only while the mod holds this very version; the moment
              // the model proposes a revision, the new card reads 'update' and the old one stops
              // claiming to be what is installed.
              const cardState = proposalCardState(artifact, version);
              return (
                <div key={i} className="card hero" data-testid="proposal-card" data-card-state={cardState}>
                  <div>
                    <div className="label">
                      proposed mod{version ? <span className="card-version" data-testid="card-version"> · v{version}</span> : null}
                      {cardState === 'saved' ? <span className="card-saved" data-testid="card-saved"> · saved</span> : null}
                    </div>
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
                    {/* Save is on the card again, and it is the SAME save the draft panel offers:
                        it writes the current draft over the mod this chat is linked to. A revised
                        proposal is a new version of one mod, not a second mod, so the button says
                        "update" rather than minting a copy — and it is disabled only once the mod
                        really does hold this version. */}
                    <button
                      className="btn primary"
                      onClick={() => void saveArtifact()}
                      disabled={cardState === 'saved' || cardState === 'none'}
                      title={
                        cardState === 'saved'
                          ? 'This version is the mod that is installed'
                          : cardState === 'update'
                            ? 'Write the current draft over the mod this chat created'
                            : 'Save this draft as a mod and enable it'
                      }
                      data-testid="card-save"
                    >
                      {proposalCardLabel(cardState)}
                    </button>
                    {version && artifact && !compact ? (
                      <button
                        className="linklike"
                        onClick={() => setShownVersion(version)}
                        title="Select this version in the draft panel below"
                        data-testid="card-open-in-draft"
                      >
                        Open in draft
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            }
            case 'error':
              return (
                <div key={i} className="error">
                  {it.text}
                  {i === items.length - 1 && resumeBlock}
                </div>
              );
          }
        })}
        {resumeState && !lastIsError && (
          <div className="error" data-testid="resume-row">
            {resumeState.state === 'interrupted' ? INTERRUPTED_TEXT : (resumeState.error ?? 'The run stopped before it finished.')}
            {resumeBlock}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {pickingMod && !compact && <ModPicker mods={mods} pageUrl={pageUrl} onPick={(m) => void editMod(m)} onCancel={() => setPickingMod(false)} />}
      {/* The save that stopped to ask. Neither button is destructive and neither is the default:
          updating rewrites a mod the user may not have meant, keeping both leaves two mods running
          on the same page, and only they know which they wanted. */}
      {duplicate && !compact && (
        <div className="artifact-dupe" data-testid="artifact-duplicate">
          <div>
            “{duplicate.name}” is already installed with the same name and the same match patterns. Update it, or keep both?
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void saveArtifact(duplicate.id)} data-testid="artifact-duplicate-update">
              Update the existing mod
            </button>
            <button className="btn" onClick={() => void saveArtifact(NEW_MOD)} data-testid="artifact-duplicate-keep">
              Keep both
            </button>
            <button className="linklike" onClick={() => setDuplicate(null)} data-testid="artifact-duplicate-cancel">
              Cancel
            </button>
          </div>
        </div>
      )}
      {/* The draft, pinned. It is a row of the chat column — not an item in the transcript — so it
          appears and disappears without moving the messages or their scroll position, exactly as
          the activity line does. */}
      {artifact && chatId && !compact && (
        <ArtifactPanel
          artifact={artifact}
          busy={busy}
          canTry={tabId != null}
          selected={shownVersion ?? artifact.current}
          onSelect={setShownVersion}
          onTry={tryArtifact}
          onSave={() => saveArtifact()}
          onDetach={detachArtifact}
          onExport={exportArtifact}
          onRename={renameArtifact}
          onRollback={rollbackArtifact}
          editingModName={editingModName}
          openDashboard={() => void openDashboard()}
        />
      )}
      {/* The same draft on a phone: one line, and only when there is a draft. The name, the
          version and what it is (editing an installed mod, saved, a draft) open the full panel in
          a sheet; the one thing you do to a draft most, saving it, is on the line itself. */}
      {compact && artifact && chatId && pill && (
        <div className="draft-pill" data-testid="draft-pill" data-status={pill.status}>
          <button
            ref={pillRef}
            type="button"
            className="draft-pill-open"
            data-action="draft-sheet"
            aria-haspopup="dialog"
            aria-expanded={sheet === 'draft'}
            aria-label={pill.label}
            onClick={() => sheetDo({ type: 'open', sheet: 'draft' })}
          >
            <span className="draft-pill-name">{pill.name}</span>
            <span className="draft-pill-sep" aria-hidden="true">·</span>
            <span className="draft-pill-v">{pill.version}</span>
            <span className="draft-pill-sep" aria-hidden="true">·</span>
            <span className="draft-pill-status">{pill.status}</span>
            <ChevronDownIcon />
          </button>
          <button
            type="button"
            className="btn primary draft-pill-save"
            data-testid="draft-pill-save"
            onClick={() => void saveArtifact()}
            disabled={busy || pill.upToDate}
            aria-label={
              pill.upToDate
                ? 'Saved: the mod holds this version'
                : editingModName
                  ? `Update the installed mod “${editingModName}” with this draft`
                  : pill.action === 'Update'
                    ? 'Update the mod this chat created with this draft'
                    : 'Save this draft as a mod and enable it'
            }
          >
            {pill.upToDate ? 'Saved' : pill.action}
          </button>
        </div>
      )}
      {artifact && artifactNote && (
        <div className="artifact-status" data-testid="artifact-status">
          {artifactNote}
          {/* On a phone this line costs transcript, and it only ever reports something that has
              already happened, so it can be sent away. */}
          {compact && (
            <button type="button" className="note-x" onClick={() => setArtifactNote('')} aria-label="Dismiss this note">
              <CloseIcon />
            </button>
          )}
        </div>
      )}
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
        retry={activity.retry}
        onStop={abort}
        onRetry={() => void retry()}
        stopAlways
      />
      {/* The phone's composer: one row. "+" on the left holds everything that is not typing
          (point at an element, attach an image, the model, a new chat), the message box grows
          with its text, and the one button on the right is Send, Queue or Stop by turns
          (sendMode in lib/compactshell.ts). Chips appear above the row only when there are any. */}
      {compact && (
        <div className={`composer compact${dragging ? ' dragging' : ''}`} onPaste={onPaste} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setDragging(false)}>
          {swapWaits && (
            <div className="compact-note" data-testid="model-note" role="status">
              {NEXT_TURN_NOTE}
            </div>
          )}
          {providers.ready && !modelResolved.ok && (
            <button type="button" className="compact-note problem" data-testid="model-problem" onClick={() => openModelSheet(addBtnRef)}>
              {modelResolved.message} <span className="compact-note-act">Choose a model</span>
            </button>
          )}
          {(refs.length > 0 || images.length > 0) && (
            <div className="row">
              {refs.map((r) => (
                <span key={r.token} className="chip ref" title={r.selector}>
                  @{r.token} · {r.label}{' '}
                  <button className="chip-x" onClick={() => removeRef(r.token)} aria-label={`Remove the reference @${r.token}`}>×</button>
                </span>
              ))}
              <PendingStrip images={images} onRemove={removeImage} />
            </div>
          )}
          {attachNote && (
            <div className="attach-note">
              {attachNote}
              <button type="button" className="note-x" onClick={() => setAttachNote(null)} aria-label="Dismiss this note">
                <CloseIcon />
              </button>
            </div>
          )}
          <div className="composer-row">
            <button
              ref={addBtnRef}
              type="button"
              className="cbtn"
              data-action="add"
              aria-haspopup="dialog"
              aria-expanded={sheet === 'add'}
              aria-label="Add: point at an element, attach an image, change the model, new chat"
              onClick={() => sheetDo({ type: 'open', sheet: 'add' })}
            >
              <PlusIcon />
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              enterKeyHint="send"
              aria-label="Message"
              placeholder={unsupported ? 'Open a web page first' : picking ? 'Tap an element on the page…' : 'What should this page do?'}
              disabled={unsupported}
            />
            <button
              type="button"
              className={`cbtn send ${mode}`}
              data-action="send"
              data-mode={mode}
              aria-label={SEND_LABEL[mode]}
              title={mode !== 'stop' && !modelReady && providers.ready && !modelResolved.ok ? modelResolved.message : undefined}
              onClick={() => (mode === 'stop' ? abort() : void send())}
              disabled={mode === 'stop' ? false : (!text.trim() && !images.length) || unsupported || !modelReady}
            >
              {mode === 'stop' ? <StopIcon /> : mode === 'queue' ? <QueueIcon /> : <SendIcon />}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_ATTR}
            multiple
            hidden
            onChange={(e) => {
              void attach(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      )}
      {/* The panel's and the Mac popover's composer: one row, like the phone's, adapted to a
          pointer. "+" on the left is a menu of the things you do to a message now and then (point
          at an element, attach an image, a new chat), the message box starts at one line and grows
          with its text, and the one button on the right is Send, Queue or Stop by turns (sendMode
          in lib/compactshell.ts) — Stop stays on the activity line for the whole run, so typing
          never puts it out of reach. Chips appear above the row only when there are any, and the
          two things about the model that cannot wait for the picker (a swap that waits for the
          next turn, a chat with no usable model) are one line above the row, not a row of chrome
          every chat carries. The model itself is the chip in the chat bar. */}
      {!compact && (
        <div className={`composer${dragging ? ' dragging' : ''}`} onPaste={onPaste} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setDragging(false)}>
          {providers.ready && !modelResolved.ok ? (
            <div className="model-note composer-note problem" data-testid="model-note" role="alert">
              {modelResolved.message}
            </div>
          ) : providers.ready && swapWaits ? (
            <div className="model-note composer-note" data-testid="model-note" role="status">
              {NEXT_TURN_NOTE}
            </div>
          ) : null}
          {(refs.length > 0 || images.length > 0) && (
            <div className="row">
              {refs.map((r) => (
                <span key={r.token} className="chip ref" title={r.selector}>
                  @{r.token} · {r.label}{' '}
                  <button className="chip-x" onClick={() => removeRef(r.token)} title="Remove reference" aria-label={`Remove the reference @${r.token}`}>×</button>
                </span>
              ))}
              <PendingStrip images={images} onRemove={removeImage} />
            </div>
          )}
          {attachNote && <div className="attach-note">{attachNote}</div>}
          <div className="composer-row">
            <MenuButton
              className="cbtn add"
              testId="composer-add"
              action="add"
              label="Add: point at an element, attach an image, or start a new chat"
              title="Point at an element, attach an image, or start a new chat"
              menuLabel="Add"
              icon={<PlusIcon />}
              disabled={unsupported}
              items={[
                {
                  id: 'point',
                  label: picking ? 'Click an element on the page…' : 'Point at element',
                  title: 'Click an element on the page to reference it in your message',
                  disabled: picking || unsupported || tabId == null,
                  onSelect: () => void pick(),
                  testId: 'menu-point',
                },
                {
                  id: 'attach',
                  label: 'Attach image',
                  title: `Attach a screenshot or mockup (PNG, JPEG, WebP or GIF; up to ${MAX_IMAGES_PER_MESSAGE}). Pasting or dropping one works too`,
                  disabled: unsupported || images.length >= MAX_IMAGES_PER_MESSAGE,
                  onSelect: () => fileRef.current?.click(),
                  testId: 'menu-attach',
                },
                {
                  id: 'new-chat',
                  label: 'New chat',
                  title: 'Start a fresh chat on this site. This one stays in the switcher',
                  disabled: unsupported || !host || (!chatId && items.length === 0),
                  onSelect: newChat,
                  testId: 'menu-new-chat',
                },
              ]}
            />
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              aria-label="Message"
              placeholder={unsupported ? 'Open a web page first' : picking ? 'Click an element on the page…' : 'What should this page do differently?'}
              disabled={unsupported}
            />
            <button
              type="button"
              className={`cbtn send ${mode}`}
              data-action="send"
              data-mode={mode}
              aria-label={SEND_LABEL[mode]}
              title={
                mode !== 'stop' && !modelReady && providers.ready && !modelResolved.ok
                  ? modelResolved.message
                  : mode === 'stop'
                    ? 'Stop this run'
                    : mode === 'queue'
                      ? 'Queue: it goes to the model between its steps (Enter)'
                      : 'Send (Enter; Shift+Enter for a new line)'
              }
              onClick={() => (mode === 'stop' ? abort() : void send())}
              disabled={mode === 'stop' ? false : (!text.trim() && !images.length) || unsupported || !modelReady}
            >
              {mode === 'stop' ? <StopIcon /> : mode === 'queue' ? <QueueIcon /> : <SendIcon />}
              {/* The word beside the mark, shown only where the composer is wide enough for it
                  (the same container-query convention the tab bar uses for its labels). */}
              <span className="cbtn-label">{mode === 'stop' ? 'Stop' : mode === 'queue' ? 'Queue' : 'Send'}</span>
            </button>
          </div>
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
        </div>
      )}
      {/* ---- the compact shell: what the chat puts in the top bar, and its sheets ---- */}
      {compact && shell.barSlot && !unsupported &&
        createPortal(
          <>
            <button
              ref={titleBtnRef}
              type="button"
              className="cbar-chat"
              data-action="chat-sheet"
              aria-haspopup="dialog"
              aria-expanded={sheet === 'chat'}
              aria-label={`${current?.title ?? 'New chat'}, on ${site.live ? site.host : site.fallback}. Chats and chat actions`}
              title={pageUrl}
              onClick={() => sheetDo({ type: 'open', sheet: 'chat' })}
            >
              <span className="cbar-chat-site">
                {site.live && <span className="dot" aria-hidden="true" />}
                <span className="cbar-host">{site.live ? site.host : site.fallback}</span>
              </span>
              <span className="cbar-chat-title">
                <span className="cbar-chat-name">{current?.title ?? 'New chat'}</span>
                <ChevronDownIcon />
              </span>
            </button>
            {providers.ready && (
              <button
                ref={modelChipRef}
                type="button"
                className={`cbar-model${modelResolved.ok ? '' : ' unset'}`}
                data-action="model-chip"
                data-testid="model-chip"
                aria-haspopup="dialog"
                aria-expanded={sheet === 'model'}
                aria-label={
                  modelResolved.ok
                    ? `Model: ${modelResolved.selection.model}, on ${modelResolved.selection.label ?? 'a provider'}${thinking === 'default' ? '' : `, thinking ${thinking}`}. Change model`
                    : 'No model chosen. Choose a model'
                }
                onClick={() => openModelSheet(modelChipRef)}
              >
                <span className="cbar-model-name">{modelResolved.ok ? modelResolved.selection.model : 'No model'}</span>
                {/* The level rides on the chip only when it is NOT the default: on a phone the bar
                    is the whole of the composer's chrome, so a suffix every chat carries would cost
                    the model id room it needs more. */}
                {modelResolved.ok && thinking !== 'default' && (
                  <span className="cbar-model-thinking" data-testid="model-chip-thinking">
                    {thinking}
                  </span>
                )}
              </button>
            )}
          </>,
          shell.barSlot,
        )}
      {compact && sheet === 'chat' && (
        <Sheet
          title={renaming !== null ? 'Rename chat' : 'Chats'}
          onClose={() => {
            setRenaming(null);
            closeSheet();
          }}
          returnFocus={titleBtnRef}
          testId="sheet-chat"
        >
          {renaming !== null ? (
            <form
              className="sheet-form"
              onSubmit={(e) => {
                e.preventDefault();
                void commitRename();
                closeSheet();
              }}
            >
              <input ref={renameRef} value={renaming} onChange={(e) => setRenaming(e.target.value)} placeholder="Name this chat" aria-label="Chat name" enterKeyHint="done" />
              <div className="row">
                <button type="submit" className="btn primary" data-action="save-name" disabled={!renaming.trim()}>
                  Save
                </button>
                <button type="button" className="btn" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="sheet-list">
                <SheetRow
                  label="New chat"
                  icon={<PlusIcon />}
                  action="new-chat"
                  disabled={!host || (!chatId && items.length === 0)}
                  onClick={() => {
                    closeSheet();
                    newChat();
                  }}
                />
              </div>
              {chats.length > 0 && (
                <div className="sheet-list" role="group" aria-label={`Chats on ${host}`}>
                  <div className="sheet-label">Chats on {host}</div>
                  {live.map((c) => (
                    <SheetRow key={c.id} label={chatRowLabel(c)} value={relativeTime(c.updatedAt)} current={c.id === chatId} testId="chat-row" onClick={() => (c.id === chatId ? closeSheet() : switchTo(c.id))} />
                  ))}
                  {archived.length > 0 && <div className="sheet-label">Archived</div>}
                  {archived.map((c) => (
                    <SheetRow key={c.id} label={chatRowLabel(c)} value={relativeTime(c.updatedAt)} current={c.id === chatId} testId="chat-row" onClick={() => (c.id === chatId ? closeSheet() : switchTo(c.id))} />
                  ))}
                </div>
              )}
              {chatId && (
                <div className="sheet-list" role="group" aria-label="This chat">
                  <div className="sheet-label">This chat</div>
                  <SheetRow label="Rename" icon={<RenameIcon />} action="rename" onClick={startRename} />
                  {viewingArchived ? (
                    <>
                      <SheetRow
                        label="Unarchive"
                        icon={<UnarchiveIcon />}
                        action="unarchive"
                        onClick={() => {
                          closeSheet();
                          void setArchived(chatId, false);
                        }}
                      />
                      <SheetRow
                        label="Delete"
                        icon={<DeleteIcon />}
                        action="delete"
                        danger
                        onClick={() => {
                          closeSheet();
                          void removeChat();
                        }}
                      />
                    </>
                  ) : (
                    <SheetRow
                      label="Archive"
                      icon={<ArchiveIcon />}
                      action="archive"
                      onClick={() => {
                        closeSheet();
                        void setArchived(chatId, true);
                      }}
                    />
                  )}
                </div>
              )}
              <div className="sheet-list">
                <SheetRow label="Edit a mod…" icon={<EditModIcon />} action="edit-mod" testId="edit-a-mod" onClick={() => sheetDo({ type: 'open', sheet: 'editmod' })} />
                <SheetRow
                  label="Open dashboard"
                  icon={<DashboardIcon />}
                  action="dashboard"
                  onClick={() => {
                    closeSheet();
                    void openDashboard();
                  }}
                />
              </div>
            </>
          )}
        </Sheet>
      )}
      {compact && sheet === 'editmod' && (
        <Sheet title="Edit a mod" onClose={closeSheet} returnFocus={titleBtnRef} testId="sheet-editmod">
          <ModPicker
            mods={mods}
            pageUrl={pageUrl}
            onPick={(m) => {
              closeSheet();
              void editMod(m);
            }}
            onCancel={closeSheet}
          />
        </Sheet>
      )}
      {compact && sheet === 'add' && (
        <Sheet title="Add" onClose={closeSheet} returnFocus={addBtnRef} testId="sheet-add">
          <div className="sheet-list">
            <SheetRow
              label={picking ? 'Tap an element on the page…' : 'Point at element'}
              action="pick"
              disabled={picking || unsupported || tabId == null}
              title="Pick an element on the page to reference it in your message"
              onClick={() => {
                closeSheet();
                void pick();
              }}
            />
            <SheetRow
              label="Attach image"
              value={images.length ? `${images.length} of ${MAX_IMAGES_PER_MESSAGE}` : 'PNG, JPEG, WebP, GIF'}
              action="attach"
              disabled={unsupported || images.length >= MAX_IMAGES_PER_MESSAGE}
              onClick={() => {
                // The file input first: it has to be opened inside the tap that asked for it.
                fileRef.current?.click();
                closeSheet();
              }}
            />
            {providers.ready && (
              <SheetRow
                label="Model"
                value={modelResolved.ok ? `${modelResolved.selection.model}${modelResolved.selection.label ? ` · ${modelResolved.selection.label}` : ''}` : 'Choose a model'}
                action="model"
                onClick={() => openModelSheet(addBtnRef)}
              />
            )}
            <SheetRow
              label="New chat"
              action="new-chat"
              disabled={unsupported || !host || (!chatId && items.length === 0)}
              onClick={() => {
                closeSheet();
                newChat();
              }}
            />
          </div>
        </Sheet>
      )}
      {compact && sheet === 'model' && providers.ready && (
        <Sheet title="Model" onClose={closeSheet} returnFocus={modelOpenerRef.current} testId="sheet-model">
          <ModelPicker
            inline
            state={providers.state}
            signedIn={providers.signedIn}
            selection={selection}
            resolved={modelResolved}
            note={swapWaits ? NEXT_TURN_NOTE : undefined}
            onSelect={chooseModel}
            onManage={() => onOpenSettings?.()}
            thinking={thinking}
            onThinking={chooseThinking}
            onDone={closeSheet}
          />
        </Sheet>
      )}
      {compact && sheet === 'draft' && artifact && chatId && (
        <Sheet title="Draft" onClose={closeSheet} returnFocus={pillRef} testId="sheet-draft">
          <ArtifactPanel
            expanded
            artifact={artifact}
            busy={busy}
            canTry={tabId != null}
            selected={shownVersion ?? artifact.current}
            onSelect={setShownVersion}
            onTry={tryArtifact}
            onSave={() => saveArtifact()}
            onDetach={detachArtifact}
            onExport={exportArtifact}
            onRename={renameArtifact}
            onRollback={rollbackArtifact}
            editingModName={editingModName}
            openDashboard={() => void openDashboard()}
          />
        </Sheet>
      )}
      {compact && duplicate && (
        <Sheet title="Already installed" onClose={() => setDuplicate(null)} returnFocus={pillRef} testId="sheet-duplicate">
          <div className="sheet-text" data-testid="artifact-duplicate">
            “{duplicate.name}” is already installed with the same name and the same match patterns. Update it, or keep both?
          </div>
          <div className="sheet-list">
            <SheetRow label="Update the existing mod" testId="artifact-duplicate-update" onClick={() => void saveArtifact(duplicate.id)} />
            <SheetRow label="Keep both" testId="artifact-duplicate-keep" onClick={() => void saveArtifact(NEW_MOD)} />
            <SheetRow label="Cancel" testId="artifact-duplicate-cancel" onClick={() => setDuplicate(null)} />
          </div>
        </Sheet>
      )}
      {viewing && <Lightbox chatId={chatId} image={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * How a chat reads in the switcher.
 *
 * A chat that is editing an installed mod says so, because that is the most important thing about
 * it: sending a message there changes a script that is already running on the user's pages. A
 * <select> can carry no markup, so the badge is a text marker rather than a chip — which is also
 * why it is a pencil and a name rather than a coloured pill, and why it goes after the title
 * instead of before it (the title is still how the user finds the row they want).
 *
 * The name comes off the chat index mirror (Chat.editingModName), so this costs no extra read.
 */
function chatOptionLabel(c: ChatRecord): string {
  // The mod comes BEFORE the relative time, and the time is dropped entirely when there is one.
  //
  // A <select> cannot ellipse per-part the way the draft bar does — the option is one string and
  // the browser truncates whatever runs past the box. With the order "title · 3m ago · <mod>", the
  // mod name is last and is therefore the part that always dies: at the panel's own 420px the owner
  // saw it cut to a single letter, which names no mod and is worse than saying nothing. So the mod
  // takes the slot the timestamp had.
  //
  // Dropping the time is the right trade rather than a reluctant one: "which installed script does
  // sending a message here rewrite" is a fact about consequences, and "3m ago" is a fact about
  // ordering that the list is ALREADY sorted by. The full string stays in the option's title
  // attribute, so the time is one hover away.
  //
  // The marker is the WORD "editing", not a pencil glyph. --font-ui is the system stack, so a mark
  // like ✎ comes from whatever fallback font the machine happens to have and does not read as a
  // pencil on every one of them — and an option's text cannot be styled, so there is no way to put
  // it in a face we control. A word costs a few characters and is legible everywhere.
  if (c.editingModName) return `${c.title} · editing ${c.editingModName}`;
  return `${c.title} · ${relativeTime(c.updatedAt)}`;
}

/** The whole truth for the option's tooltip, including the time the label gives up. */
function chatOptionTitle(c: ChatRecord): string {
  const base = `${c.title} · ${relativeTime(c.updatedAt)}`;
  return c.editingModName ? `${base} · editing the installed mod “${c.editingModName}”` : base;
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

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/**
 * One tool call: a rail, a status dot and the tool's name in mono, opening to its code and result.
 *
 * The dot carries the state the glyphs used to: volt when it came back clean, amber while it is
 * still running, coral when it failed. Only volt glows. A wait_for that timed out takes the amber
 * dot, not the coral one: the page did not do the thing, which is a result, not a failure.
 */
function ToolRow({ item }: { item: ToolItem }) {
  return (
    <details className={`tool${item.isError ? ' error' : ''}`}>
      <summary>
        <span className={`dot${toolDotClass(toolDotState(item))}`} aria-hidden="true" />
        <span>{toolRowTitle(item.name, item.input)}</span>
      </summary>
      {typeof item.input.code === 'string' && <pre>{item.input.code}</pre>}
      {item.summary && <pre>{item.summary}</pre>}
    </details>
  );
}

/**
 * A run of tool calls folded into one line, for a phone: "4 steps", with the dot showing the worst
 * of them and the line naming a step that is still running or counting the ones that failed
 * (stepsSummary in lib/compactshell.ts). It opens to the same rows the panel draws.
 */
function StepsRow({ tools }: { tools: ToolItem[] }) {
  const summary = stepsSummary(tools);
  return (
    <details className={`steps-fold${summary.state === 'error' ? ' error' : ''}`} data-testid="steps" data-steps={tools.length}>
      <summary>
        <span className={`dot${toolDotClass(summary.state)}`} aria-hidden="true" />
        <span className="steps-fold-label">{summary.label}</span>
        <ChevronDownIcon />
      </summary>
      <div className="steps-fold-rows">
        {tools.map((t) => (
          <ToolRow key={t.id} item={t} />
        ))}
      </div>
    </details>
  );
}

/** A chat's row in the compact chat sheet: its title, and the mod it is editing if it is. */
function chatRowLabel(c: ChatRecord): string {
  return c.editingModName ? `${c.title} · editing ${c.editingModName}` : c.title;
}
