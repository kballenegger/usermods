// The pure decisions behind the dashboard: how chats group by host, what the search box matches,
// which chat a side-panel handoff resolves to, what a bulk action applies to, and how a mod is
// described. The handoff rule matters most here — a side panel cannot be opened by automation, so
// these tests are the only place that logic is exercised.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chat } from '../lib/chats.ts';
import {
  bulkTargets,
  chatMetaMatch,
  chatOpenUrl,
  editorSync,
  exportFilename,
  exportFilenames,
  filterMods,
  formatSize,
  groupChatsByHost,
  HANDOFF_SKEW_MS,
  HANDOFF_TTL_MS,
  modHosts,
  modSiteOptions,
  modSize,
  modSource,
  openChatOf,
  overview,
  resolveHandoff,
  searchChats,
  timeLabel,
  staleTranscripts,
  toggleSelectAll,
  transcriptSearchKey,
  transcriptsToSearch,
  type ChatHandoff,
} from '../lib/dashboard.ts';
import type { Mod } from '../lib/types.ts';

function chat(over: Partial<Chat> & { id: string }): Chat {
  return {
    host: 'example.com',
    title: over.id,
    createdAt: over.updatedAt ?? 1000,
    updatedAt: 1000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test('chats group by host, with the most recently used site first', () => {
  const groups = groupChatsByHost([
    chat({ id: 'a', host: 'news.ycombinator.com', updatedAt: 100 }),
    chat({ id: 'b', host: 'wikipedia.org', updatedAt: 500 }),
    chat({ id: 'c', host: 'news.ycombinator.com', updatedAt: 300 }),
  ]);
  assert.deepEqual(groups.map((g) => g.host), ['wikipedia.org', 'news.ycombinator.com']);
  assert.deepEqual(groups[1]!.chats.map((c) => c.id), ['c', 'a'], 'newest chat first within a group');
});

test('a group counts its live and archived chats separately, and keeps both', () => {
  const [g] = groupChatsByHost([
    chat({ id: 'live', updatedAt: 200 }),
    chat({ id: 'gone', updatedAt: 100, archivedAt: 150 }),
  ]);
  assert.equal(g!.chats.length, 2, 'the dashboard shows archived chats too — reading old ones is the point');
  assert.equal(g!.liveCount, 1);
  assert.equal(g!.archivedCount, 1);
});

test('groups with the same activity are ordered by host, so the list does not jitter between renders', () => {
  const groups = groupChatsByHost([chat({ id: 'a', host: 'zebra.com', updatedAt: 5 }), chat({ id: 'b', host: 'apple.com', updatedAt: 5 })]);
  assert.deepEqual(groups.map((g) => g.host), ['apple.com', 'zebra.com']);
});

test('no chats means no groups', () => {
  assert.deepEqual(groupChatsByHost([]), []);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test('search matches a chat title, case-insensitively', () => {
  const chats = [chat({ id: 'a', title: 'Hide the Sidebar' }), chat({ id: 'b', title: 'Dark mode' })];
  assert.deepEqual(searchChats(chats, 'sidebar').map((c) => c.id), ['a']);
  assert.deepEqual(searchChats(chats, 'SIDEBAR').map((c) => c.id), ['a']);
});

test('search matches the host as well as the title', () => {
  const chats = [chat({ id: 'a', host: 'github.com', title: 'wider diffs' }), chat({ id: 'b', host: 'wikipedia.org', title: 'full width' })];
  assert.deepEqual(searchChats(chats, 'github').map((c) => c.id), ['a']);
  assert.equal(chatMetaMatch(chats[0]!, 'github'), 'host');
  assert.equal(chatMetaMatch(chats[0]!, 'diffs'), 'title');
  assert.equal(chatMetaMatch(chats[0]!, 'nothing here'), null);
});

test('search matches message text once a transcript has been loaded, and not before', () => {
  const chats = [chat({ id: 'a', title: 'New chat' })];
  assert.deepEqual(searchChats(chats, 'kingfisher'), [], 'nothing matches before the transcript is read');
  const loaded = new Map([['a', 'make the kingfisher photo bigger']]);
  assert.deepEqual(searchChats(chats, 'kingfisher', loaded).map((c) => c.id), ['a']);
});

test('an empty query returns every chat unfiltered', () => {
  const chats = [chat({ id: 'a' }), chat({ id: 'b' })];
  assert.deepEqual(searchChats(chats, '').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(searchChats(chats, '   ').map((c) => c.id), ['a', 'b']);
});

test('only chats that did not already match on metadata are queued for a transcript read', () => {
  const chats = [chat({ id: 'titled', title: 'sidebar work', updatedAt: 300 }), chat({ id: 'plain', title: 'New chat', updatedAt: 200 })];
  assert.deepEqual(transcriptsToSearch(chats, 'sidebar', new Set()), ['plain']);
});

test('transcript reads are capped and newest first, so one keystroke cannot queue 200 storage reads', () => {
  const many = Array.from({ length: 100 }, (_, i) => chat({ id: `c${i}`, title: 'New chat', updatedAt: i }));
  const ids = transcriptsToSearch(many, 'anything', new Set(), 5);
  assert.equal(ids.length, 5);
  assert.deepEqual(ids, ['c99', 'c98', 'c97', 'c96', 'c95']);
});

test('a transcript already in hand is not fetched again, and an empty query fetches nothing', () => {
  // The query must miss both titles AND both hosts, or the chat is already a metadata match and is
  // rightly skipped — "example.com" contains an "x", which is exactly the trap here.
  const chats = [chat({ id: 'a', title: 'New chat' }), chat({ id: 'b', title: 'New chat' })];
  assert.deepEqual(transcriptsToSearch(chats, 'kingfisher', new Set(['a'])), ['b']);
  assert.deepEqual(transcriptsToSearch(chats, '', new Set()), []);
});

// ---------------------------------------------------------------------------
// The handoff: which chat the side panel opens after the dashboard's "Open"
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const handoff = (over: Partial<ChatHandoff> = {}): ChatHandoff => ({ chatId: 'wanted', host: 'example.com', at: NOW, ...over });

test('a fresh handoff for this host opens that chat instead of the most recent one', () => {
  const chats = [chat({ id: 'recent', updatedAt: 900 }), chat({ id: 'wanted', updatedAt: 100 })];
  const fallback = chats[0]!;
  const r = resolveHandoff(handoff(), 'example.com', chats, fallback, NOW + 1000);
  assert.equal(r.chat?.id, 'wanted');
  assert.equal(r.clearHandoff, true, 'the handoff is consumed so a later mount does not reopen it');
});

test('no handoff leaves the panel on whatever it would have shown', () => {
  const chats = [chat({ id: 'recent' })];
  const r = resolveHandoff(null, 'example.com', chats, chats[0]!, NOW);
  assert.equal(r.chat?.id, 'recent');
  assert.equal(r.clearHandoff, false);
});

test('a handoff for another host is left alone: that host has not seen it yet', () => {
  const chats = [chat({ id: 'here', host: 'other.com' })];
  const r = resolveHandoff(handoff({ host: 'example.com' }), 'other.com', chats, chats[0]!, NOW);
  assert.equal(r.chat?.id, 'here');
  assert.equal(r.clearHandoff, false, 'it must survive until the tab it was written for lands');
});

test('a handoff older than the TTL is ignored, but still cleared', () => {
  const chats = [chat({ id: 'recent', updatedAt: 900 }), chat({ id: 'wanted', updatedAt: 100 })];
  const r = resolveHandoff(handoff(), 'example.com', chats, chats[0]!, NOW + HANDOFF_TTL_MS + 1);
  assert.equal(r.chat?.id, 'recent', 'a stale handoff must not hijack the panel');
  assert.equal(r.clearHandoff, true);
});

test('a handoff naming a chat that has since been deleted falls back rather than showing nothing', () => {
  const chats = [chat({ id: 'recent' })];
  const r = resolveHandoff(handoff({ chatId: 'deleted' }), 'example.com', chats, chats[0]!, NOW);
  assert.equal(r.chat?.id, 'recent');
  assert.equal(r.clearHandoff, true);
});

test('an archived chat opens through a handoff: the user clicked Open on it deliberately', () => {
  // pickChatToShow would never return this one, which is exactly why the handoff has to override it.
  const chats = [chat({ id: 'wanted', updatedAt: 100, archivedAt: 200 })];
  const r = resolveHandoff(handoff(), 'example.com', chats, null, NOW);
  assert.equal(r.chat?.id, 'wanted');
  assert.equal(r.chat?.archivedAt, 200, 'opening it does not unarchive it; only sending does');
});

test('a panel with no host ignores any handoff', () => {
  assert.deepEqual(resolveHandoff(handoff(), '', [], null, NOW), { chat: null, clearHandoff: false });
});

// ---------------------------------------------------------------------------
// Where a chat reopens
// ---------------------------------------------------------------------------

test('a chat reopens on the page it was last used on', () => {
  assert.equal(chatOpenUrl({ host: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Common_kingfisher' }), 'https://en.wikipedia.org/wiki/Common_kingfisher');
});

test('a chat recorded before the url field existed falls back to its host', () => {
  assert.equal(chatOpenUrl({ host: 'news.ycombinator.com' }), 'https://news.ycombinator.com');
});

test('a non-http url is not trusted as a page to open', () => {
  assert.equal(chatOpenUrl({ host: 'example.com', url: 'javascript:alert(1)' }), 'https://example.com');
  assert.equal(chatOpenUrl({ host: 'example.com', url: '  ' }), 'https://example.com');
});

test('a chat with neither url nor host has nowhere to open, and says so with an empty string', () => {
  assert.equal(chatOpenUrl({ host: '' }), '');
});

// ---------------------------------------------------------------------------
// Bulk selection
// ---------------------------------------------------------------------------

test('a bulk action only reaches rows that are actually on screen', () => {
  // The selection survives a filter change, so it can name rows the user can no longer see.
  const visible = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(bulkTargets(new Set(['a', 'hidden', 'b']), visible), ['a', 'b']);
});

test('bulk targets are de-duplicated and hold no ids at all when nothing is visible', () => {
  assert.deepEqual(bulkTargets(['a', 'a'], [{ id: 'a' }]), ['a']);
  assert.deepEqual(bulkTargets(new Set(['a']), []), []);
});

test('select-all adds every visible row, and a second press clears them', () => {
  const visible = [{ id: 'a' }, { id: 'b' }];
  const all = toggleSelectAll(new Set(), visible);
  assert.deepEqual([...all].sort(), ['a', 'b']);
  assert.deepEqual([...toggleSelectAll(all, visible)], []);
});

test('select-all leaves rows that are filtered out exactly as they were', () => {
  const visible = [{ id: 'a' }];
  const next = toggleSelectAll(new Set(['offscreen']), visible);
  assert.deepEqual([...next].sort(), ['a', 'offscreen']);
  // And clearing only clears what is visible.
  assert.deepEqual([...toggleSelectAll(next, visible)], ['offscreen']);
});

test('select-all on an empty list is a no-op rather than a clear', () => {
  assert.deepEqual([...toggleSelectAll(new Set(['x']), [])], ['x']);
});

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

function mod(over: Partial<Mod> & { id: string }): Mod {
  return {
    name: over.id,
    description: '',
    version: '1.0.0',
    matches: [],
    excludeMatches: [],
    includeGlobs: [],
    excludeGlobs: [],
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    allFrames: false,
    grants: [],
    connect: [],
    requires: [],
    resources: [],
    source: '// ==UserScript==\n// ==/UserScript==\n',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("a mod's source is the host it was downloaded from, when it has one", () => {
  // The full hostname, with only "www." stripped: update.greasyfork.org and greasyfork.org are
  // different hosts, and collapsing subdomains would hide which one a script actually updates from.
  assert.equal(modSource(mod({ id: 'a', downloadUrl: 'https://update.greasyfork.org/scripts/123/x.user.js' })), 'update.greasyfork.org');
  assert.equal(modSource(mod({ id: 'a', downloadUrl: 'https://www.example.com/x.user.js' })), 'example.com');
});

test('a mod the model wrote is recognised by the header buildSource emits', () => {
  const written = '// ==UserScript==\n// @name        Test\n// @version     1.0\n// @grant       none\n// ==/UserScript==\n';
  assert.equal(modSource(mod({ id: 'a', source: written })), 'written in chat');
});

test('anything else with no downloadURL came in from a file or a backup', () => {
  const outside = '// ==UserScript==\n// @name Test\n// @version 3.2.1\n// @grant GM_addStyle\n// ==/UserScript==\n';
  assert.equal(modSource(mod({ id: 'a', source: outside })), 'imported');
});

test('a mod that was downloaded from an unparseable URL still says where it came from', () => {
  assert.equal(modSource(mod({ id: 'a', downloadUrl: 'not a url' })), 'not a url');
});

test('a mod\'s size counts its @require bodies, not just its own source', () => {
  const m = mod({ id: 'a', source: 'x'.repeat(100), requires: [{ url: 'u', code: 'y'.repeat(50) }] });
  assert.equal(modSize(m), 150);
});

test('sizes are formatted in the unit that reads best', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(45_000), '44 KB');
  assert.equal(formatSize(3_000_000), '2.9 MB');
});

test('the hosts a mod runs on come out of its match patterns, wildcards stripped', () => {
  assert.deepEqual(modHosts(mod({ id: 'a', matches: ['*://*.wikipedia.org/wiki/*', 'https://github.com/*'], includeGlobs: [] })), ['github.com', 'wikipedia.org']);
});

test('a mod that matches everything contributes no site to the filter', () => {
  assert.deepEqual(modHosts(mod({ id: 'a', matches: ['*://*/*'] })), []);
});

test('the site filter lists each host with how many mods run there, busiest first', () => {
  const mods = [
    mod({ id: 'a', matches: ['*://*.github.com/*'] }),
    mod({ id: 'b', matches: ['*://*.github.com/*'] }),
    mod({ id: 'c', matches: ['*://news.ycombinator.com/*'] }),
  ];
  assert.deepEqual(modSiteOptions(mods), [
    { host: 'github.com', count: 2 },
    { host: 'news.ycombinator.com', count: 1 },
  ]);
});

test('mods filter by site, by enabled state and by a text query over name, description and patterns', () => {
  const mods = [
    mod({ id: 'a', name: 'Wikipedia full width', matches: ['*://*.wikipedia.org/*'], enabled: true }),
    mod({ id: 'b', name: 'HN dark', description: 'a dark theme', matches: ['*://news.ycombinator.com/*'], enabled: false }),
  ];
  assert.deepEqual(filterMods(mods, { site: 'wikipedia.org' }).map((m) => m.id), ['a']);
  assert.deepEqual(filterMods(mods, { enabled: 'disabled' }).map((m) => m.id), ['b']);
  assert.deepEqual(filterMods(mods, { query: 'dark theme' }).map((m) => m.id), ['b']);
  assert.deepEqual(filterMods(mods, { query: 'ycombinator' }).map((m) => m.id), ['b'], 'a match pattern is searchable too');
  assert.deepEqual(filterMods(mods, { enabled: 'all', site: '', query: '' }).map((m) => m.id), ['a', 'b']);
});

test('the site filter and the enabled filter compose rather than overriding each other', () => {
  const mods = [
    mod({ id: 'a', matches: ['*://*.github.com/*'], enabled: true }),
    mod({ id: 'b', matches: ['*://*.github.com/*'], enabled: false }),
  ];
  assert.deepEqual(filterMods(mods, { site: 'github.com', enabled: 'enabled' }).map((m) => m.id), ['a']);
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

test('the overview counts enabled mods, live and archived chats, and customised sites', () => {
  const mods = [
    mod({ id: 'a', matches: ['*://*.github.com/*'], enabled: true }),
    mod({ id: 'b', matches: ['*://*.wikipedia.org/*'], enabled: true }),
    mod({ id: 'c', matches: ['*://news.ycombinator.com/*'], enabled: false }),
  ];
  const chats = [chat({ id: 'x' }), chat({ id: 'y', archivedAt: 5 }), chat({ id: 'z' })];
  assert.deepEqual(overview(mods, chats), {
    modsEnabled: 2,
    modsTotal: 3,
    chatsLive: 2,
    chatsArchived: 1,
    sitesCustomised: 2,
  });
});

test('a disabled mod does not make its site count as customised', () => {
  const o = overview([mod({ id: 'a', matches: ['*://*.github.com/*'], enabled: false })], []);
  assert.equal(o.sitesCustomised, 0);
});

test('two enabled mods on the same site count that site once', () => {
  const mods = [mod({ id: 'a', matches: ['*://*.github.com/*'] }), mod({ id: 'b', matches: ['https://github.com/*'] })];
  assert.equal(overview(mods, []).sitesCustomised, 1);
});

// ---------------------------------------------------------------------------
// Formatting and export names
// ---------------------------------------------------------------------------

test('a time label carries both the relative and the absolute form', () => {
  const t = timeLabel(NOW - 3 * 60_000, NOW);
  assert.equal(t.relative, '3m ago');
  // The exact text depends on the machine's locale and timezone, but the year is in it either way.
  // A bad Date would render as "Invalid Date" and fail here.
  assert.ok(t.absolute.includes(String(new Date(NOW - 3 * 60_000).getFullYear())), t.absolute);
  assert.equal(timeLabel(NOW, NOW).relative, 'just now');
});

test('an export filename is derived from the mod name, safely', () => {
  assert.equal(exportFilename('Wikipedia: full-width article'), 'wikipedia-full-width-article.user.js');
  assert.equal(exportFilename('  '), 'mod.user.js');
  assert.equal(exportFilename('../../etc/passwd'), 'etc-passwd.user.js', 'no path separators survive into a zip entry');
});

test('a bulk export gives two mods of the same name distinct filenames', () => {
  assert.deepEqual(exportFilenames([{ name: 'Dark' }, { name: 'Dark' }, { name: 'Dark' }]), [
    'dark.user.js',
    'dark-2.user.js',
    'dark-3.user.js',
  ]);
});

// ---------------------------------------------------------------------------
// Finding 8: a handoff dated in the future is stale, not good for minutes
// ---------------------------------------------------------------------------
//
// The old guard rejected a handoff only when it was more than a FULL TTL ahead of the reader's
// clock, so `now - at` could be anywhere in (-TTL, TTL) and pass. A handoff 90s in the future was
// honoured until the clock caught up and ran the rest of the TTL out — about three and a half
// minutes, on a timestamp that should never have been trusted at all, because a future timestamp
// means the two readings of the clock disagree.

test('finding 8: a handoff dated further ahead than the skew allowance is stale', () => {
  const chats = [chat({ id: 'recent', updatedAt: 900 }), chat({ id: 'wanted', updatedAt: 100 })];
  // 90 seconds ahead: comfortably inside the old (-TTL, TTL) window, and honoured for minutes.
  const r = resolveHandoff(handoff({ at: NOW + 90_000 }), 'example.com', chats, chats[0]!, NOW);
  assert.equal(r.chat?.id, 'recent', 'a handoff from a disagreeing clock must not hijack the panel');
  assert.equal(r.clearHandoff, true, 'and it is consumed, so it cannot hijack a later mount either');
});

test('finding 8: the future boundary is the skew allowance, to the millisecond', () => {
  const chats = [chat({ id: 'recent', updatedAt: 900 }), chat({ id: 'wanted', updatedAt: 100 })];
  // now == at - SKEW: the oldest reading still inside the allowance, honoured.
  assert.equal(
    resolveHandoff(handoff({ at: NOW + HANDOFF_SKEW_MS }), 'example.com', chats, chats[0]!, NOW).chat?.id,
    'wanted',
    'a handoff exactly at the skew allowance is still a real one',
  );
  // One millisecond further ahead: stale.
  assert.equal(
    resolveHandoff(handoff({ at: NOW + HANDOFF_SKEW_MS + 1 }), 'example.com', chats, chats[0]!, NOW).chat?.id,
    'recent',
  );
});

test('finding 8: a handoff written this instant is honoured, and one a full TTL old is not', () => {
  const chats = [chat({ id: 'recent', updatedAt: 900 }), chat({ id: 'wanted', updatedAt: 100 })];
  // age 0 — the panel mounted in the same millisecond the dashboard wrote it.
  assert.equal(resolveHandoff(handoff(), 'example.com', chats, chats[0]!, NOW).chat?.id, 'wanted');
  // age exactly TTL — the far boundary the old test did not pin down: expired, not honoured.
  assert.equal(resolveHandoff(handoff(), 'example.com', chats, chats[0]!, NOW + HANDOFF_TTL_MS).chat?.id, 'recent');
  assert.equal(resolveHandoff(handoff(), 'example.com', chats, chats[0]!, NOW + HANDOFF_TTL_MS - 1).chat?.id, 'wanted');
});

// ---------------------------------------------------------------------------
// Finding 7: the transcript sweep has to be able to finish
// ---------------------------------------------------------------------------
//
// The search effect depended on the `chats` ARRAY, which gets a fresh identity on every storage
// change — and the dashboard refreshes on any chats or mods write, so a chat running in the side
// panel rebuilds it several times a second. Every rebuild restarted the effect, every restart
// cancelled the in-flight sweep, and because the id was only recorded as fetched AFTER the
// cancellation check, the read that was in flight was re-queued and started again from scratch.
// Under sustained writes the sweep livelocked and those chats never became searchable by message
// text — the chat being written to being exactly the one that could never finish.
//
// The fix to that ordering lives in entrypoints/dashboard/ChatsSection.tsx and has no test here.
// These tests cover the pure helpers the sweep is built on.

test('finding 7: the search key ignores array identity, so a refresh alone does not restart the sweep', () => {
  const a = [chat({ id: 'a', updatedAt: 100 }), chat({ id: 'b', updatedAt: 200 })];
  // A refresh: same chats, same timestamps, brand new objects in a brand new array. This is what
  // chrome.storage.onChanged produced on every single write, including writes about mods.
  const b = [chat({ id: 'a', updatedAt: 100 }), chat({ id: 'b', updatedAt: 200 })];
  assert.equal(transcriptSearchKey(a), transcriptSearchKey(b));
  // And order is not news either: groupChatsByHost and sortChats can hand back the same chats in a
  // different order without a single transcript needing to be reread.
  assert.equal(transcriptSearchKey([...a].reverse()), transcriptSearchKey(a));
});

test('finding 7: the search key does change when a chat is added, removed or written to', () => {
  const base = [chat({ id: 'a', updatedAt: 100 }), chat({ id: 'b', updatedAt: 200 })];
  const key = transcriptSearchKey(base);
  assert.notEqual(transcriptSearchKey([...base, chat({ id: 'c', updatedAt: 300 })]), key, 'a new chat');
  assert.notEqual(transcriptSearchKey([base[0]!]), key, 'a deleted chat');
  assert.notEqual(
    transcriptSearchKey([chat({ id: 'a', updatedAt: 100 }), chat({ id: 'b', updatedAt: 999 })]),
    key,
    'a chat that gained a message',
  );
});

test('finding 7: a transcript is invalidated when its chat is written to, and only then', () => {
  const chats = [chat({ id: 'a', updatedAt: 100 }), chat({ id: 'b', updatedAt: 200 })];
  const stamps = new Map([['a', 100], ['b', 200]]);
  assert.deepEqual(staleTranscripts(chats, stamps), [], 'a plain refresh invalidates nothing');
  // Chat a gained a message: its cached text is now short by that message, so searching it would
  // miss a match the user can see on screen.
  const grown = [chat({ id: 'a', updatedAt: 300 }), chat({ id: 'b', updatedAt: 200 })];
  assert.deepEqual(staleTranscripts(grown, stamps), ['a']);
  // Chat b was deleted: its entry is dropped rather than held forever.
  assert.deepEqual(staleTranscripts([grown[0]!], stamps), ['a', 'b']);
});

test('finding 7: dropping a stale stamp is what re-queues the chat for reading', () => {
  // The two halves have to fit: invalidation removes the stamp, and transcriptsToSearch queues
  // whatever has no stamp. If invalidation only cleared the text and left the stamp, the chat would
  // be permanently unsearchable instead of merely stale.
  const chats = [chat({ id: 'a', updatedAt: 300, title: 'a' })];
  const stamps = new Map([['a', 100]]);
  assert.deepEqual(transcriptsToSearch(chats, 'needle', new Set(stamps.keys())), [], 'cached: not queued');
  for (const id of staleTranscripts(chats, stamps)) stamps.delete(id);
  assert.deepEqual(transcriptsToSearch(chats, 'needle', new Set(stamps.keys())), ['a'], 'invalidated: queued again');
});

// ---------------------------------------------------------------------------
// Finding 9: one rule closes the preview, and it cannot miss
// ---------------------------------------------------------------------------
//
// There were two mechanisms: an effect watching the chats array, and a guard in bulk() that tested
// the FILTERED selection. The guard was the weaker one and it had a real hole — bulkTargets narrows
// to the rows a search left visible, so deleting the open chat while the search box had scrolled it
// off screen never matched it. Deriving the open chat from the current data has no hole to have.

test('finding 9: the open chat is whichever one still exists', () => {
  const chats = [chat({ id: 'a', updatedAt: 100 }), chat({ id: 'b', updatedAt: 200 })];
  assert.equal(openChatOf(chats, 'a')?.id, 'a');
  assert.equal(openChatOf(chats, null), undefined, 'nothing open');
  assert.equal(openChatOf(chats, 'gone'), undefined, 'a deleted chat closes the pane by not resolving');
  assert.equal(openChatOf([], 'a'), undefined);
});

// ---------------------------------------------------------------------------
// Finding 6: an editor that does not freeze against changes underneath it
// ---------------------------------------------------------------------------
//
// The old rule derived dirtiness — `const dirty = source !== mod.source` — and skipped its sync
// effect when dirty. But the effect runs after the render that recomputed dirty against the NEW
// prop, so an editor holding the old text always looked dirty by the time the effect asked. It
// refused to adopt, kept showing the superseded source with Save lit up, and one click wrote the
// pre-update text back over the update. Dirtiness is now a flag the user's own typing sets, and
// `seen` is the source this editor last reconciled with.
//
// The editor run as a little state machine, one step per render+effect, so the ordering the bug
// lived in is actually exercised rather than assumed away.
function editor(initial: string) {
  let source = initial;
  let seen = initial;
  let dirty = false;
  let conflict: string | null = null;
  const step = (modSource: string) => {
    const what = editorSync({ modSource, seen, dirty });
    if (what === 'adopt') {
      seen = modSource;
      source = modSource;
      conflict = null;
    } else if (what === 'conflict') {
      conflict = modSource;
    }
  };
  return {
    type(next: string) { source = next; dirty = true; },
    external(next: string) { step(next); },
    loadIncoming(modSource: string) { const inc = conflict ?? modSource; seen = inc; source = inc; dirty = false; conflict = null; },
    keepMine(modSource: string) { seen = modSource; conflict = null; },
    savedAs(next: string) { seen = next; dirty = false; },
    get source() { return source; },
    get dirty() { return dirty; },
    get conflict() { return conflict; },
    /** The Save button's disabled rule, as the editor renders it. */
    get canSave() { return dirty && conflict === null; },
  };
}

test('finding 6: a clean editor adopts a version that landed underneath it', () => {
  // The exact scenario: the user typed nothing, clicked Update on the mod's row, and a new version
  // arrived. The old code kept showing v1 with Save enabled — and saving reverted the update.
  const ed = editor('// v1\nconsole.log(1);');
  ed.external('// v2\nconsole.log(2);');
  assert.equal(ed.source, '// v2\nconsole.log(2);', 'the editor shows what was actually saved');
  assert.equal(ed.dirty, false, 'and claims no edits the user never made');
  assert.equal(ed.canSave, false, 'so there is no Save click that could revert the update');
  assert.equal(ed.conflict, null, 'nothing to choose between: there were no edits to keep');
});

test('finding 6: an external change with unsaved edits keeps both and blocks Save', () => {
  const ed = editor('// v1');
  ed.type('// my edits');
  ed.external('// v2 from the side panel');
  assert.equal(ed.source, '// my edits', 'the edits in the box are not thrown away');
  assert.equal(ed.conflict, '// v2 from the side panel', 'and neither is the version that landed');
  assert.equal(ed.canSave, false, 'saving now would silently pick a winner, so it waits for a choice');
});

test('finding 6: "Load new version" takes the incoming text and clears the conflict', () => {
  const ed = editor('// v1');
  ed.type('// my edits');
  ed.external('// v2');
  ed.loadIncoming('// v2');
  assert.equal(ed.source, '// v2');
  assert.equal(ed.dirty, false);
  assert.equal(ed.conflict, null);
  assert.equal(ed.canSave, false, 'nothing left to save: the box holds exactly what is stored');
});

test('finding 6: "Keep my edits" re-enables Save and does not re-raise the same conflict', () => {
  const ed = editor('// v1');
  ed.type('// my edits');
  ed.external('// v2');
  ed.keepMine('// v2');
  assert.equal(ed.source, '// my edits');
  assert.equal(ed.canSave, true, 'the user chose; Save now writes their text over v2 deliberately');
  // The effect fires again on the next render with the same mod.source. Having marked v2 as seen,
  // it must stay quiet rather than putting the notice straight back up.
  ed.external('// v2');
  assert.equal(ed.conflict, null, 'the choice sticks');
  assert.equal(ed.canSave, true);
});

test('finding 6: after a save, the editor is clean and follows the mod again', () => {
  const ed = editor('// v1');
  ed.type('// v1 edited');
  ed.savedAs('// v1 edited');
  assert.equal(ed.dirty, false);
  assert.equal(ed.canSave, false, 'the Save button reads "Saved"');
  // And a later external change is adopted silently, because the editor is clean again.
  ed.external('// v3 from elsewhere');
  assert.equal(ed.source, '// v3 from elsewhere');
  assert.equal(ed.conflict, null);
});

test('finding 6: the sync rule itself, stated three ways', () => {
  assert.equal(editorSync({ modSource: 'a', seen: 'a', dirty: false }), 'none', 'nothing changed');
  assert.equal(editorSync({ modSource: 'a', seen: 'a', dirty: true }), 'none', 'unsaved edits, but the mod is where we left it');
  assert.equal(editorSync({ modSource: 'b', seen: 'a', dirty: false }), 'adopt');
  assert.equal(editorSync({ modSource: 'b', seen: 'a', dirty: true }), 'conflict');
});

test('finding 9: a chat merely filtered off screen stays open', () => {
  // The other half: filtered out is not deleted. The preview must keep showing a chat the search
  // box is hiding, because the user opened it deliberately and it still exists.
  const chats = [chat({ id: 'a', title: 'aardvark', updatedAt: 100 }), chat({ id: 'b', title: 'zebra', updatedAt: 200 })];
  const matching = searchChats(chats, 'zebra');
  assert.equal(matching.some((c) => c.id === 'a'), false, 'a is off screen');
  assert.equal(openChatOf(chats, 'a')?.id, 'a', 'but still open, because the rule reads the full list');
});
