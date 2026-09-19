// Persistent chats. A chat is scoped to a site (host) and lives in chrome.storage.local so it
// survives side-panel reloads and browser restarts. One index plus four keys per chat:
//   'chats'              — Chat[] metadata index, newest activity first
//   'chat:<id>:messages' — Msg[] model history, written by the background worker
//   'chat:<id>:items'    — ChatItem[] panel transcript, written by the side panel
//   'chat:<id>:blobs'    — full-size attached images by content hash (lib/blobs.ts)
//   'chat:<id>:artifact' — Artifact draft mod (lib/artifact.ts), written by the background
// chatKeys() below is the single list of the per-chat keys, so deleting a chat cannot leave one.
import { artifactKey } from './artifact.ts';
import { blobsKey, elidedImageNote, type AttachedImage, type ImageThumb } from './images.ts';
import type { ModelSelection } from './connections.ts';
import type { TitleSource } from './title';
import type { ChatItem, Msg, Part } from './types';

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
  /**
   * The id of this chat's draft mod, when it has one. The artifact itself lives under its own key
   * ('chat:<id>:artifact') because it holds whole scripts and the index is read on every panel
   * open; this is only a flag on the index, so the dashboard can show a "draft" badge without
   * reading 200 artifacts to find out which chats have one.
   */
  artifactId?: string;
  /**
   * How many versions that draft has, so the dashboard's badge can say "draft · 3 versions" from
   * the index alone. Same reasoning as `turns`: a number on the index beats reading every artifact
   * to render a list. Absent on chats whose draft predates the field, where the badge simply says
   * "draft" rather than guessing a count.
   */
  artifactVersions?: number;
  /**
   * The model this chat talks to: a connection (lib/connections.ts) and a model id on it. Chosen in
   * the composer, changeable at any point in the conversation, and read by the background at the
   * start of every run — so it is what the agent loop, the titler, the compaction summariser and a
   * Resume all use. On the index, like `turns`, so the dashboard can show it without reading a
   * transcript. Absent on a chat that has never run under a build with connections; such a chat
   * takes the default a new chat would (selectionForChat) and has it written here on its next run.
   */
  model?: ModelSelection;
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
export { blobsKey };

/**
 * Every storage key a chat owns: its model history, its panel transcript, its attached images and
 * its draft mod. Deleting a chat — by hand, in bulk, or by falling off the end of the MAX_CHATS
 * index — removes all four together, so an attached image or a draft script can never outlive the
 * conversation it belongs to. Every path that removes a chat goes through this rather than listing
 * keys of its own, so a fifth per-chat key added later cannot be forgotten by one of the three
 * deletion routes and leak forever in a profile. (It was already two routes plus the cap when the
 * blob and artifact keys arrived, which is exactly how that mistake gets made.)
 */
export function chatKeys(id: string): string[] {
  return [messagesKey(id), itemsKey(id), blobsKey(id), artifactKey(id)];
}

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

/**
 * Write the index through the MAX_CHATS cap, deleting the transcript keys of anything it evicted.
 * Every writer that can grow the index, or that can change which chats the cap would evict first
 * (archiving does exactly that — archived chats go before live ones), goes through here, so the
 * 200-chat ceiling is one rule in one place rather than a thing each caller remembers.
 */
async function writeIndexCapped(chats: Chat[]): Promise<void> {
  const { kept, dropped } = capChats(chats);
  await writeIndex(kept);
  if (dropped.length) await chrome.storage.local.remove(dropped.flatMap(chatKeys));
}

export async function listChats(host?: string): Promise<Chat[]> {
  const all = await readIndex();
  return host ? all.filter((c) => c.host === host) : all;
}

export async function getChat(id: string): Promise<Chat | null> {
  return (await readIndex()).find((c) => c.id === id) ?? null;
}

export async function createChat(host: string, model?: ModelSelection | null): Promise<Chat> {
  const now = Date.now();
  const chat: Chat = { id: crypto.randomUUID(), host, title: 'New chat', titleSource: 'auto-first', createdAt: now, updatedAt: now };
  // The model picked in the composer before the first message, so the first run uses it.
  if (model?.connectionId && model.model) chat.model = { connectionId: model.connectionId, model: model.model, ...(model.label ? { label: model.label } : {}) };
  await writeIndexCapped([chat, ...(await readIndex())]);
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
 * Record which model a chat talks to. Not activity: picking a model does not reorder the switcher
 * or unarchive anything, so this goes round touchChat the same way setChatArtifact does.
 */
export async function setChatModel(id: string, model: ModelSelection): Promise<void> {
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  if (chat.model?.connectionId === model.connectionId && chat.model.model === model.model && chat.model.label === model.label) return;
  chat.model = { connectionId: model.connectionId, model: model.model, ...(model.label ? { label: model.label } : {}) };
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

/**
 * Note on the index that this chat has a draft mod. Deliberately NOT touchChat: recording an
 * artifact is bookkeeping, and touchChat bumps updatedAt and unarchives — which would reorder the
 * switcher and resurrect an archived chat every time the model proposed something in it.
 */
export async function setChatArtifact(id: string, artifactId: string, versions: number): Promise<void> {
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat || (chat.artifactId === artifactId && chat.artifactVersions === versions)) return;
  chat.artifactId = artifactId;
  chat.artifactVersions = versions;
  await writeIndex(chats);
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
  await chrome.storage.local.remove(chatKeys(id));
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
    await chrome.storage.local.remove([...wanted].flatMap(chatKeys));
    return;
  }
  // Capped like every other index write. A bulk unarchive is the case that needs it: an index of
  // 200 where most are archived is within the cap only because archived chats are cheap to evict,
  // and unarchiving them does not grow the index but does change which chats the next cap pass
  // would drop. Going through the cap here keeps the ceiling and the transcript cleanup in one
  // rule rather than leaving this one writer to grow the index past MAX_CHATS by another route.
  await writeIndexCapped(applyBulkArchive(chats, wanted, action, Date.now()));
}

/**
 * The archive/unarchive half of a bulk action as a pure decision: the index with archivedAt set or
 * cleared on the named chats and nothing else touched. Separate from bulkChats so the rule is
 * testable without chrome.storage.
 */
export function applyBulkArchive(chats: Chat[], wanted: Set<string>, action: 'archive' | 'unarchive', at: number): Chat[] {
  return chats.map((chat) => {
    if (!wanted.has(chat.id)) return chat;
    if (action === 'archive') return { ...chat, archivedAt: at };
    const { archivedAt: _dropped, ...rest } = chat;
    return rest;
  });
}

export async function loadMessages(id: string): Promise<Msg[]> {
  const r = await chrome.storage.local.get(messagesKey(id));
  return (r[messagesKey(id)] as Msg[] | undefined) ?? [];
}

/** How many of the most recent user turns keep their attached images at full size in the history. */
export const KEEP_IMAGE_TURNS = 2;

/**
 * Shrink the model history before it is written to storage.
 *
 * Two different rules, because the two kinds of image are not the same thing:
 *
 *   - A SCREENSHOT taken by a tool is dropped entirely, always. It is a picture of a page the agent
 *     can simply look at again, so keeping it costs a megabyte to save a tool call.
 *   - An ATTACHED image came from the user and cannot be re-fetched from anywhere. The most recent
 *     KEEP_IMAGE_TURNS user turns keep theirs whole, so "make it look like this" still works on the
 *     next turn and the one after; older ones become the same one-line stub a screenshot gets, and
 *     the full copy survives in the chat's blob store for the panel to show.
 *
 * Both keep the STRUCTURE intact: a stub replaces the image part in place, so every message still
 * has content and every adapter still emits a valid request.
 */
export function slimMessages(messages: Msg[]): Msg[] {
  const keepFrom = imageKeepIndex(messages, KEEP_IMAGE_TURNS);
  return messages.map((m, i) => {
    const content = m.content.map((p) =>
      p.type === 'tool_result'
        ? { ...p, content: p.content.map((c) => (c.type === 'image' ? { type: 'text' as const, text: '[screenshot omitted from history]' } : c)) }
        : p,
    );
    return { ...m, content: i >= keepFrom ? content : elideAttachedImages(content) };
  });
}

/**
 * Index of the message that starts the Nth-from-last user TURN. Everything from there on keeps its
 * attached images; everything before it is stubbed.
 *
 * A user message carrying tool results is not a turn (the agent loop writes results back as role
 * 'user'), which is the same rule lib/agent/compact.ts uses — the two have to agree, or a history
 * would be trimmed differently on its way to storage than on its way to the model.
 */
function imageKeepIndex(messages: Msg[], turns: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user' || m.content.some((p) => p.type === 'tool_result')) continue;
    seen += 1;
    if (seen === turns) return i;
  }
  return 0; // fewer turns than we promised to keep: nothing is old enough to stub
}

/** Replace every image part in one message's content with its stub, numbered as it was attached. */
export function elideAttachedImages(content: Part[]): Part[] {
  let n = 0;
  let changed = false;
  const out = content.map((p) => {
    if (p.type !== 'image') return p;
    const stub: Part = { type: 'text', text: elidedImageNote(n) };
    n += 1;
    changed = true;
    return stub;
  });
  return changed ? out : content;
}

/** Every blob hash a transcript still refers to, so nothing else has to know the item shape. */
export function referencedHashes(items: ChatItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind !== 'user' || !it.images) continue;
    for (const img of it.images as ImageThumb[]) if (img.hash) out.push(img.hash);
  }
  return out;
}

/**
 * The history to persist when a run failed before runAgent could return one: everything that was
 * already there, plus the user's turn, so the conversation survives a provider error. The turn is
 * not appended twice if a retry already recorded identical text at the end.
 */
export function appendTurn(history: Msg[], turn: { text: string; images?: AttachedImage[] }): Msg[] {
  const text = turn.text.trim();
  if (!text) return [...history];
  const last = history[history.length - 1];
  const lastText = last?.role === 'user' ? last.content.find((p) => p.type === 'text')?.text?.trim() : undefined;
  if (lastText === text) return [...history];
  // Images first, exactly as the loop would have rendered them (lib/agent/loop.ts turnParts), so a
  // turn recovered from a failed run looks the same to the model as one that went through cleanly.
  const images: Part[] = (turn.images ?? []).map((img) => ({ type: 'image', mediaType: img.mediaType, data: img.data }));
  return [...history, { role: 'user', content: [...images, { type: 'text', text: turn.text }] }];
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
