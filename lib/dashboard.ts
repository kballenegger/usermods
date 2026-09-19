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

/**
 * A stable identity for "the chats a transcript search would read", for a React effect to depend on
 * instead of the chats array itself.
 *
 * The array is a new object on every storage change — the dashboard refreshes on any chats OR mods
 * write, so a chat running in the side panel rebuilds it several times a second. An effect keyed on
 * the array restarts that often, and a restart aborts the in-flight sweep: under sustained writes
 * the transcript reads never finish and those chats never become searchable by message text. Keyed
 * on this string, the effect restarts only when something it actually reads changed.
 *
 * What it reads: which chats exist (sorted ids, so a reordered array is the same key) and each
 * one's updatedAt, because a chat whose transcript grew needs rereading and nothing else does.
 * Titles and hosts are deliberately absent: a rename changes what chatMetaMatch says, but the worst
 * that costs is one stale cached transcript for a chat that is on screen either way, and including
 * them would restart the sweep on every title the model writes.
 */
export function transcriptSearchKey(chats: Chat[]): string {
  return chats
    .map((c) => `${c.id}:${c.updatedAt}`)
    .sort()
    .join(',');
}

/**
 * Which cached transcripts are out of date: the ids whose chat has a newer updatedAt than when the
 * transcript was read, plus the ids whose chat is gone.
 *
 * Without this the cache is never invalidated, so a chat that gains messages while the dashboard is
 * open keeps matching (or not matching) on the text it had when it was first read. With it, the
 * effect drops exactly those entries and the next sweep refetches them — which is only correct
 * because the sweep records what it fetched: `stamps` holds the updatedAt each cached transcript
 * was read at, so "newer than what I have" is a real question rather than a guess.
 */
export function staleTranscripts(chats: Chat[], stamps: Map<string, number>): string[] {
  const live = new Map(chats.map((c) => [c.id, c.updatedAt]));
  return [...stamps].filter(([id, at]) => live.get(id) !== at).map(([id]) => id);
}

/**
 * The chat the preview pane is showing: the one `openId` names, if it still exists.
 *
 * Stated as a function because it is the ONE rule that closes a preview whose chat is gone, and a
 * derivation cannot miss a case the way a remembered flag can. openId is a wish; a wish for a
 * deleted chat simply does not resolve, and the pane shows its empty state on the same render the
 * chat disappeared on.
 *
 * It replaces two weaker mechanisms that used to overlap here: an effect watching the chats array,
 * which closed the pane a render late, and a guard in the bulk-delete handler that tested the
 * FILTERED selection — so deleting the open chat while a search had scrolled it out of the visible
 * rows left the preview up, showing a transcript whose chat no longer existed.
 *
 * The full list is searched, not the filtered one: a chat filtered off screen by the search box is
 * still open and still readable, which is the difference between "you cannot see it in the list"
 * and "it is not there any more".
 */
export function openChatOf(chats: Chat[], openId: string | null): Chat | undefined {
  return openId ? chats.find((c) => c.id === openId) : undefined;
}

/**
 * What a source editor should do when the mod underneath it changed — an Update, a save from the
 * side panel, another dashboard tab.
 *
 *  - 'none': the mod's source is the one this editor already reconciled with. Nothing happened.
 *  - 'adopt': it changed and there are no unsaved edits here, so show the new text silently.
 *  - 'conflict': it changed and there ARE unsaved edits, so keep both and make the user choose.
 *
 * The decision hangs on `dirty` being tracked explicitly — set when the user types, cleared on a
 * save or a revert — and on `seen`, the mod.source this editor last reconciled with. Deriving
 * dirtiness instead, as `source !== mod.source`, is the bug this replaces: the comparison is
 * recomputed against the NEW prop in the same render that the change arrives in, so an editor
 * holding the old text looks dirty before the effect has had a chance to adopt anything. It then
 * refuses to adopt (protecting an edit that was never made), keeps displaying the superseded text
 * with Save lit up, and one click writes the pre-update source back over the update.
 */
export function editorSync(
  { modSource, seen, dirty }: { modSource: string; seen: string; dirty: boolean },
): 'none' | 'adopt' | 'conflict' {
  if (modSource === seen) return 'none';
  return dirty ? 'conflict' : 'adopt';
}

/**
 * Which chat a mod came from, by mod id, built from the chats that have a draft.
 *
 * The link is stored on the ARTIFACT (linkedModId), not on the mod, because it is the draft that
 * knows what it saved and a mod imported from a file or a Tampermonkey backup has no chat at all.
 * That makes this the one direction that needs building: the Mods list has a mod and wants the chat.
 *
 * Two chats can end up pointing at the same mod — save a draft in one chat, then in another chat
 * ask for "the same thing" and save that over it — and the most recently updated chat wins, which
 * is the one whose draft is the mod's current contents.
 */
export function modOrigins(
  entries: Array<{ chat: Chat; linkedModId?: string; versions: number }>,
): Map<string, { chat: Chat; versions: number }> {
  const out = new Map<string, { chat: Chat; versions: number }>();
  for (const e of entries) {
    if (!e.linkedModId) continue;
    const existing = out.get(e.linkedModId);
    if (existing && existing.chat.updatedAt >= e.chat.updatedAt) continue;
    out.set(e.linkedModId, { chat: e.chat, versions: e.versions });
  }
  return out;
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
 * How far ahead of the reader's clock a handoff may be dated and still be honoured. The writer and
 * the reader are the same machine, so the only legitimate difference between the two readings is
 * the few milliseconds between the write and the panel's mount; five seconds is generous for that
 * and tight enough that a handoff dated a minute ahead — a clock jump, a restored profile, a stale
 * key written before the clock was corrected — is stale rather than good for minutes.
 */
export const HANDOFF_SKEW_MS = 5 * 1000;

/**
 * Which chat the side panel should show, given a possible handoff from the dashboard. This is the
 * whole rule in one place:
 *
 *  - a handoff for THIS host, recent enough, naming a chat that still exists → that chat, and the
 *    panel clears the handoff so a later mount does not reopen it. "Recent enough" is a window that
 *    ends HANDOFF_TTL_MS in the past and begins HANDOFF_SKEW_MS in the future: a handoff dated
 *    ahead of the reader's clock by more than that skew allowance is stale, not valid, because a
 *    future timestamp means the two clocks disagree and nothing about it can be trusted;
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
  const age = now - handoff.at;
  if (age >= HANDOFF_TTL_MS || age < -HANDOFF_SKEW_MS) {
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
