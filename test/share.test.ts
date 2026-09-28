// Sharing a mod to a gist or Greasy Fork: the URL parsers, the version bump, the header rewrite,
// what gets remembered, and which page load means what (lib/share.ts). Plus the install side:
// a gist raw URL is an ordinary .user.js install, and a mod shared as a gist can Update from it.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { reheaderFields } from '../lib/artifact.ts';
import { exportFilename } from '../lib/dashboard.ts';
import { previewFromUrl, reparseEditedSource } from '../lib/install.ts';
import { installPageUrl, isUserScriptUrl, scriptUrlFromLocation } from '../lib/installurl.ts';
import { modFromSource, parseHeader } from '../lib/mods.ts';
import {
  bumpPatch,
  gistEditUrl,
  gistRawUrl,
  greasyForkMissing,
  greasyForkNewVersionUrl,
  isGistEditUrl,
  isGistNewUrl,
  isGistPage,
  isGitHubSignIn,
  isGreasyForkPostForm,
  isGreasyForkScriptPage,
  isGreasyForkSignIn,
  latestGistRawUrl,
  parseGistRawUrl,
  parseGistUrl,
  parseGreasyForkScriptUrl,
  pickGistFile,
  prepareShare,
  recordGist,
  recordGreasyFork,
  shareFileName,
  shareMenuLabels,
  shareStep,
  GIST_NEW_URL,
  GREASYFORK_NEW_URL,
} from '../lib/share.ts';
import { shouldUpdate } from '../lib/version.ts';
import type { Mod } from '../lib/types';

const ID = 'c5e8506a7c32169843d0373f710dfb02';
const SHA = '2a2b898e9d3aec9072e9a18939d514e2702bf123';

const SOURCE = [
  '// ==UserScript==',
  '// @name         Wide Wiki',
  '// @name:fr      Wiki large',
  '// @namespace    https://example.com/ns',
  '// @version      1.2.3',
  '// @description  Lets articles use the whole window.',
  '// @match        *://*.wikipedia.org/*',
  '// @grant        GM_addStyle',
  '// @require      https://cdn.example.com/lib.js',
  '// ==/UserScript==',
  '',
  "GM_addStyle('.x { max-width: none }');",
  '',
].join('\n');

function mod(over: Partial<Mod> = {}): Mod {
  return { ...modFromSource(over.source ?? SOURCE), ...over };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

test('gist page URLs parse, and the site’s own pages are not gists', () => {
  assert.deepEqual(parseGistUrl(`https://gist.github.com/KillaMeep/${ID}`), { user: 'KillaMeep', id: ID, rest: '' });
  assert.deepEqual(parseGistUrl(`https://gist.github.com/KillaMeep/${ID}/edit`), { user: 'KillaMeep', id: ID, rest: 'edit' });
  assert.equal(parseGistUrl(`https://gist.github.com/KillaMeep/${ID}?foo=1#file-x`)?.rest, '');
  for (const u of [
    'https://gist.github.com/',
    'https://gist.github.com/starred',
    `https://gist.github.com/starred/${ID}`,
    `https://gist.github.com/search/${ID}`,
    'https://gist.github.com/KillaMeep',
    'https://gist.github.com/KillaMeep/not-a-hex-id',
    `http://gist.github.com/KillaMeep/${ID}`,
    `https://github.com/KillaMeep/${ID}`,
    'not a url',
  ]) {
    assert.equal(parseGistUrl(u), null, u);
  }
  assert.equal(isGistPage(`https://gist.github.com/u/${ID}`), true);
  assert.equal(isGistPage(`https://gist.github.com/u/${ID}/edit`), false);
  assert.equal(isGistEditUrl(`https://gist.github.com/u/${ID}/edit`), true);
  assert.equal(isGistNewUrl('https://gist.github.com/'), true);
  assert.equal(isGistNewUrl('https://gist.github.com/new'), true);
  assert.equal(isGistNewUrl(`https://gist.github.com/u/${ID}`), false);
  assert.equal(gistEditUrl('u', ID), `https://gist.github.com/u/${ID}/edit`);
});

test('the install link is the raw URL with no revision, so it always serves the latest', () => {
  assert.equal(gistRawUrl('u', ID, 'wide-wiki.user.js'), `https://gist.githubusercontent.com/u/${ID}/raw/wide-wiki.user.js`);
  // A file name with a space survives the round trip.
  const spaced = gistRawUrl('u', ID, 'Hide USU.user.js');
  assert.equal(spaced, `https://gist.githubusercontent.com/u/${ID}/raw/Hide%20USU.user.js`);
  assert.deepEqual(parseGistRawUrl(spaced), { user: 'u', id: ID, fileName: 'Hide USU.user.js' });
  // The Raw button's form, pinned to a revision, on either host.
  assert.deepEqual(parseGistRawUrl(`https://gist.github.com/u/${ID}/raw/${SHA}/x.user.js`), { user: 'u', id: ID, sha: SHA, fileName: 'x.user.js' });
  assert.equal(latestGistRawUrl(`https://gist.githubusercontent.com/u/${ID}/raw/${SHA}/x.user.js`), `https://gist.githubusercontent.com/u/${ID}/raw/x.user.js`);
  assert.equal(parseGistRawUrl(`https://gist.githubusercontent.com/u/${ID}/x.user.js`), null);
  assert.equal(parseGistRawUrl('https://raw.githubusercontent.com/u/r/main/x.user.js'), null);
});

test('Greasy Fork script, form and sign-in URLs', () => {
  assert.deepEqual(parseGreasyForkScriptUrl('https://greasyfork.org/en/scripts/19993-ru-adlist-js-fixes'), { id: '19993', slug: 'ru-adlist-js-fixes', rest: '' });
  assert.deepEqual(parseGreasyForkScriptUrl('https://greasyfork.org/zh-CN/scripts/19993'), { id: '19993', slug: '', rest: '' });
  assert.deepEqual(parseGreasyForkScriptUrl('https://greasyfork.org/scripts/19993-x/versions/new'), { id: '19993', slug: 'x', rest: 'versions/new' });
  assert.equal(parseGreasyForkScriptUrl('https://greasyfork.org/en/scripts'), null);
  assert.equal(parseGreasyForkScriptUrl('https://greasyfork.org/en/scripts/by-site/x.com'), null);
  assert.equal(parseGreasyForkScriptUrl('https://sleazy.example/en/scripts/1-x'), null);
  assert.equal(isGreasyForkScriptPage('https://greasyfork.org/en/scripts/424242-wide-wiki'), true);
  assert.equal(isGreasyForkScriptPage('https://greasyfork.org/en/scripts/424242-wide-wiki/code'), false);
  assert.equal(isGreasyForkPostForm(GREASYFORK_NEW_URL), true);
  assert.equal(isGreasyForkPostForm(greasyForkNewVersionUrl('424242')), true);
  assert.equal(isGreasyForkPostForm('https://greasyfork.org/en/script_versions'), false, 'the POST target re-rendering errors is not the empty form');
  assert.equal(isGreasyForkSignIn('https://greasyfork.org/en/users/sign_in?return_to=x'), true);
  assert.equal(isGitHubSignIn('https://github.com/login?return_to=https%3A%2F%2Fgist.github.com%2F'), true);
  assert.equal(isGitHubSignIn('https://gist.github.com/auth/github?return_to=x'), true);
  assert.equal(isGitHubSignIn(`https://gist.github.com/u/${ID}`), false);
});

// ---------------------------------------------------------------------------
// Versions and headers
// ---------------------------------------------------------------------------

test('bumpPatch moves the patch, and starts at 1.0.0 with nothing to bump', () => {
  assert.equal(bumpPatch('1.2.3'), '1.2.4');
  assert.equal(bumpPatch('1.0'), '1.0.1');
  assert.equal(bumpPatch('7'), '7.0.1');
  assert.equal(bumpPatch('2026.1.19'), '2026.1.20');
  assert.equal(bumpPatch('v1.2.9'), '1.2.10');
  assert.equal(bumpPatch(''), '1.0.0');
  assert.equal(bumpPatch('beta'), '1.0.0');
  // A pre-release moves to its release, which already orders above it.
  assert.equal(bumpPatch('1.2.0-beta.2'), '1.2.0');
  for (const v of ['1.2.3', '1.0', '7', '2026.1.19', '1.2.0-beta.2', '1.2.3.4']) {
    assert.ok(shouldUpdate({ version: v, source: 'a' }, { version: bumpPatch(v), source: 'b' }), `${bumpPatch(v)} must be newer than ${v}`);
  }
});

test('reheaderFields rewrites one key in place and keeps every other line', () => {
  const out = reheaderFields(SOURCE, { version: '1.2.4', updateURL: 'https://u.example/x.user.js', downloadURL: 'https://u.example/x.user.js' });
  const before = SOURCE.split('\n');
  const after = out.split('\n');
  assert.equal(after.find((l) => l.includes('@version')), '// @version      1.2.4');
  // Added keys go in before the fence, aligned with @name's column.
  const fence = after.indexOf('// ==/UserScript==');
  assert.equal(after[fence - 2], '// @updateURL    https://u.example/x.user.js');
  assert.equal(after[fence - 1], '// @downloadURL  https://u.example/x.user.js');
  // Nothing else moved: the locale variant, the require, the grant, the body.
  for (const l of before) if (!l.includes('@version')) assert.ok(after.includes(l), `lost: ${l}`);
  const h = parseHeader(out);
  assert.equal(h.updateUrl, 'https://u.example/x.user.js');
  assert.equal(h.downloadUrl, 'https://u.example/x.user.js');
  assert.deepEqual(h.requires, ['https://cdn.example.com/lib.js']);
  assert.deepEqual(h.raw['name'], ['Wide Wiki', 'Wiki large']);
});

test('reheaderFields replaces an existing value, drops duplicates, removes on null, ignores headerless text', () => {
  const src = SOURCE.replace('// ==/UserScript==', '// @downloadURL https://old.example/a.user.js\n// @downloadURL https://older.example/a.user.js\n// ==/UserScript==');
  const out = reheaderFields(src, { downloadURL: 'https://new.example/a.user.js' });
  assert.equal(parseHeader(out).raw['downloadURL']?.length, 1);
  assert.equal(parseHeader(out).downloadUrl, 'https://new.example/a.user.js');
  const removed = reheaderFields(out, { downloadURL: null });
  assert.equal(parseHeader(removed).downloadUrl, undefined);
  assert.equal(reheaderFields('console.log(1)', { version: '1.0.0' }), 'console.log(1)');
  // A locale-suffixed key is its own key, never rewritten as the bare one.
  assert.ok(reheaderFields(SOURCE, { name: 'X' }).includes('// @name:fr      Wiki large'));
});

test('the shared file is named exactly as Download names it', () => {
  for (const n of ['Wide Wiki', 'GitHub: wider diffs', '..weird  name!!', '', 'Ünïcode ✓']) assert.equal(shareFileName(n), exportFilename(n));
});

test('Greasy Fork’s expected header lines', () => {
  assert.deepEqual(greasyForkMissing(SOURCE), ['license']);
  const bare = '// ==UserScript==\n// @name X\n// @match *://x.com/*\n// ==/UserScript==\n';
  assert.deepEqual(greasyForkMissing(bare), ['namespace', 'version', 'description', 'license']);
  assert.deepEqual(greasyForkMissing(bare.replace('@match', '@include')), ['namespace', 'version', 'description', 'license']);
});

// ---------------------------------------------------------------------------
// prepareShare: what goes on the site
// ---------------------------------------------------------------------------

test('a first gist share keeps the version, adds 1.0.0 when there is none, and opens the new-gist form', () => {
  const p = prepareShare(mod(), 'gist');
  assert.equal(p.mode, 'new');
  assert.equal(p.version, '1.2.3');
  assert.equal(p.source, SOURCE);
  assert.equal(p.fileName, 'wide-wiki.user.js');
  assert.equal(p.description, 'Lets articles use the whole window.');
  assert.equal(p.openUrl, GIST_NEW_URL);
  const unversioned = mod({ source: SOURCE.replace('// @version      1.2.3\n', '') });
  const q = prepareShare(unversioned, 'gist');
  assert.equal(q.version, '1.0.0');
  assert.equal(parseHeader(q.source).version, '1.0.0');
});

test('Update gist bumps the patch and opens that gist’s edit page, keeping the file name it has', () => {
  const shared = recordGist(mod(), { user: 'u', id: ID, fileName: 'my-old-name.user.js' }, 1);
  const p = prepareShare(shared, 'gist');
  assert.equal(p.mode, 'update');
  assert.equal(p.previousVersion, '1.2.3');
  assert.equal(p.version, '1.2.4');
  assert.equal(parseHeader(p.source).version, '1.2.4');
  assert.equal(p.openUrl, `https://gist.github.com/u/${ID}/edit`);
  assert.equal(p.fileName, 'my-old-name.user.js');
  // forceNew: the remembered gist is gone; share afresh, under the mod's own name.
  const fresh = prepareShare(shared, 'gist', { forceNew: true });
  assert.equal(fresh.mode, 'new');
  assert.equal(fresh.openUrl, GIST_NEW_URL);
  assert.equal(fresh.fileName, 'wide-wiki.user.js');
});

test('Greasy Fork: header lines are added only when asked, and a second post is a new version', () => {
  const plain = prepareShare(mod(), 'greasyfork');
  assert.deepEqual(plain.missing, ['license']);
  assert.equal(parseHeader(plain.source).raw['license'], undefined);
  const withLicense = prepareShare(mod(), 'greasyfork', { addLicense: true });
  assert.deepEqual(withLicense.missing, []);
  assert.deepEqual(parseHeader(withLicense.source).raw['license'], ['MIT']);
  assert.equal(withLicense.openUrl, GREASYFORK_NEW_URL);
  const noNs = mod({ source: SOURCE.replace('// @namespace    https://example.com/ns\n', '') });
  assert.deepEqual(parseHeader(prepareShare(noNs, 'greasyfork', { addNamespace: true }).source).raw['namespace'], ['usermods']);
  // An existing namespace is never replaced.
  assert.deepEqual(parseHeader(prepareShare(mod(), 'greasyfork', { addNamespace: true }).source).raw['namespace'], ['https://example.com/ns']);
  const posted = recordGreasyFork(mod(), 'https://greasyfork.org/en/scripts/424242-wide-wiki?locale_override=1', 5);
  assert.deepEqual(posted.share?.greasyFork, { url: 'https://greasyfork.org/en/scripts/424242-wide-wiki', id: '424242', savedAt: 5 });
  const next = prepareShare(posted, 'greasyfork');
  assert.equal(next.mode, 'update');
  assert.equal(next.version, '1.2.4');
  assert.equal(next.openUrl, 'https://greasyfork.org/en/scripts/424242/versions/new');
  assert.deepEqual(shareMenuLabels(posted), { gist: 'Share as Gist', greasyFork: 'Post new version on Greasy Fork' });
  assert.deepEqual(shareMenuLabels(recordGist(posted, { user: 'u', id: ID, fileName: 'w.user.js' })), { gist: 'Update gist', greasyFork: 'Post new version on Greasy Fork' });
});

// ---------------------------------------------------------------------------
// What is remembered
// ---------------------------------------------------------------------------

test('recording a gist sets @updateURL and @downloadURL to the raw link, and bumps nothing', () => {
  const m = mod();
  const r = recordGist(m, { user: 'u', id: ID, fileName: 'wide-wiki.user.js' }, 42);
  const raw = `https://gist.githubusercontent.com/u/${ID}/raw/wide-wiki.user.js`;
  assert.deepEqual(r.share?.gist, { url: `https://gist.github.com/u/${ID}`, user: 'u', id: ID, fileName: 'wide-wiki.user.js', rawUrl: raw, savedAt: 42 });
  assert.equal(r.downloadUrl, raw);
  const h = parseHeader(r.source);
  assert.equal(h.updateUrl, raw);
  assert.equal(h.downloadUrl, raw);
  assert.equal(h.version, '1.2.3');
  assert.equal(r.id, m.id);
  assert.equal(r.enabled, m.enabled);
});

test('the share record survives an edit, an update from the download URL and an old mod without one', () => {
  const shared = recordGist(mod(), { user: 'u', id: ID, fileName: 'wide-wiki.user.js' });
  const edited = reparseEditedSource(shared, shared.source.replace("max-width: none", 'max-width: 90vw'));
  assert.deepEqual(edited.share, shared.share);
  // What updateMod does: installSource(source, { existing }) → modFromSource(source, existing).
  const updated = modFromSource(shared.source.replace('1.2.3', '1.2.4'), shared);
  assert.deepEqual(updated.share, shared.share);
  assert.equal(updated.downloadUrl, shared.downloadUrl);
  // Stored before sharing existed: no field at all, and nothing breaks.
  const { share: _none, ...legacy } = mod();
  assert.equal(prepareShare(legacy as Mod, 'gist').mode, 'new');
});

test('which saved file is the script: the one filled in, else the only .user.js', () => {
  assert.equal(pickGistFile(['README.md', 'wide-wiki.user.js'], 'wide-wiki.user.js'), 'wide-wiki.user.js');
  assert.equal(pickGistFile(['README.md', 'renamed.user.js'], 'wide-wiki.user.js'), 'renamed.user.js');
  assert.equal(pickGistFile([], 'wide-wiki.user.js'), null);
});

// ---------------------------------------------------------------------------
// The tab, one load at a time
// ---------------------------------------------------------------------------

test('shareStep: a new gist is filled, waits for sign-in, and records what the save lands on', () => {
  const s = { target: 'gist' as const, mode: 'new' as const, phase: 'opening' as const };
  assert.deepEqual(shareStep(s, 'https://gist.github.com/'), { kind: 'fill' });
  assert.deepEqual(shareStep(s, 'https://github.com/login?return_to=%2F'), { kind: 'signin' });
  // Not filled yet: a gist page is somewhere the user wandered, not the result.
  assert.deepEqual(shareStep(s, `https://gist.github.com/u/${ID}`), { kind: 'wait' });
  const filled = { ...s, phase: 'filled' as const };
  assert.deepEqual(shareStep(filled, 'https://gist.github.com/'), { kind: 'wait' }, 'a reload of the filled form is not refilled over the user’s edits');
  assert.deepEqual(shareStep(filled, `https://gist.github.com/u/${ID}`), { kind: 'record-gist', user: 'u', id: ID });
  assert.deepEqual(shareStep({ ...s, phase: 'fallback' }, `https://gist.github.com/u/${ID}`), { kind: 'record-gist', user: 'u', id: ID });
  assert.deepEqual(shareStep(filled, 'https://example.com/'), { kind: 'abandon' });
});

test('shareStep: an update fills only its own gist’s edit page and records only its own gist', () => {
  const s = { target: 'gist' as const, mode: 'update' as const, phase: 'opening' as const, gist: { user: 'u', id: ID } };
  assert.deepEqual(shareStep(s, `https://gist.github.com/u/${ID}/edit`), { kind: 'fill' });
  assert.deepEqual(shareStep(s, 'https://gist.github.com/'), { kind: 'wait' });
  const other = 'f'.repeat(32);
  assert.deepEqual(shareStep({ ...s, phase: 'filled' }, `https://gist.github.com/u/${other}`), { kind: 'wait' });
  assert.deepEqual(shareStep({ ...s, phase: 'filled' }, `https://gist.github.com/u/${ID}`), { kind: 'record-gist', user: 'u', id: ID });
});

test('shareStep: Greasy Fork', () => {
  const s = { target: 'greasyfork' as const, mode: 'new' as const, phase: 'opening' as const };
  assert.deepEqual(shareStep(s, GREASYFORK_NEW_URL), { kind: 'fill' });
  assert.deepEqual(shareStep(s, 'https://greasyfork.org/en/users/sign_in'), { kind: 'signin' });
  const filled = { ...s, phase: 'filled' as const };
  assert.deepEqual(shareStep(filled, 'https://greasyfork.org/en/script_versions'), { kind: 'wait' });
  assert.deepEqual(shareStep(filled, 'https://greasyfork.org/en/scripts/424242-wide-wiki'), { kind: 'record-greasyfork', url: 'https://greasyfork.org/en/scripts/424242-wide-wiki' });
  assert.deepEqual(shareStep(filled, 'https://gist.github.com/'), { kind: 'abandon' });
});

// ---------------------------------------------------------------------------
// Installing from the link, and updating from it
// ---------------------------------------------------------------------------

test('a gist raw URL is an ordinary .user.js install: redirected, carried in the fragment, previewed', async () => {
  const raw = gistRawUrl('u', ID, 'wide-wiki.user.js');
  assert.equal(isUserScriptUrl(raw), true);
  assert.equal(isUserScriptUrl(`https://gist.github.com/u/${ID}/raw/${SHA}/wide-wiki.user.js`), true);
  const page = installPageUrl('chrome-extension://abc/install.html', raw);
  assert.equal(scriptUrlFromLocation({ hash: page.slice(page.indexOf('#')) }), raw);
  // The fetch the install page's preview makes (and Update makes) — stubbed, no network.
  const original = globalThis.fetch;
  const shared = recordGist(mod(), { user: 'u', id: ID, fileName: 'wide-wiki.user.js' });
  globalThis.fetch = (async (input: string | URL) => {
    assert.equal(String(input), raw);
    return new Response(shared.source, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }) as typeof fetch;
  try {
    const preview = await previewFromUrl(raw);
    assert.equal(preview.name, 'Wide Wiki');
    assert.equal(preview.downloadUrl, raw);
  } finally {
    globalThis.fetch = original;
  }
});

test('Update on a gist-shared mod: same version is up to date, a bumped one replaces it', () => {
  const shared = recordGist(mod(), { user: 'u', id: ID, fileName: 'wide-wiki.user.js' });
  assert.equal(shared.downloadUrl, gistRawUrl('u', ID, 'wide-wiki.user.js'));
  // What updateMod decides with what the raw URL serves.
  assert.equal(shouldUpdate({ version: shared.version, source: shared.source }, { version: '1.2.3', source: shared.source }), false);
  const next = prepareShare(shared, 'gist').source;
  assert.equal(shouldUpdate({ version: shared.version, source: shared.source }, { version: parseHeader(next).version, source: next }), true);
});
