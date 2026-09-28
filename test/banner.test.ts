// The install banner's detectors (lib/banner.ts), run on saved copies of the real pages in
// test/fixtures/pages (parsed with linkedom), and its "already installed / update available"
// matching and dismissal memory.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import {
  addDismissal,
  bannerText,
  bannerWorthShowing,
  BANNER_DISMISSED_CAP,
  canonicalScriptUrl,
  detectUserscripts,
  dismissKey,
  installState,
  isDismissed,
  rawLinesHeader,
  worthLooking,
  type DetectedScript,
} from '../lib/banner.ts';
import { modFromSource } from '../lib/mods.ts';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/pages/${name}`, import.meta.url)), 'utf8');
const doc = (html: string) => parseHTML(html).document as unknown as Document;

const GIST = 'https://gist.github.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02';
const BLOB = 'https://github.com/jesus2099/konami-command/blob/master/acacia_BONUS.user.js';
const GF = 'https://greasyfork.org/en/scripts/19993-ru-adlist-js-fixes';

/** A text document as Chrome and Safari render one: the file in a single <pre>. */
function textDoc(text: string): Document {
  const d = doc('<html><head></head><body></body></html>');
  const pre = d.createElement('pre');
  pre.textContent = text;
  d.body.append(pre);
  return d;
}

test('the cheap gate: four hosts and text documents, nothing else is read', () => {
  assert.equal(worthLooking(GIST, 'text/html'), true);
  assert.equal(worthLooking(BLOB, 'text/html'), true);
  assert.equal(worthLooking(GF, 'text/html'), true);
  assert.equal(worthLooking('https://openuserjs.org/scripts/a/b', 'text/html'), true);
  assert.equal(worthLooking('https://paste.example.com/raw/1', 'text/plain'), true);
  assert.equal(worthLooking('https://example.com/app.js', 'application/javascript'), true);
  assert.equal(worthLooking('https://en.wikipedia.org/wiki/Userscript', 'text/html'), false);
  assert.equal(worthLooking('chrome-extension://abc/install.html', 'text/html'), false);
  assert.equal(worthLooking('file:///x.user.js', 'text/plain'), false);
  // On any other page the detector returns before it touches the document at all.
  const trap = new Proxy({}, { get: () => { throw new Error('the DOM was read'); } }) as Document;
  assert.equal(detectUserscripts(trap, 'https://news.ycombinator.com/', 'text/html'), null);
});

test('(a) a gist with a .user.js file: name, namespace and version from its rendered lines, the latest raw URL', () => {
  const d = detectUserscripts(doc(fixture('gist-userscript.html')), GIST, 'text/html');
  assert.deepEqual(d, {
    kind: 'gist',
    gist: { user: 'KillaMeep', id: 'c5e8506a7c32169843d0373f710dfb02' },
    scripts: [
      {
        name: 'Pinterest Dark (Polished)',
        namespace: 'https://gist.github.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02',
        version: '0.1',
        // The Raw link pins a revision; the install link does not.
        installUrl: 'https://gist.githubusercontent.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02/raw/pinterest-dark.user.js',
      },
    ],
  });
});

test('(a) a gist with no userscript (a file called user.js is a Firefox prefs file) offers nothing', () => {
  assert.equal(detectUserscripts(doc(fixture('gist-no-userscript.html')), 'https://gist.github.com/ThomasRoest/d415d54bb81ade76c61dec7a445f65ba', 'text/html'), null);
});

test('(a) the gist’s edit page and the new-gist form never get a banner', () => {
  const page = doc(fixture('gist-userscript.html'));
  assert.equal(detectUserscripts(page, `${GIST}/edit`, 'text/html'), null);
  assert.equal(detectUserscripts(page, 'https://gist.github.com/', 'text/html'), null);
  assert.equal(detectUserscripts(page, `${GIST}/revisions`, 'text/html'), null);
});

test('(b) a GitHub blob page of a .user.js file: its Raw button, and the header', () => {
  const d = detectUserscripts(doc(fixture('github-blob.html')), BLOB, 'text/html');
  assert.equal(d?.kind, 'github-blob');
  assert.deepEqual(d?.scripts[0], {
    name: 'acacia. BONUS',
    namespace: 'https://github.com/jesus2099/konami-command',
    version: '2026.1.19',
    installUrl: 'https://github.com/jesus2099/konami-command/raw/refs/heads/master/acacia_BONUS.user.js',
    downloadUrl: 'https://github.com/jesus2099/konami-command/raw/master/acacia_BONUS.user.js',
  });
  // A blob that is not a .user.js file, and a repo page, are not offered.
  assert.equal(detectUserscripts(doc(fixture('github-blob.html')), 'https://github.com/jesus2099/konami-command/blob/master/README.md', 'text/html'), null);
  assert.equal(detectUserscripts(doc(fixture('github-blob.html')), 'https://github.com/jesus2099/konami-command', 'text/html'), null);
});

test('(b) the header comes from the page data when the lines are not rendered yet', () => {
  const html = fixture('github-blob.html').replace(/react-file-line/g, 'not-a-line');
  const d = detectUserscripts(doc(html), BLOB, 'text/html');
  assert.equal(d?.scripts[0]?.name, 'acacia. BONUS');
  assert.equal(d?.scripts[0]?.version, '2026.1.19');
});

test('rawLinesHeader reads only as far as the end of the header', () => {
  const json = JSON.stringify({ a: 1, rawLines: ['// ==UserScript==', '// @name  "Quoted" \\ name', '// ==/UserScript==', 'code();', 'x'.repeat(100) ] });
  assert.equal(rawLinesHeader(json), '// ==UserScript==\n// @name  "Quoted" \\ name\n// ==/UserScript==');
  assert.equal(rawLinesHeader('{"nothing":true}'), '');
});

test('(c) a plain-text document with a userscript header, found in the first 2 KB', () => {
  const raw = fixture('raw-userscript.txt');
  const d = detectUserscripts(textDoc(raw), 'https://paste.example.com/raw/abc?raw=1', 'text/plain');
  assert.deepEqual(d?.scripts[0], {
    name: 'Pinterest Dark (Polished)',
    namespace: 'https://gist.github.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02',
    version: '0.1',
    installUrl: 'https://paste.example.com/raw/abc?raw=1',
  });
  // Text that is not a userscript, a header that starts after 2 KB, and an HTML page are nothing.
  assert.equal(detectUserscripts(textDoc('just some notes\n'), 'https://paste.example.com/raw/n', 'text/plain'), null);
  assert.equal(detectUserscripts(textDoc(`${' '.repeat(2100)}\n${raw}`), 'https://paste.example.com/raw/late', 'text/plain'), null);
  assert.equal(detectUserscripts(textDoc(raw), 'https://paste.example.com/raw/abc', 'text/html'), null);
});

test('(d) a Greasy Fork script page: the identity its Install button carries', () => {
  const d = detectUserscripts(doc(fixture('greasyfork-script.html')), GF, 'text/html');
  assert.deepEqual(d, {
    kind: 'greasyfork',
    scripts: [{ name: 'RU AdList JS Fixes', namespace: 'ruadlist_js_fixes', version: '20240625.1', installUrl: 'https://update.greasyfork.org/scripts/19993/RU%20AdList%20JS%20Fixes.user.js' }],
  });
});

// ---------------------------------------------------------------------------
// Installed? Update?
// ---------------------------------------------------------------------------

const header = (name: string, ns: string | null, version: string, extra = '') =>
  `// ==UserScript==\n// @name ${name}\n${ns === null ? '' : `// @namespace ${ns}\n`}// @version ${version}\n// @match *://*.pinterest.com/*\n${extra}// ==/UserScript==\n`;

const PIN: DetectedScript = {
  name: 'Pinterest Dark (Polished)',
  namespace: 'https://gist.github.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02',
  version: '0.1',
  installUrl: 'https://gist.githubusercontent.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02/raw/pinterest-dark.user.js',
};

test('matched by @name + @namespace: installed, or an update when the page is newer', () => {
  const same = modFromSource(header(PIN.name, PIN.namespace, '0.1'));
  assert.deepEqual(installState(PIN, [same]), { kind: 'installed', modId: same.id, version: '0.1' });
  const older = modFromSource(header(PIN.name, PIN.namespace, '0.0.9'));
  assert.deepEqual(installState(PIN, [older]), { kind: 'update', modId: older.id, from: '0.0.9', to: '0.1' });
  // Never a downgrade: a newer installed copy is just installed.
  const newer = modFromSource(header(PIN.name, PIN.namespace, '0.2'));
  assert.equal(installState(PIN, [newer]).kind, 'installed');
});

test('name alone is not identity; a different namespace is a different script', () => {
  assert.equal(installState(PIN, [modFromSource(header(PIN.name, 'https://someone.else', '0.1'))]).kind, 'install');
  assert.equal(installState(PIN, [modFromSource(header(PIN.name, null, '0.1'))]).kind, 'install');
  assert.equal(installState({ ...PIN, namespace: '' }, [modFromSource(header(PIN.name, '', '0.1'))]).kind, 'install');
});

test('matched by download URL, however it is spelled', () => {
  const byUrl = { ...modFromSource(header('Renamed locally', null, '0.1')), downloadUrl: 'https://gist.github.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02/raw/a385163d67ee678a071827a893377215390a9308/pinterest-dark.user.js' };
  assert.equal(installState(PIN, [byUrl]).kind, 'installed');
  assert.equal(canonicalScriptUrl('https://update.greasyfork.org/scripts/19993/RU%20AdList%20JS%20Fixes.user.js'), 'greasyfork:19993');
  assert.equal(canonicalScriptUrl('https://greasyfork.org/en/scripts/19993-ru-adlist-js-fixes/code/RU%20AdList.user.js'), 'greasyfork:19993');
  assert.equal(canonicalScriptUrl('https://Example.com/a.user.js?x=1'), 'example.com/a.user.js');
});

test('the banner on Greasy Fork speaks only when it has news; elsewhere it always offers', () => {
  assert.equal(bannerWorthShowing('greasyfork', { kind: 'install' }), false);
  assert.equal(bannerWorthShowing('greasyfork', { kind: 'installed', modId: 'x', version: '1' }), false);
  assert.equal(bannerWorthShowing('greasyfork', { kind: 'update', modId: 'x', from: '1', to: '2' }), true);
  assert.equal(bannerWorthShowing('gist', { kind: 'install' }), true);
  assert.equal(bannerWorthShowing('raw', { kind: 'installed', modId: 'x', version: '1' }), true);
});

test('the banner’s words', () => {
  assert.deepEqual(bannerText(PIN, { kind: 'install' }), { message: 'usermods can install “Pinterest Dark (Polished)”.', action: 'Install' });
  assert.deepEqual(bannerText(PIN, { kind: 'installed', modId: 'x', version: '0.1' }), { message: '“Pinterest Dark (Polished)” is installed in usermods.', action: null });
  assert.deepEqual(bannerText(PIN, { kind: 'update', modId: 'x', from: '0.0.9', to: '0.1' }), { message: 'usermods has “Pinterest Dark (Polished)” v0.0.9. This page has v0.1.', action: 'Update to v0.1' });
});

test('dismissals are per page, newest first, and capped', () => {
  let list: string[] = [];
  list = addDismissal(list, `${GIST}#file-pinterest-dark-user-js`);
  assert.equal(isDismissed(list, GIST), true, 'the fragment does not make it another page');
  assert.equal(isDismissed(list, `${GIST}?tab=x`), true, 'on the four hosts the query does not either');
  assert.equal(isDismissed(list, 'https://paste.example.com/raw/a?id=1'), false);
  list = addDismissal(list, 'https://paste.example.com/raw/a?id=1');
  assert.equal(isDismissed(list, 'https://paste.example.com/raw/a?id=2'), false, 'elsewhere the query picks the document');
  assert.equal(dismissKey('https://paste.example.com/raw/a?id=1#x'), 'https://paste.example.com/raw/a?id=1');
  for (let i = 0; i < BANNER_DISMISSED_CAP + 50; i++) list = addDismissal(list, `https://paste.example.com/raw/${i}`);
  assert.equal(list.length, BANNER_DISMISSED_CAP);
  assert.equal(list[0], `https://paste.example.com/raw/${BANNER_DISMISSED_CAP + 49}`);
  // Dismissing again moves it to the front rather than adding a second copy.
  const again = addDismissal(list, 'https://paste.example.com/raw/100');
  assert.equal(again.filter((k) => k === 'https://paste.example.com/raw/100').length, 1);
  assert.equal(again[0], 'https://paste.example.com/raw/100');
});
