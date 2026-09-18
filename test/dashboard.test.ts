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
  exportFilename,
  exportFilenames,
  filterMods,
  formatSize,
  groupChatsByHost,
  HANDOFF_TTL_MS,
  modHosts,
  modSiteOptions,
  modSize,
  modSource,
  overview,
  resolveHandoff,
  searchChats,
  timeLabel,
  toggleSelectAll,
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

test('a handoff right at the TTL boundary is still honoured', () => {
  const chats = [chat({ id: 'recent', updatedAt: 900 }), chat({ id: 'wanted', updatedAt: 100 })];
  assert.equal(resolveHandoff(handoff(), 'example.com', chats, chats[0]!, NOW + HANDOFF_TTL_MS - 1).chat?.id, 'wanted');
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

test('a handoff dated in the future (a clock jump) is treated as stale, not as valid forever', () => {
  const chats = [chat({ id: 'recent', updatedAt: 900 }), chat({ id: 'wanted', updatedAt: 100 })];
  const r = resolveHandoff(handoff({ at: NOW + 10 * HANDOFF_TTL_MS }), 'example.com', chats, chats[0]!, NOW);
  assert.equal(r.chat?.id, 'recent');
  assert.equal(r.clearHandoff, true);
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
  assert.ok(t.absolute.length > 0);
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
