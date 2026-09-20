// Regression tests for the background worker's pure helpers. The worker itself needs chrome APIs,
// so each fix keeps its decision in a small module under lib/ that runs here with no browser.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendTurn } from '../lib/chats.ts';
import { checkConnect, connectFromSource, connectOf, hostsFromMatchPatterns } from '../lib/connect.ts';
import { isInstallableUrl, isUserScriptUrl, scriptIdentity, scriptUrlFromLocation } from '../lib/installurl.ts';
import { findByName, sameModName } from '../lib/modmatch.ts';
import { resyncPlan } from '../lib/resync.ts';
import { compareVersions, shouldUpdate } from '../lib/version.ts';
import { summarizeImport } from '../lib/importreport.ts';
import type { Mod, Msg } from '../lib/types.ts';

// ---------- 1: the install page takes its URL from the fragment, verbatim ----------

test('finding 1: a url= parameter inside the script URL cannot hijack the install page', () => {
  // The attack: a .user.js whose own query string carries a second `url=` pointing at a script the
  // user trusts. The redirect puts the whole matched URL after '#', and everything there is the URL.
  const attacker = 'https://evil.example/pwn.user.js?x=1&url=https://greasyfork.org/scripts/1-good.user.js';
  assert.equal(scriptUrlFromLocation({ hash: `#${attacker}`, search: '' }), attacker);
  // Even with a query string on the install page itself, the fragment wins.
  assert.equal(scriptUrlFromLocation({ hash: `#${attacker}`, search: '?url=https://greasyfork.org/good.user.js' }), attacker);
});

test('finding 1: a script URL keeps its own fragment, because nothing is parsed out of it', () => {
  const withHash = 'https://example.com/a.user.js?v=2#section';
  assert.equal(scriptUrlFromLocation({ hash: `#${withHash}` }), withHash);
});

test('finding 1: the legacy ?url= form still works, and an empty location gives nothing', () => {
  assert.equal(scriptUrlFromLocation({ search: '?url=https%3A%2F%2Fe.com%2Fa.user.js' }), 'https://e.com/a.user.js');
  assert.equal(scriptUrlFromLocation({ hash: '#', search: '' }), '');
  assert.equal(scriptUrlFromLocation({}), '');
});

test('finding 1: only http(s) URLs are installable', () => {
  assert.equal(isInstallableUrl('https://example.com/a.user.js'), true);
  assert.equal(isInstallableUrl('http://example.com/a.user.js'), true);
  assert.equal(isInstallableUrl('javascript:alert(1)//a.user.js'), false);
  assert.equal(isInstallableUrl('data:text/javascript,alert(1)'), false);
  assert.equal(isInstallableUrl('file:///tmp/a.user.js'), false);
  assert.equal(isInstallableUrl('not a url'), false);
});

test('finding 1: the Safari navigation watcher matches what the redirect rule would have matched', () => {
  // iOS Safari stores the declarativeNetRequest rule, reports no error against it, and still shows
  // the raw script text. The background watches navigations there instead, and has to reach the
  // same verdict the rule's regexFilter would have reached.
  assert.equal(isUserScriptUrl('https://example.com/a.user.js'), true);
  assert.equal(isUserScriptUrl('http://example.com/a.user.js'), true);
  assert.equal(isUserScriptUrl('https://example.com/a.user.js?v=2'), true);
  assert.equal(isUserScriptUrl('https://example.com/a.user.js#top'), true);
  assert.equal(isUserScriptUrl('https://example.com/A.USER.JS'), true);
  // The install page carries the script URL in its own fragment. If that counted as a userscript
  // navigation the watcher would redirect the install page to itself, forever.
  assert.equal(isUserScriptUrl('safari-web-extension://a1b2/install.html#https://e.com/a.user.js'), false);
  assert.equal(isUserScriptUrl('https://example.com/a.user.js.html'), false);
  assert.equal(isUserScriptUrl('https://example.com/?x=a.user.js'), false);
  assert.equal(isUserScriptUrl('https://example.com/page#a.user.js'), false);
  assert.equal(isUserScriptUrl(''), false);
});

// ---------- 4: a provider error must not discard the chat ----------

const msg = (role: 'user' | 'assistant', text: string): Msg => ({ role, content: [{ type: 'text', text }] });

test('finding 4: a failed run keeps the existing history and records the turn that failed', () => {
  const history = [msg('user', 'first'), msg('assistant', 'reply')];
  const saved = appendTurn(history, { text: 'the turn that hit a 429' });
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.slice(0, 2), history, 'pre-existing history is never dropped');
  assert.equal(saved[2]!.role, 'user');
  assert.equal((saved[2]!.content[0] as { text: string }).text, 'the turn that hit a 429');
});

test('finding 4: retrying the same turn after a failure does not duplicate it', () => {
  const once = appendTurn([msg('user', 'a')], { text: 'boom' });
  assert.deepEqual(appendTurn(once, { text: 'boom' }), once);
  // An empty turn adds nothing, but the history still survives.
  assert.deepEqual(appendTurn(once, { text: '   ' }), once);
});

// ---------- 8 / C1: @connect gates GM_xmlhttpRequest ----------

const MATCHES = ['*://*.example.com/*', 'https://site.test/path/*'];

test('finding 8: an exact @connect host is allowed, and so are its subdomains', () => {
  assert.equal(checkConnect('https://api.example.org/v1', ['api.example.org'], []).allowed, true);
  assert.equal(checkConnect('https://eu.api.example.org/v1', ['api.example.org'], []).allowed, true);
  // A sibling that merely ends in the same letters is not a subdomain.
  assert.equal(checkConnect('https://evilapi.example.org/', ['api.example.org'], []).allowed, false);
  // And the other direction: a parent is not covered by a child entry.
  assert.equal(checkConnect('https://example.org/', ['api.example.org'], []).allowed, false);
});

test('finding 8: @connect * allows anything', () => {
  assert.equal(checkConnect('https://anywhere.test/x', ['*'], []).allowed, true);
  assert.equal(checkConnect('http://10.0.0.1:8080/x', ['*'], []).allowed, true);
});

test('finding 8: @connect self resolves through the script’s own @match hosts', () => {
  assert.equal(checkConnect('https://example.com/api', ['self'], MATCHES).allowed, true);
  assert.equal(checkConnect('https://cdn.example.com/api', ['self'], MATCHES).allowed, true, 'wildcard match host covers subdomains');
  assert.equal(checkConnect('https://site.test/x', ['self'], MATCHES).allowed, true);
  assert.equal(checkConnect('https://other.test/x', ['self'], MATCHES).allowed, false);
  // Without "self", matching a site does not grant access to it.
  assert.equal(checkConnect('https://example.com/api', [], MATCHES).allowed, false);
});

test('finding 8: a script matching every site gains nothing from self', () => {
  assert.equal(checkConnect('https://anything.test/x', ['self'], ['*://*/*']).allowed, false);
  assert.deepEqual(hostsFromMatchPatterns(['*://*/*', 'https://a.test/*', '*://*.b.test/*']), ['a.test', 'b.test']);
});

test('finding 8: IPs, ports and localhost', () => {
  assert.equal(checkConnect('http://localhost:11434/api', ['localhost'], []).allowed, true);
  assert.equal(checkConnect('http://127.0.0.1:8080/x', ['127.0.0.1'], []).allowed, true);
  assert.equal(checkConnect('http://127.0.0.2/x', ['127.0.0.1'], []).allowed, false);
  // A port on the @connect entry is ignored: Tampermonkey matches hosts, not ports.
  assert.equal(checkConnect('https://api.test/x', ['api.test:443'], []).allowed, true);
  assert.equal(checkConnect('http://localhost:11434/api', ['self'], ['http://localhost:11434/*']).allowed, true);
});

test('finding 8: a rejection names the host and says how to allow it', () => {
  const r = checkConnect('https://tracker.evil/collect', ['api.example.org'], MATCHES);
  assert.equal(r.allowed, false);
  assert.ok(r.reason!.includes('tracker.evil'), 'names the host that was refused');
  assert.ok(r.reason!.includes('@connect tracker.evil'), 'says exactly what to add');
});

test('finding 8: non-http schemes are refused outright', () => {
  assert.equal(checkConnect('file:///etc/passwd', ['*'], []).allowed, false);
  assert.equal(checkConnect('nonsense', ['*'], []).allowed, false);
});

test('finding 8: @connect is read from the header when the stored mod predates the field', () => {
  const source = `// ==UserScript==
// @name     X
// @connect  api.example.org
// @connect  self
// ==/UserScript==
void 0;`;
  assert.deepEqual(connectFromSource(source), ['api.example.org', 'self']);
  assert.deepEqual(connectOf({ source }), ['api.example.org', 'self']);
  // CONTRACT C1: the field on the mod wins where it is present.
  assert.deepEqual(connectOf({ connect: ['*'], source }), ['*']);
  assert.deepEqual(connectOf(undefined), []);
});

// ---------- 9: backup dedupe identity ----------

test('finding 9: a new version of the same script is the same script, not a second copy', () => {
  const v1 = { downloadUrl: 'https://example.com/a.user.js', raw: { name: ['A'], namespace: ['ns'], version: ['1.0'] } };
  const v2 = { downloadUrl: 'https://example.com/a.user.js', raw: { name: ['A'], namespace: ['ns'], version: ['2.0'] } };
  assert.equal(scriptIdentity(v1), scriptIdentity(v2), 'version is not part of identity');
});

test('finding 9: without a download URL, identity is @namespace + @name', () => {
  const a = { raw: { name: ['Helper'], namespace: ['https://alice.example/'] } };
  const b = { raw: { name: ['Helper'], namespace: ['https://bob.example/'] } };
  assert.equal(scriptIdentity(a), scriptIdentity({ raw: { name: ['Helper'], namespace: ['https://alice.example/'] } }));
  assert.notEqual(scriptIdentity(a), scriptIdentity(b), 'same name from different authors stays distinct');
  // A download URL outranks the namespace pair.
  assert.notEqual(scriptIdentity({ ...a, downloadUrl: 'https://x.test/a.user.js' }), scriptIdentity(a));
});

test('finding 9: an updated duplicate is reported as updated, not silently skipped', () => {
  const s = summarizeImport({ imported: 2, skipped: ['A (already installed — updated values)', 'B (no userscript source)'] });
  assert.ok(s.includes('Imported 2 scripts.'));
  assert.ok(s.includes('Updated 1 already installed.'), 'the duplicate is accounted for');
  assert.ok(s.includes('Skipped: B (no userscript source)'), 'genuine failures are still named');
  assert.ok(!s.includes('Skipped: A'), 'an updated script is not listed as skipped');
  assert.equal(summarizeImport({ imported: 1, skipped: [] }), 'Imported 1 script.');
});

// ---------- 10: re-saving a proposal updates the mod in place ----------

const mod = (over: Partial<Mod>): Mod =>
  ({ id: 'id', name: 'n', updatedAt: 0, source: '', matches: [], includeGlobs: [], ...over }) as Mod;

test('finding 10: a re-saved proposal finds the mod it revises by name', () => {
  const mods = [mod({ id: 'a', name: 'Full width', updatedAt: 10 }), mod({ id: 'b', name: 'Dark mode', updatedAt: 20 })];
  assert.equal(findByName(mods, 'Full width')?.id, 'a');
  assert.equal(findByName(mods, '  full WIDTH '), mods[0], 'names compare trimmed and case-insensitively');
  assert.equal(findByName(mods, 'Something else'), undefined, 'a genuinely new mod gets a new id');
  // Duplicates from before the fix: the most recently updated one keeps winning.
  const dupes = [mod({ id: 'old', name: 'X', updatedAt: 1 }), mod({ id: 'new', name: 'X', updatedAt: 99 })];
  assert.equal(findByName(dupes, 'X')?.id, 'new');
  assert.equal(sameModName('', ''), false, 'an empty name matches nothing');
});

// ---------- 14: ordinal version comparison ----------

test('finding 14: versions compare ordinally, not as strings', () => {
  // The bug string equality hid: 1.10 is newer than 1.9, but "1.10" < "1.9" as text.
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('2.0', '10.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0, 'missing trailing parts are zero');
  assert.equal(compareVersions('v2.1', '2.1'), 0, 'a leading v is ignored');
  // Pre-release suffixes sort below the release they lead to.
  assert.equal(compareVersions('1.0', '1.0-beta'), 1);
  assert.equal(compareVersions('1.0-beta.1', '1.0-beta.2'), -1);
  assert.equal(compareVersions('1.0-alpha', '1.0-beta'), -1);
});

test('finding 14: an update only replaces the installed script when it is genuinely newer', () => {
  const cur = { version: '1.9', source: 'old' };
  assert.equal(shouldUpdate(cur, { version: '1.10', source: 'new' }), true);
  assert.equal(shouldUpdate(cur, { version: '1.9', source: 'new' }), false, 'same version does not overwrite');
  assert.equal(shouldUpdate(cur, { version: '1.8', source: 'new' }), false, 'a downgrade does not overwrite');
});

test('finding 14: with no version to compare, the source text decides', () => {
  assert.equal(shouldUpdate({ version: '', source: 'a' }, { version: '', source: 'b' }), true);
  assert.equal(shouldUpdate({ version: '', source: 'a' }, { version: '', source: 'a\n' }), false, 'whitespace-only change is not an update');
  assert.equal(shouldUpdate({ version: '1.0', source: 'a' }, { version: '', source: 'b' }), true);
  assert.equal(shouldUpdate({ version: '1.0', source: 'a' }, { version: '', source: 'a' }), false);
});

// ---------- 15: a value write re-registers one mod, not all of them ----------

test('finding 15: a GM value write updates only that mod’s registration', () => {
  assert.equal(resyncPlan({ enabled: true }, true), 'one', 'the common case touches one script');
  // A mod that should be registered but is not needs the full sync to put it back.
  assert.equal(resyncPlan({ enabled: true }, false), 'full');
  // Disabled or deleted while the debounce was pending: only the full sync can drop a registration.
  assert.equal(resyncPlan({ enabled: false }, true), 'full');
  assert.equal(resyncPlan(undefined, true), 'full');
  // Nothing registered and nothing that should be: no work at all.
  assert.equal(resyncPlan({ enabled: false }, false), 'none');
  assert.equal(resyncPlan(undefined, false), 'none');
});
