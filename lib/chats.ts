// Persistent chats. A chat is scoped to a site (host) and lives in chrome.storage.local so it
// survives side-panel reloads and browser restarts. Three keys per chat:
//   'chats'              — Chat[] metadata index, newest activity first
//   'chat:<id>:messages' — Msg[] model history, written by the background worker
//   'chat:<id>:items'    — ChatItem[] panel transcript, written by the side panel
import type { TitleSource } from './title';
import type { ChatItem, Msg } from './types';

const INDEX_KEY = 'chats';
/** Oldest chats beyond this are dropped so the index cannot grow without bound. */
export const MAX_CHATS = 200;
const TITLE_MAX = 60;

export interface Chat {
  id: string;
  /** Hostname of the page the chat belongs to, without a leading "www.". */
  host: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** When the user archived this chat. Archived chats are hidden from the main switcher list and
   *  are never auto-selected, but they are still readable and writable; sending unarchives. */
  archivedAt?: number;
  /**
   * Where `title` came from, so a better title never clobbers a more deliberate one:
   * 'auto-first' — the truncated first message, written when the chat's first turn starts.
   * 'auto-model' — the model named it after a turn completed.
   * 'user'       — the user renamed it in the switcher. Nothing overwrites this.
   * Absent on chats written by an older build; treated as 'auto-first'.
   */
  titleSource?: TitleSource;
  /** Set once the one allowed model retitle (at the 4th turn) has happened, so it never repeats. */
  titleRefreshed?: boolean;
  /**
   * The page URL this chat was last used on, recorded by the background on every turn. It is what
   * the dashboard's "Open" reopens the chat on, so returning to a chat lands on the actual page it
   * was about rather than the site's front door.
   *
   * Chats created before this field existed have none, and where they were used is not recoverable
   * — nothing recorded it. Those fall back to the host (see chatOpenUrl in lib/dashboard).
   */
  url?: string;
  /**
   * How many user turns this chat holds, kept on the index so the dashboard can show it without
   * reading every transcript. Written by the background on each turn; absent on chats that predate
   * the field, where the dashboard simply shows no count rather than guessing one.
   */
  turns?: number;
}

/** A chat's title source, defaulting for records written before the field existed. */
export function titleSourceOf(chat: Pick<Chat, 'titleSource'>): TitleSource {
  return chat.titleSource ?? 'auto-first';
}

/** Archived chats are the ones with a timestamp; everything else is live. */
export function isArchived(chat: Chat): boolean {
  return typeof chat.archivedAt === 'number';
}

export const messagesKey = (id: string) => `chat:${id}:messages`;
export const itemsKey = (id: string) => `chat:${id}:items`;

/** Hostname of a page URL, without "www.". Empty string for chrome:// and other non-http pages. */
export function hostFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return '';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A chat's title: the first user message, collapsed to one line and truncated. */
export function titleFromText(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return 'New chat';
  return one.length > TITLE_MAX ? one.slice(0, TITLE_MAX - 1).trimEnd() + '…' : one;
}

/** Short relative time for the chat switcher, e.g. "3m", "2h", "5d". */
export function relativeTime(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 365) return `${d}d`;
  return `${Math.round(d / 365)}y`;
}

/** Newest activity first. */
export function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Trim the index to MAX_CHATS. Returns the survivors (newest activity first) and the ids that were
 * dropped, so the caller can delete their message and item keys too.
 *
 * Archived chats are evicted before live ones — the user said they were done with those — and
 * within each group the oldest goes first. Only once every archived chat is gone does a live chat
 * get dropped.
 */
export function capChats(chats: Chat[], max = MAX_CHATS): { kept: Chat[]; dropped: string[] } {
  const sorted = sortChats(chats);
  if (sorted.length <= max) return { kept: sorted, dropped: [] };
  // Eviction order: archived before live, oldest before newest. The tail of this list is what goes.
  const byEviction = [...sorted].sort((a, b) => {
    const arch = Number(isArchived(a)) - Number(isArchived(b));
    if (arch !== 0) return -arch; // archived first
    return a.updatedAt - b.updatedAt; // oldest first
  });
  const dropped = new Set(byEviction.slice(0, sorted.length - max).map((c) => c.id));
  return { kept: sorted.filter((c) => !dropped.has(c.id)), dropped: [...dropped] };
}

/** The live chats for the switcher's main list, newest activity first. */
export function liveChats(chats: Chat[]): Chat[] {
  return sortChats(chats).filter((c) => !isArchived(c));
}

/** The archived chats for the switcher's "Archived" group, most recently archived first. */
export function archivedChats(chats: Chat[]): Chat[] {
  return chats.filter(isArchived).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
}

/**
 * Which chat the panel should show when it opens on a host: the most recently updated chat that is
 * not archived. Null means show an empty composer, because there is nothing live to come back to.
 *
 * The owner's rule is "always show the last chat until the user creates a new one or explicitly
 * archives the chat", so archiving is the only thing (besides deleting) that takes a chat out of
 * this lookup.
 */
export function pickChatToShow(chats: Chat[]): Chat | null {
  return liveChats(chats)[0] ?? null;
}

async function readIndex(): Promise<Chat[]> {
  const r = await chrome.storage.local.get(INDEX_KEY);
  const raw = (r[INDEX_KEY] as Chat[] | undefined) ?? [];
  return sortChats(raw.filter((c) => c && typeof c.id === 'string'));
}

async function writeIndex(chats: Chat[]): Promise<void> {
  await chrome.storage.local.set({ [INDEX_KEY]: sortChats(chats) });
}

export async function listChats(host?: string): Promise<Chat[]> {
  const all = await readIndex();
  return host ? all.filter((c) => c.host === host) : all;
}

export async function getChat(id: string): Promise<Chat | null> {
  return (await readIndex()).find((c) => c.id === id) ?? null;
}

export async function createChat(host: string): Promise<Chat> {
  const now = Date.now();
  const chat: Chat = { id: crypto.randomUUID(), host, title: 'New chat', titleSource: 'auto-first', createdAt: now, updatedAt: now };
  const { kept, dropped } = capChats([chat, ...(await readIndex())]);
  await writeIndex(kept);
  if (dropped.length) await chrome.storage.local.remove(dropped.flatMap((id) => [messagesKey(id), itemsKey(id)]));
  return chat;
}

/**
 * Bump updatedAt, and set the title if one is supplied and the chat has no real title yet.
 * Activity in an archived chat unarchives it: sending a message means the user is using it again.
 *
 * `url` records the page the turn happened on, overwriting whatever was there: the chat is "about"
 * wherever it was last used, which is where the dashboard should reopen it. Only http(s) URLs are
 * kept — an extension page or a chrome:// URL is not somewhere to come back to.
 */
export async function touchChat(id: string, patch: { title?: string; url?: string; turns?: number } = {}): Promise<void> {
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  chat.updatedAt = Date.now();
  delete chat.archivedAt;
  if (patch.title && (!chat.title || chat.title === 'New chat')) {
    chat.title = titleFromText(patch.title);
    chat.titleSource = 'auto-first';
  }
  if (patch.url && /^https?:\/\//i.test(patch.url)) chat.url = patch.url;
  if (typeof patch.turns === 'number') chat.turns = patch.turns;
  await writeIndex(chats);
}

/**
 * Write a model-written title, unless the user has since named the chat themselves. `refresh` marks
 * the one allowed retitle as spent, whether or not it produced a different string.
 *
 * Returns the stored title when it changed, so the caller knows whether to tell the panel.
 */
export async function setModelTitle(id: string, title: string, { refresh = false } = {}): Promise<string | null> {
  const clean = titleFromText(title);
  if (!clean || clean === 'New chat') return null;
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return null;
  // The user may have renamed it while the title call was in flight; their name wins.
  if (titleSourceOf(chat) === 'user') return null;
  const changed = chat.title !== clean;
  chat.title = clean;
  chat.titleSource = 'auto-model';
  if (refresh) chat.titleRefreshed = true;
  await writeIndex(chats);
  return changed ? clean : null;
}

/**
 * Spend the one allowed retitle without changing the title. Used when the refresh call came back
 * empty or refused: keeping the existing name is right, but asking again on every later turn is not.
 */
export async function markTitleRefreshed(id: string): Promise<void> {
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  chat.titleRefreshed = true;
  await writeIndex(chats);
}

/**
 * User turns in a stored model history — what the dashboard shows as a chat's length.
 *
 * Not every user-role message is a turn: the agent loop pushes tool results back as role 'user'
 * too (lib/agent/loop.ts), so a single question that took six tool calls would otherwise read as
 * seven turns. A turn is a user message carrying text the person actually typed, which is exactly
 * the messages with a text part.
 */
export function countTurns(messages: Msg[]): number {
  return messages.filter((m) => m.role === 'user' && m.content.some((p) => p.type === 'text')).length;
}

/** Archive or unarchive a chat. Reversible, so the UI does not confirm it. */
export async function archiveChat(id: string, archived: boolean): Promise<void> {
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  if (archived) chat.archivedAt = Date.now();
  else delete chat.archivedAt;
  await writeIndex(chats);
}

/** The user naming a chat by hand. This is the one title source nothing else overwrites. */
export async function renameChat(id: string, title: string): Promise<void> {
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  const clean = titleFromText(title);
  if (!clean || clean === 'New chat') return;
  chat.title = clean;
  chat.titleSource = 'user';
  await writeIndex(chats);
}

export async function deleteChat(id: string): Promise<void> {
  await writeIndex((await readIndex()).filter((c) => c.id !== id));
  await chrome.storage.local.remove([messagesKey(id), itemsKey(id)]);
}

/**
 * Archive, unarchive or delete several chats in one pass. The dashboard's bulk actions go through
 * here rather than looping over the single-chat calls: each of those does its own read-modify-write
 * of the index, so twenty of them in a row is twenty chances for two of them to interleave and lose
 * an edit. One read and one write cannot.
 */
export async function bulkChats(ids: string[], action: 'archive' | 'unarchive' | 'delete'): Promise<void> {
  const wanted = new Set(ids);
  if (!wanted.size) return;
  const chats = await readIndex();
  if (action === 'delete') {
    await writeIndex(chats.filter((c) => !wanted.has(c.id)));
    await chrome.storage.local.remove([...wanted].flatMap((id) => [messagesKey(id), itemsKey(id)]));
    return;
  }
  const at = Date.now();
  for (const chat of chats) {
    if (!wanted.has(chat.id)) continue;
    if (action === 'archive') chat.archivedAt = at;
    else delete chat.archivedAt;
  }
  await writeIndex(chats);
}

export async function loadMessages(id: string): Promise<Msg[]> {
  const r = await chrome.storage.local.get(messagesKey(id));
  return (r[messagesKey(id)] as Msg[] | undefined) ?? [];
}

/** Screenshots are large; drop image data so a long chat stays well under the storage quota. */
export function slimMessages(messages: Msg[]): Msg[] {
  return messages.map((m) => ({
    ...m,
    content: m.content.map((p) =>
      p.type === 'tool_result'
        ? { ...p, content: p.content.map((c) => (c.type === 'image' ? { type: 'text' as const, text: '[screenshot omitted from history]' } : c)) }
        : p,
    ),
  }));
}

/**
 * The history to persist when a run failed before runAgent could return one: everything that was
 * already there, plus the user's turn, so the conversation survives a provider error. The turn is
 * not appended twice if a retry already recorded identical text at the end.
 */
export function appendTurn(history: Msg[], turn: { text: string }): Msg[] {
  const text = turn.text.trim();
  if (!text) return [...history];
  const last = history[history.length - 1];
  const lastText = last?.role === 'user' ? last.content.find((p) => p.type === 'text')?.text?.trim() : undefined;
  if (lastText === text) return [...history];
  return [...history, { role: 'user', content: [{ type: 'text', text: turn.text }] }];
}

export async function saveMessages(id: string, messages: Msg[]): Promise<void> {
  await chrome.storage.local.set({ [messagesKey(id)]: slimMessages(messages) });
}

export async function loadItems(id: string): Promise<ChatItem[]> {
  const r = await chrome.storage.local.get(itemsKey(id));
  return (r[itemsKey(id)] as ChatItem[] | undefined) ?? [];
}

export async function saveItems(id: string, items: ChatItem[]): Promise<void> {
  await chrome.storage.local.set({ [itemsKey(id)]: items });
}
