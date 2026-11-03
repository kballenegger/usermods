// What the user has allowed usermods to do on a site: standing per-site allowances ("Do not ask again
// on shop.example.com"), and per-chat ones ("operate this site", "every Unsubscribe"). Not
// lib/exec/grants.ts, which is the GM grants of a mod.
//
// One storage key, read and written through a queue, the shape of the run records (lib/runstate.ts):
// the question asked is about one chat on one host, but Settings lists every site and deleting a chat
// forgets what it held. The rules are pure functions over the stored shape, so the storage half can
// be handed a fake (test/allowances.test.ts).
//
// Only the panel's answer handlers may call the writers. A message from a page never reaches them:
// from the page the background accepts only Stop and "I have done it".

// The .ts extensions: see lib/agent/tools.ts. node's test runner loads this file directly.
import { withKey } from '../storagequeue.ts';
import type { GateAllowances } from './gate';

export const ALLOWANCES_KEY = 'allowances';

export interface ChatAllowance {
  /** Hosts this chat may operate. */
  sites: string[];
  /** host → named actions ("every Unsubscribe"), as lib/agent/gate.ts names them. */
  actions: Record<string, string[]>;
}

export interface AllowanceState {
  /** host → when the user said not to ask again. */
  sites: Record<string, number>;
  chats: Record<string, ChatAllowance>;
}

export const EMPTY_ALLOWANCES: AllowanceState = { sites: {}, chats: {} };

const norm = (host: string) => host.trim().toLowerCase();

const stringsOf = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** Whatever is stored, with anything malformed dropped. An allowance nobody can read is not one. */
export function parseAllowances(raw: unknown): AllowanceState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { sites?: unknown; chats?: unknown };
  const sites: Record<string, number> = {};
  for (const [host, at] of Object.entries((r.sites && typeof r.sites === 'object' ? r.sites : {}) as Record<string, unknown>)) {
    if (host && typeof at === 'number' && Number.isFinite(at)) sites[norm(host)] = at;
  }
  const chats: Record<string, ChatAllowance> = {};
  for (const [id, v] of Object.entries((r.chats && typeof r.chats === 'object' ? r.chats : {}) as Record<string, unknown>)) {
    const c = (v && typeof v === 'object' ? v : {}) as { sites?: unknown; actions?: unknown };
    const actions: Record<string, string[]> = {};
    for (const [host, list] of Object.entries((c.actions && typeof c.actions === 'object' ? c.actions : {}) as Record<string, unknown>)) {
      const named = stringsOf(list);
      if (named.length) actions[norm(host)] = named;
    }
    chats[id] = { sites: stringsOf(c.sites).map(norm), actions };
  }
  return { sites, chats };
}

/** What the gate is told about this chat on this host. */
export function allowancesFor(state: AllowanceState, chatId: string, host: string): GateAllowances {
  const h = norm(host);
  const chat = state.chats[chatId];
  return { site: h in state.sites || (chat?.sites.includes(h) ?? false), actions: chat?.actions[h] ?? [] };
}

function chatOf(state: AllowanceState, chatId: string): ChatAllowance {
  return state.chats[chatId] ?? { sites: [], actions: {} };
}

/** "Allow": for this chat, or, with the box ticked, for the site until it is removed in Settings. */
export function allowSite(state: AllowanceState, chatId: string, host: string, standing: boolean, now: number = Date.now()): AllowanceState {
  const h = norm(host);
  const chat = chatOf(state, chatId);
  return {
    sites: standing ? { ...state.sites, [h]: now } : state.sites,
    chats: { ...state.chats, [chatId]: chat.sites.includes(h) ? chat : { ...chat, sites: [...chat.sites, h] } },
  };
}

/** "Allow every one of these in this chat". Never outlives the chat; never crosses to another host. */
export function allowAction(state: AllowanceState, chatId: string, host: string, key: string): AllowanceState {
  const h = norm(host);
  const chat = chatOf(state, chatId);
  const list = chat.actions[h] ?? [];
  if (list.includes(key)) return state;
  return { ...state, chats: { ...state.chats, [chatId]: { ...chat, actions: { ...chat.actions, [h]: [...list, key] } } } };
}

/** Settings' Remove: the standing allowance goes, and so does every chat's hold on that host. */
export function removeSite(state: AllowanceState, host: string): AllowanceState {
  const h = norm(host);
  const sites = { ...state.sites };
  delete sites[h];
  const chats: Record<string, ChatAllowance> = {};
  for (const [id, chat] of Object.entries(state.chats)) {
    const actions = { ...chat.actions };
    delete actions[h];
    chats[id] = { sites: chat.sites.filter((s) => s !== h), actions };
  }
  return { sites, chats };
}

/** A deleted chat's allowances go with it. Standing ones are the user's, and stay. */
export function forgetChat(state: AllowanceState, chatId: string): AllowanceState {
  if (!(chatId in state.chats)) return state;
  const chats = { ...state.chats };
  delete chats[chatId];
  return { ...state, chats };
}

/** The sites Settings lists, sorted. */
export function standingSites(state: AllowanceState): string[] {
  return Object.keys(state.sites).sort();
}

// ---------------------------------------------------------------------------
// The storage half
// ---------------------------------------------------------------------------

/** What this file needs of chrome.storage.local. */
export interface AllowanceStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const liveStore = (): AllowanceStore => chrome.storage.local as unknown as AllowanceStore;

export async function loadAllowances(store: AllowanceStore = liveStore()): Promise<AllowanceState> {
  const r = await store.get(ALLOWANCES_KEY);
  return parseAllowances(r[ALLOWANCES_KEY]);
}

/** One read-modify-write, queued so two answers in quick succession cannot lose one. */
export function updateAllowances(fn: (state: AllowanceState) => AllowanceState, store: AllowanceStore = liveStore()): Promise<AllowanceState> {
  return withKey(ALLOWANCES_KEY, async () => {
    const state = await loadAllowances(store);
    const next = fn(state);
    if (next !== state) await store.set({ [ALLOWANCES_KEY]: next });
    return next;
  });
}
