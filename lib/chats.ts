// Persistent chats. A chat is scoped to a site (host) and lives in chrome.storage.local so it
// survives side-panel reloads and browser restarts. Three keys per chat:
//   'chats'              — Chat[] metadata index, newest activity first
//   'chat:<id>:messages' — Msg[] model history, written by the background worker
//   'chat:<id>:items'    — ChatItem[] panel transcript, written by the side panel
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
 * Trim the index to MAX_CHATS, oldest first. Returns the survivors and the ids that were dropped,
 * so the caller can delete their message and item keys too.
 */
export function capChats(chats: Chat[], max = MAX_CHATS): { kept: Chat[]; dropped: string[] } {
  const sorted = sortChats(chats);
  if (sorted.length <= max) return { kept: sorted, dropped: [] };
  return { kept: sorted.slice(0, max), dropped: sorted.slice(max).map((c) => c.id) };
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
  const chat: Chat = { id: crypto.randomUUID(), host, title: 'New chat', createdAt: now, updatedAt: now };
  const { kept, dropped } = capChats([chat, ...(await readIndex())]);
  await writeIndex(kept);
  if (dropped.length) await chrome.storage.local.remove(dropped.flatMap((id) => [messagesKey(id), itemsKey(id)]));
  return chat;
}

/** Bump updatedAt, and set the title if one is supplied and the chat has no real title yet. */
export async function touchChat(id: string, patch: { title?: string } = {}): Promise<void> {
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  chat.updatedAt = Date.now();
  if (patch.title && (!chat.title || chat.title === 'New chat')) chat.title = titleFromText(patch.title);
  await writeIndex(chats);
}

export async function renameChat(id: string, title: string): Promise<void> {
  const chats = await readIndex();
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  chat.title = titleFromText(title);
  await writeIndex(chats);
}

export async function deleteChat(id: string): Promise<void> {
  await writeIndex((await readIndex()).filter((c) => c.id !== id));
  await chrome.storage.local.remove([messagesKey(id), itemsKey(id)]);
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
