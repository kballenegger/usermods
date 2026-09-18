// The pure decisions behind the full-tab dashboard (entrypoints/dashboard). Everything here is a
// plain function over data so it can be tested with `npm test` and no browser: how chats group by
// host, what a search matches, which chat a side-panel handoff resolves to, what a bulk selection
// applies to, and how a mod is described in the list.
//
// Nothing in this file touches chrome.* — the dashboard page does the I/O and calls in here to
// decide. Keep it that way: the handoff rule in particular is the one piece of this feature the
// browser tests cannot reach (a side panel cannot be opened by automation), so it lives here.
import { isArchived, relativeTime, type Chat } from './chats.ts';
import type { Mod } from './types';

// ---------------------------------------------------------------------------
// Chats: grouping and search
// ---------------------------------------------------------------------------

/** One host's chats in the dashboard list, newest activity first. */
export interface HostGroup {
  host: string;
  chats: Chat[];
  /** Chats in this group that are not archived. */
  liveCount: number;
  archivedCount: number;
  /** The most recent updatedAt in the group; what the groups are ordered by. */
  updatedAt: number;
}

/**
 * Group chats by host for the dashboard's chat list. Groups are ordered by their most recent
 * activity (so the site you were last working on is at the top), and chats within a group are
 * newest first. Archived chats stay in their host's group — the dashboard shows them with a badge
 * rather than hiding them, because reading an old chat is the point of this page.
 */
export function groupChatsByHost(chats: Chat[]): HostGroup[] {
  const byHost = new Map<string, Chat[]>();
  for (const c of chats) {
    const list = byHost.get(c.host);
    if (list) list.push(c);
    else byHost.set(c.host, [c]);
  }
  const groups: HostGroup[] = [];
  for (const [host, list] of byHost) {
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    groups.push({
      host,
      chats: sorted,
      liveCount: sorted.filter((c) => !isArchived(c)).length,
      archivedCount: sorted.filter(isArchived).length,
      updatedAt: sorted[0]?.updatedAt ?? 0,
    });
  }
  // Ties broken by host name so the order is stable across renders and across test runs.
  return groups.sort((a, b) => b.updatedAt - a.updatedAt || a.host.localeCompare(b.host));
}

/** How a chat matched the search box, so the UI can say why a result is there. */
export type ChatMatch = 'title' | 'host' | 'message';

/**
 * Does this chat match the query on its metadata alone (title or host)? Case-insensitive substring,
 * because the search box is a filter rather than a query language.
 *
 * Message text is deliberately NOT considered here: transcripts live in separate storage keys and
 * reading every one of them on every keystroke is the thing the dashboard must not do. The page
 * loads transcripts lazily for the chats still on screen and passes them to `searchChats` below.
 */
export function chatMetaMatch(chat: Chat, query: string): ChatMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (chat.title.toLowerCase().includes(q)) return 'title';
  if (chat.host.toLowerCase().includes(q)) return 'host';
  return null;
}

/**
 * Filter chats for the search box. `transcripts` holds the message text the page has loaded so far,
 * keyed by chat id; a chat with no entry is judged on its metadata only, which is why the page can
 * render results immediately and refine them as transcript reads land.
 *
 * An empty query returns everything, unfiltered and in the order it came in.
 */
export function searchChats(chats: Chat[], query: string, transcripts: Map<string, string> = new Map()): Chat[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...chats];
  return chats.filter((c) => {
    if (chatMetaMatch(c, q)) return true;
    const text = transcripts.get(c.id);
    return text !== undefined && text.toLowerCase().includes(q);
  });
}

/**
 * Which chats' transcripts are worth reading for a search, and in what order. Capped, because a
 * profile can hold MAX_CHATS (200) transcripts and a keystroke must not queue 200 storage reads.
 * Chats whose metadata already matched are skipped: they are in the results either way.
 *
 * Newest first, so the chats the user is most likely looking for are searched first and the cap
 * bites on the oldest.
 */
export function transcriptsToSearch(chats: Chat[], query: string, have: Set<string>, cap = 40): string[] {
  const q = query.trim();
  if (!q) return [];
  return chats
    .filter((c) => !have.has(c.id) && !chatMetaMatch(c, q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, cap)
    .map((c) => c.id);
}

// ---------------------------------------------------------------------------
// The side-panel handoff
// ---------------------------------------------------------------------------

/**
 * What the dashboard writes to chrome.storage.session when "Open" is clicked, and what the side
 * panel reads on the other side. Session storage, not local: a handoff is meaningless after a
 * browser restart, and it must not outlive the click that made it.
 */
export interface ChatHandoff {
  chatId: string;
  host: string;
  /** When the dashboard wrote it. */
  at: number;
}

export const HANDOFF_KEY = 'openChat';

/**
 * How long a handoff stays good. Long enough for a tab to be created, navigate and have the panel
 * mount on a slow connection; short enough that a handoff nobody consumed (the user closed the tab,
 * or the panel never opened) cannot hijack the next panel that happens to open on that host.
 */
export const HANDOFF_TTL_MS = 2 * 60 * 1000;

/**
 * Which chat the side panel should show, given a possible handoff from the dashboard. This is the
 * whole rule in one place:
 *
 *  - a handoff for THIS host, recent enough, naming a chat that still exists → that chat, and the
 *    panel clears the handoff so a later mount does not reopen it;
 *  - anything else → whatever the panel would have shown anyway (pickChatToShow's answer), leaving
 *    a handoff for another host alone, because that host's panel has not seen it yet.
 *
 * An archived chat is honoured: the dashboard let the user click Open on it deliberately, and the
 * panel already opens archived chats read-write. Opening one this way does not unarchive it —
 * sending a message does, which is the existing rule in touchChat.
 *
 * `fallback` is the chat the panel picked on its own (pickChatToShow), passed in rather than
 * recomputed so this function stays a decision and not a second implementation of that rule.
 */
export function resolveHandoff(
  handoff: ChatHandoff | null | undefined,
  host: string,
  chats: Chat[],
  fallback: Chat | null,
  now = Date.now(),
): { chat: Chat | null; clearHandoff: boolean } {
  if (!handoff || !host || handoff.host !== host) return { chat: fallback, clearHandoff: false };
  // A stale handoff is consumed as well as ignored: it is for this host, so nothing else will ever
  // claim it, and leaving it behind would only make it stale for longer.
  if (!(now - handoff.at < HANDOFF_TTL_MS) || now < handoff.at - HANDOFF_TTL_MS) {
    return { chat: fallback, clearHandoff: true };
  }
  const wanted = chats.find((c) => c.id === handoff.chatId);
  // Named a chat that has since been deleted: consume it and fall back, rather than show nothing.
  if (!wanted) return { chat: fallback, clearHandoff: true };
  return { chat: wanted, clearHandoff: true };
}

/**
 * The page URL to reopen a chat on. Chats recorded before `url` existed have none, and there is no
 * way to recover where they were used, so the host is the best available answer.
 */
export function chatOpenUrl(chat: Pick<Chat, 'host'> & { url?: string }): string {
  const u = chat.url?.trim();
  if (u && /^https?:\/\//i.test(u)) return u;
  return chat.host ? `https://${chat.host}` : '';
}

// ---------------------------------------------------------------------------
// Mods: description, filtering, bulk
// ---------------------------------------------------------------------------

/** Where a mod came from, for the dashboard's Source column. */
export function modSource(mod: Pick<Mod, 'downloadUrl' | 'source'>): string {
  if (mod.downloadUrl) {
    try {
      return new URL(mod.downloadUrl).hostname.replace(/^www\./, '');
    } catch {
      return mod.downloadUrl;
    }
  }
  // Mods the model writes go through buildSource, which always emits this exact header shape.
  // Anything else with no @downloadURL was brought in from a file or a Tampermonkey backup.
  return /^\/\/\s*@grant\s+none\s*$/m.test(mod.source) && /^\/\/\s*@version\s+1\.0\s*$/m.test(mod.source)
    ? 'written in chat'
    : 'imported';
}

/** A mod's size, as the dashboard shows it. Source text only; @require bodies are counted too. */
export function modSize(mod: Pick<Mod, 'source' | 'requires'>): number {
  return mod.source.length + (mod.requires ?? []).reduce((n, r) => n + r.code.length, 0);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** Every host a mod's patterns name, for the dashboard's "filter by site" select. */
export function modHosts(mod: Pick<Mod, 'matches' | 'includeGlobs'>): string[] {
  const out = new Set<string>();
  for (const p of [...mod.matches, ...mod.includeGlobs]) {
    const m = p.match(/^(?:\*|https?|file|ftp)?:?\/\/([^/]+)/);
    const host = (m?.[1] ?? '').replace(/^\*\./, '').replace(/:\d+$/, '');
    if (host && host !== '*') out.add(host);
  }
  return [...out].sort();
}

/** The site filter's options: every host any mod runs on, with how many mods that is. */
export function modSiteOptions(mods: Mod[]): Array<{ host: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of mods) for (const h of modHosts(m)) counts.set(h, (counts.get(h) ?? 0) + 1);
  return [...counts]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

export interface ModFilter {
  /** '' means every site. */
  site?: string;
  /** 'all' | 'enabled' | 'disabled'. */
  enabled?: 'all' | 'enabled' | 'disabled';
  /** Substring over name, description and match patterns. */
  query?: string;
}

export function filterMods(mods: Mod[], f: ModFilter): Mod[] {
  const q = (f.query ?? '').trim().toLowerCase();
  return mods.filter((m) => {
    if (f.site && !modHosts(m).includes(f.site)) return false;
    if (f.enabled === 'enabled' && !m.enabled) return false;
    if (f.enabled === 'disabled' && m.enabled) return false;
    if (!q) return true;
    return (
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      [...m.matches, ...m.includeGlobs].some((p) => p.toLowerCase().includes(q))
    );
  });
}

/**
 * Which ids a bulk action applies to: the current selection, narrowed to what is actually on
 * screen. A selection survives a filter change in the UI (unchecking everything when someone types
 * in the search box is infuriating), so the action must not quietly reach rows the user cannot see.
 */
export function bulkTargets(selected: Iterable<string>, visible: Array<{ id: string }>): string[] {
  const onScreen = new Set(visible.map((v) => v.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of selected) {
    if (!onScreen.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Toggling the header checkbox. When anything visible is unselected, select all of it; when it is
 * all selected already, clear it. Rows that are not visible keep whatever state they had.
 */
export function toggleSelectAll(selected: Set<string>, visible: Array<{ id: string }>): Set<string> {
  const next = new Set(selected);
  const allSelected = visible.length > 0 && visible.every((v) => next.has(v.id));
  for (const v of visible) {
    if (allSelected) next.delete(v.id);
    else next.add(v.id);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Overview strip
// ---------------------------------------------------------------------------

export interface Overview {
  modsEnabled: number;
  modsTotal: number;
  chatsLive: number;
  chatsArchived: number;
  /** Distinct hosts with at least one enabled mod. */
  sitesCustomised: number;
}

export function overview(mods: Mod[], chats: Chat[]): Overview {
  const sites = new Set<string>();
  for (const m of mods) if (m.enabled) for (const h of modHosts(m)) sites.add(h);
  return {
    modsEnabled: mods.filter((m) => m.enabled).length,
    modsTotal: mods.length,
    chatsLive: chats.filter((c) => !isArchived(c)).length,
    chatsArchived: chats.filter(isArchived).length,
    sitesCustomised: sites.size,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "3m ago · 18 Sep 2026, 14:03" — the relative time the panel uses, plus the absolute one. */
export function timeLabel(then: number, now = Date.now()): { relative: string; absolute: string } {
  const rel = relativeTime(then, now);
  return {
    relative: rel === 'now' ? 'just now' : `${rel} ago`,
    absolute: new Date(then).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
}

/**
 * A .user.js filename for an export, from the mod's name.
 *
 * Path separators are already gone (only word characters, dots and dashes survive), but runs of
 * dots are collapsed too: a mod called "../../etc/passwd" would otherwise export as
 * "..-..-etc-passwd.user.js", which is nothing an unzip tool would act on but is the sort of name a
 * reader has to stop and think about. Leading and trailing punctuation goes the same way.
 */
export function exportFilename(name: string): string {
  const safe = name
    .replace(/[^\w.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
  return `${safe || 'mod'}.user.js`;
}

/**
 * Filenames for a bulk export, de-duplicated: two mods named the same would otherwise collide
 * inside the zip and only one would survive.
 */
export function exportFilenames(mods: Array<Pick<Mod, 'name'>>): string[] {
  const taken = new Set<string>();
  return mods.map((m) => {
    const base = exportFilename(m.name);
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }
    const stem = base.replace(/\.user\.js$/, '');
    for (let i = 2; ; i++) {
      const candidate = `${stem}-${i}.user.js`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  });
}
