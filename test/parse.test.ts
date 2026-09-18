// Sanity tests for the pure parsing helpers. These files import only types from the extension
// side, so they run under `node --experimental-strip-types` with no bundler and no browser.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { modFromSource, normalizeMod, parseHeader, previewFromSource, toMatchPattern, urlMatches } from '../lib/mods.ts';
import { normalizeValues, parseTampermonkeyJson, parseTampermonkeyZipEntries, scriptFromEntry } from '../lib/tampermonkey.ts';

const SCRIPT = `// ==UserScript==
// @name         Example Helper
// @namespace    http://example.com/
// @version      2.4.1
// @description  Adds a button to example.com
// @author       someone
// @match        https://example.com/*
// @match        http*://*.example.org/path/*
// @include      https://wiki.example.net/*
// @include      *://*glob-only*.example/*
// @exclude      https://example.com/admin/*
// @require      https://cdn.example.com/lib.js
// @resource     css https://cdn.example.com/style.css
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_fancyUnsupportedThing
// @connect      api.example.com
// @connect      self
// @run-at       document-start
// @noframes
// @downloadURL  https://example.com/helper.user.js
// ==/UserScript==

console.log('hi');
`;

test('parseHeader reads the full Tampermonkey header', () => {
  const h = parseHeader(SCRIPT);
  assert.equal(h.name, 'Example Helper');
  assert.equal(h.version, '2.4.1');
  assert.equal(h.description, 'Adds a button to example.com');
  assert.deepEqual(h.matches, ['https://example.com/*', '*://*.example.org/path/*', 'https://wiki.example.net/*']);
  assert.deepEqual(h.excludeMatches, ['https://example.com/admin/*']);
  assert.deepEqual(h.includeGlobs, ['*://*glob-only*.example/*']);
  assert.deepEqual(h.requires, ['https://cdn.example.com/lib.js']);
  assert.deepEqual(h.resources, [{ name: 'css', url: 'https://cdn.example.com/style.css' }]);
  assert.deepEqual(h.grants, ['GM_setValue', 'GM_getValue', 'GM_fancyUnsupportedThing']);
  assert.deepEqual(h.connect, ['api.example.com', 'self']);
  assert.equal(h.runAt, 'document_start');
  assert.equal(h.noFrames, true);
  assert.equal(h.downloadUrl, 'https://example.com/helper.user.js');
});

test('toMatchPattern coerces Tampermonkey looseness into Chrome patterns', () => {
  assert.equal(toMatchPattern('*'), '*://*/*');
  assert.equal(toMatchPattern('http*://example.com/*'), '*://example.com/*');
  assert.equal(toMatchPattern('https://example.com'), 'https://example.com/*');
  assert.equal(toMatchPattern('https://*.example.com/a/b'), 'https://*.example.com/a/b');
  assert.equal(toMatchPattern('*://*.example.com:8080/*'), '*://*.example.com:8080/*');
  // Not coercible: mid-host wildcards and regex includes stay globs.
  assert.equal(toMatchPattern('*://*example*.com/*'), null);
  assert.equal(toMatchPattern('/^https:\\/\\/x\\.com/'), null);
  assert.equal(toMatchPattern(''), null);
});

test('previewFromSource summarises a script and flags unsupported grants', () => {
  const p = previewFromSource(SCRIPT, 'https://example.com/helper.user.js');
  assert.equal(p.name, 'Example Helper');
  assert.equal(p.version, '2.4.1');
  assert.equal(p.world, 'USER_SCRIPT');
  assert.equal(p.runAt, 'document_start');
  assert.deepEqual(p.requires, ['https://cdn.example.com/lib.js']);
  assert.deepEqual(p.resources, ['css']);
  assert.equal(p.downloadUrl, 'https://example.com/helper.user.js');
  assert.ok(p.warnings.some((w) => w.includes('GM_fancyUnsupportedThing')), 'unsupported grant is warned about');
});

test('previewFromSource puts @grant none scripts in the MAIN world and warns when nothing matches', () => {
  const main = previewFromSource('// ==UserScript==\n// @name X\n// @match https://a.example/*\n// @grant none\n// ==/UserScript==\n');
  assert.equal(main.world, 'MAIN');
  const nomatch = previewFromSource('// ==UserScript==\n// @name Y\n// ==/UserScript==\n');
  assert.ok(nomatch.warnings.some((w) => w.includes('never run')), 'no-match script is warned about');
});

test('urlMatches does display-side matching', () => {
  assert.equal(urlMatches('https://example.com/a', ['https://example.com/*']), true);
  assert.equal(urlMatches('https://other.com/a', ['https://example.com/*']), false);
  assert.equal(urlMatches('http://sub.example.org/path/x', ['*://*.example.org/path/*']), true);
});

// ---------- Tampermonkey backups ----------

const TM_JSON = JSON.stringify({
  scripts: [
    {
      name: 'Example Helper',
      source: SCRIPT,
      enabled: true,
      uuid: '11111111-2222-3333-4444-555555555555',
      file_url: 'https://example.com/helper.user.js',
      position: 1,
      options: { check_for_updates: true, comment: null, compat_foreach: false, run_at: 'document-start' },
      storage: { data: { count: { origin: 'normal', value: 42 }, token: { origin: 'normal', value: 'abc' } } },
    },
    {
      name: 'Disabled One',
      source: '// ==UserScript==\n// @name Disabled One\n// @match https://b.example/*\n// ==/UserScript==\nvoid 0;\n',
      enabled: false,
      options: {},
      storage: { data: {} },
    },
    { name: 'Not a script', options: {} },
  ],
});

test('parseTampermonkeyJson reads a realistic export', () => {
  const r = parseTampermonkeyJson(TM_JSON);
  assert.equal(r.scripts.length, 2);
  assert.deepEqual(r.skipped, ['Not a script (no userscript source)']);
  const [first, second] = r.scripts;
  assert.equal(first!.name, 'Example Helper');
  assert.equal(first!.enabled, true);
  assert.equal(first!.downloadUrl, 'https://example.com/helper.user.js');
  assert.equal(first!.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(second!.enabled, false);
});

test('GM values survive the {origin,value} wrapper and the {data:…} wrapper', () => {
  // The real export nests the store under `data`; values must land flat, ready for gm:<id>.
  const r = parseTampermonkeyJson(TM_JSON);
  assert.deepEqual(r.scripts[0]!.values, { count: 42, token: 'abc' });
  assert.deepEqual(normalizeValues({ data: { a: { origin: 'normal', value: 1 } }, ts: 1234 }), { a: 1 });
  // A flat store and a stringified store both work.
  assert.deepEqual(normalizeValues({ a: 1, b: { origin: 'normal', value: 'x' } }), { a: 1, b: 'x' });
  assert.deepEqual(normalizeValues('{"a":{"origin":"normal","value":true}}'), { a: true });
  assert.deepEqual(normalizeValues('not json'), {});
  assert.deepEqual(normalizeValues(null), {});
  // A script whose own key is literally "data" must not be mistaken for the wrapper.
  assert.deepEqual(normalizeValues({ data: { origin: 'normal', value: 'mine' } }), { data: 'mine' });
});

test('parseTampermonkeyJson also accepts a bare array and a single entry', () => {
  assert.equal(parseTampermonkeyJson(JSON.stringify([{ source: SCRIPT }])).scripts.length, 1);
  assert.equal(parseTampermonkeyJson(JSON.stringify({ source: SCRIPT, enabled: false })).scripts.length, 1);
  assert.throws(() => parseTampermonkeyJson('{oops'), /not valid JSON/);
});

test('enabled flags are read from strings, numbers and options', () => {
  assert.equal(scriptFromEntry({ source: SCRIPT, enabled: 'false' })!.enabled, false);
  assert.equal(scriptFromEntry({ source: SCRIPT, enabled: 0 })!.enabled, false);
  assert.equal(scriptFromEntry({ source: SCRIPT, options: { enabled: false } })!.enabled, false);
  assert.equal(scriptFromEntry({ source: SCRIPT })!.enabled, true, 'defaults to enabled');
  assert.equal(scriptFromEntry({ name: 'x' }), null);
});

test('parseTampermonkeyZipEntries reads .user.js plus its sidecars', () => {
  const r = parseTampermonkeyZipEntries({
    'Example Helper.user.js': SCRIPT,
    'Example Helper.options.json': JSON.stringify({ enabled: false, meta: { file_url: 'https://example.com/helper.user.js' } }),
    'Example Helper.storage.json': JSON.stringify({ data: { count: { origin: 'normal', value: 7 } } }),
    'README.txt.bak': 'ignored',
  });
  assert.equal(r.scripts.length, 1);
  const s = r.scripts[0]!;
  assert.equal(s.name, 'Example Helper');
  assert.equal(s.enabled, false, 'enabled comes from the options sidecar');
  assert.equal(s.downloadUrl, 'https://example.com/helper.user.js');
  assert.deepEqual(s.values, { count: 7 });
});

test('parseTampermonkeyZipEntries reads older JSON-in-.txt entries', () => {
  const r = parseTampermonkeyZipEntries({
    '0.txt': JSON.stringify({ name: 'Example Helper', source: SCRIPT, enabled: true, storage: { data: {} } }),
    '1.txt': JSON.stringify({ name: 'Broken', options: {} }),
  });
  assert.equal(r.scripts.length, 1);
  assert.equal(r.scripts[0]!.name, 'Example Helper');
  assert.equal(r.skipped.length, 1);
});

test('a zip entry with unparsable JSON is skipped, not fatal', () => {
  const r = parseTampermonkeyZipEntries({ 'a.user.js': SCRIPT, 'a.options.json': '{broken' });
  assert.equal(r.scripts.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.ok(r.skipped[0]!.startsWith('a.options.json'));
});

// ---------- regressions ----------

// Finding 5: the unsuffixed key is canonical however the lines are ordered.
test('locale-suffixed header keys are fallbacks, never overriding the bare key', () => {
  const h = parseHeader(
    ['// ==UserScript==', '// @name:fr        Nom francais', '// @name            Real Name', '// @description:fr Description francaise', '// @description     Real description', '// @match           https://a.example/*', '// ==/UserScript=='].join('\n'),
  );
  assert.equal(h.name, 'Real Name');
  assert.equal(h.description, 'Real description');
  // The locale variants are still recorded under the bare key for GM_info.
  assert.deepEqual(h.raw['name'], ['Nom francais', 'Real Name']);
  assert.deepEqual(h.raw['description'], ['Description francaise', 'Real description']);
});

test('a locale-only key is used as a fallback when no bare key exists', () => {
  const h = parseHeader(['// ==UserScript==', '// @name:fr Seulement en francais', '// @description:de Nur deutsch', '// ==/UserScript=='].join('\n'));
  assert.equal(h.name, 'Seulement en francais');
  assert.equal(h.description, 'Nur deutsch');
});

test('a locale-suffixed key never contributes to list-valued fields', () => {
  const h = parseHeader(['// ==UserScript==', '// @name X', '// @match:fr https://fr.example/*', '// @grant:fr GM_setValue', '// @connect:fr fr.example.com', '// ==/UserScript=='].join('\n'));
  assert.deepEqual(h.matches, []);
  assert.deepEqual(h.grants, []);
  assert.deepEqual(h.connect, []);
});

// Finding 6: a wildcard inside the host means glob semantics; do not widen it into a match pattern.
test('@include host wildcards stay globs, plain and *.sub hosts are promoted', () => {
  const inc = (v: string) => parseHeader(['// ==UserScript==', '// @name X', `// @include ${v}`, '// ==/UserScript=='].join('\n'));
  // Promotable: no host wildcard, leading "*." only, or a bare "*" host.
  assert.deepEqual(inc('https://example.com/*').matches, ['https://example.com/*']);
  assert.deepEqual(inc('https://*.example.com/*').matches, ['https://*.example.com/*']);
  assert.deepEqual(inc('*://*/*').matches, ['*://*/*']);
  assert.deepEqual(inc('*').matches, ['*://*/*']);
  // Not promotable: the wildcard is inside the host, so glob semantics must be kept.
  assert.deepEqual(inc('https://*.example.*/*').matches, []);
  assert.deepEqual(inc('https://*.example.*/*').includeGlobs, ['https://*.example.*/*']);
  assert.deepEqual(inc('*://*example*.com/*').includeGlobs, ['*://*example*.com/*']);
  assert.deepEqual(inc('https://example.*/path').includeGlobs, ['https://example.*/path']);
  // @match is unaffected: it is match-pattern syntax already.
  const m = parseHeader(['// ==UserScript==', '// @name X', '// @match https://*.example.com/*', '// ==/UserScript=='].join('\n'));
  assert.deepEqual(m.matches, ['https://*.example.com/*']);
});

// Finding 8: @connect flows into the header, the mod and the install preview.
test('@connect is parsed, deduped and carried into the preview', () => {
  const h = parseHeader(
    ['// ==UserScript==', '// @name X', '// @match https://a.example/*', '// @connect api.example.com', '// @connect api.example.com', '// @connect *', '// @connect self', '// @connect localhost', '// ==/UserScript=='].join('\n'),
  );
  assert.deepEqual(h.connect, ['api.example.com', '*', 'self', 'localhost']);
  const p = previewFromSource(SCRIPT);
  assert.deepEqual(p.connect, ['api.example.com', 'self']);
  const mod = modFromSource(SCRIPT);
  assert.deepEqual(mod.connect, ['api.example.com', 'self']);
  // A script with no @connect gets an empty list, not undefined.
  assert.deepEqual(previewFromSource('// ==UserScript==\n// @name X\n// ==/UserScript==\n').connect, []);
  assert.deepEqual(normalizeMod({ id: 'x', source: SCRIPT }).connect, ['api.example.com', 'self']);
});

// Finding 16: "?" is a regex metacharacter and must be escaped; only "*" is a wildcard.
test('urlMatches escapes every metacharacter except the "*" wildcard', () => {
  // Without escaping "?", the "m" would be optional and this would wrongly match.
  assert.equal(urlMatches('https://example.co/a', ['https://example.com/*']), false);
  // A literal "?" in the pattern matches only a literal "?" in the URL.
  assert.equal(urlMatches('https://example.com/a?b=1', ['https://example.com/a?b=1']), true);
  assert.equal(urlMatches('https://example.com/ab=1', ['https://example.com/a?b=1']), false);
  // "/" stays literal, and the leading "*:" scheme wildcard still works.
  assert.equal(urlMatches('https://example.com/a/b', ['*://example.com/a/b']), true);
  assert.equal(urlMatches('https://example.com/x', ['*://example.com/*']), true);
});

// Finding 3: ZIP entries are keyed by full path, so same-named scripts in different folders survive.
test('parseTampermonkeyZipEntries keys by path, not basename', () => {
  const a = SCRIPT.replace('@name         Example Helper', '@name         Helper A');
  const b = SCRIPT.replace('@name         Example Helper', '@name         Helper B');
  const r = parseTampermonkeyZipEntries({
    'scripts/tool.user.js': a,
    'scripts/tool.storage.json': JSON.stringify({ data: { which: { origin: 'normal', value: 'scripts' } } }),
    'scripts/tool.options.json': JSON.stringify({ enabled: true }),
    'archive/tool.user.js': b,
    'archive/tool.storage.json': JSON.stringify({ data: { which: { origin: 'normal', value: 'archive' } } }),
    'archive/tool.options.json': JSON.stringify({ enabled: false }),
  });
  assert.equal(r.scripts.length, 2, 'both scripts survive');
  const byName = Object.fromEntries(r.scripts.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ['Helper A', 'Helper B']);
  assert.deepEqual(byName['Helper A']!.values, { which: 'scripts' }, 'sidecars do not cross-attach');
  assert.deepEqual(byName['Helper B']!.values, { which: 'archive' });
  assert.equal(byName['Helper A']!.enabled, true);
  assert.equal(byName['Helper B']!.enabled, false);
});

test('a nested script falls back to its basename for the display name', () => {
  const headerless = '// ==UserScript==\n// @match https://a.example/*\n// ==/UserScript==\nvoid 0;\n';
  const r = parseTampermonkeyZipEntries({ 'some/deep/folder/My Tool.user.js': headerless });
  assert.equal(r.scripts.length, 1);
  assert.equal(r.scripts[0]!.name, 'My Tool', 'the folder does not leak into the name');
});
