// Which world a mod runs in, across every path that rebuilds it from its own source.
//
// The bug: the model's mods are tested and first saved in the isolated USER_SCRIPT world, but the
// header buildSource generated for them said `@grant none`. modFromProposal forced USER_SCRIPT on
// the first save only; every later save (the panel's "Save & update mod", the dashboard's source
// editor, an export re-imported) re-read that header, and `@grant none` means "run in the page" to
// Tampermonkey, so the mod quietly moved to the page's world. test_mod builds through the same
// functions (modFromDraft in entrypoints/background.ts: modFromProposal for a first save,
// reparseEditedSource over toSource for a linked one), so it reported MAIN too — faithfully.
//
// Imported scripts must keep meaning what they say: `@grant none` from Greasy Fork is the page.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { addVersion, createArtifact, fromMod, toProposal, toSource, type Artifact } from '../lib/artifact.ts';
import { reparseEditedSource } from '../lib/install.ts';
import { buildSource, draftSourceFor, modFromProposal, modFromSource, normalizeMod, parseHeader, previewFromSource, upgradeGeneratedHeader } from '../lib/mods.ts';
import { powersDiff } from '../lib/updates.ts';
import type { Mod, ModProposal } from '../lib/types.ts';

const version = (code: string) => ({
  name: 'Hide the banner',
  description: 'Hides the promo banner.',
  matches: ['*://*.example.com/*'],
  code,
  source: 'proposal' as const,
});
const V1 = "document.querySelector('.promo')?.remove();";
const V2 = "document.querySelectorAll('.promo').forEach((e) => e.remove());";

/** What the first Save writes (modFromDraft with nothing linked). */
function firstSave(a: Artifact): Mod {
  return modFromProposal(toProposal(a) as ModProposal);
}
/** What every later Save writes, and what test_mod runs for a linked draft (modFromDraft, linked). */
function laterSave(a: Artifact, into: Mod): Mod {
  return reparseEditedSource(into, toSource(a));
}

test('a model-written mod stays in the isolated world on its first save', () => {
  const a = createArtifact('chat', version(V1), 1, 'art');
  assert.equal(firstSave(a).world, 'USER_SCRIPT');
});

test('…and on its second save, the panel\'s "Save & update mod"', () => {
  let a = createArtifact('chat', version(V1), 1, 'art');
  const saved = firstSave(a);
  a = addVersion(a, version(V2), 2);
  const updated = laterSave(a, saved);
  assert.equal(updated.world, 'USER_SCRIPT');
  assert.equal(updated.id, saved.id);
  // And a third, for good measure: nothing accumulates.
  a = addVersion(a, version(V1), 3);
  assert.equal(laterSave(a, updated).world, 'USER_SCRIPT');
});

test('test_mod reports the world the saved mod will have, before and after the first save', () => {
  // test_mod builds its mod with modFromDraft, the same function Save uses; these are its two branches.
  let a = createArtifact('chat', version(V1), 1, 'art');
  const tested1 = firstSave(addVersion(a, version(V2), 2));
  const saved = firstSave(a);
  a = addVersion(a, version(V2), 2);
  const tested2 = laterSave(a, saved);
  assert.equal(tested1.world, saved.world);
  assert.equal(tested2.world, laterSave(a, saved).world);
  assert.equal(tested2.world, 'USER_SCRIPT');
});

test('editing a model-written mod in the dashboard and saving keeps its world', () => {
  const saved = firstSave(createArtifact('chat', version(V1), 1, 'art'));
  const edited = saved.source.replace('.promo', '.promo, .nag');
  assert.equal(reparseEditedSource(saved, edited).world, 'USER_SCRIPT');
});

test('a chat opened on a model-written mod (open_mod) keeps its header, and its world, on save', () => {
  const saved = firstSave(createArtifact('chat', version(V1), 1, 'art'));
  let a = fromMod('chat2', saved, 1, 'art2');
  a = addVersion(a, version(V2), 2);
  assert.equal(laterSave(a, saved).world, 'USER_SCRIPT');
});

test('an exported model-written mod re-imports into the isolated world', () => {
  const saved = firstSave(createArtifact('chat', version(V1), 1, 'art'));
  assert.equal(modFromSource(saved.source).world, 'USER_SCRIPT');
  assert.equal(previewFromSource(saved.source).world, 'USER_SCRIPT');
});

test('the generated header says "isolated" in words other managers read, and grants nothing', () => {
  const src = buildSource({ name: 'n', description: 'd', matches: ['*://*.example.com/*'], code: V1 });
  // Tampermonkey and Violentmonkey both read `@grant none` as "the page"; it must not be there.
  assert.doesNotMatch(src, /@grant\s+none/);
  // Violentmonkey's content-script marker, and Tampermonkey's (5.x) equivalent.
  assert.match(src, /^\/\/ @inject-into content$/m);
  assert.match(src, /^\/\/ @sandbox\s+DOM$/m);
  const h = parseHeader(src);
  assert.deepEqual(h.grants, []);
  assert.equal(modFromSource(src).world, 'USER_SCRIPT');
});

test('an imported @grant none script still runs in the page, through every rebuild', () => {
  const gf = '// ==UserScript==\n// @name GF\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\nwindow.foo = 1;\n';
  const imported = modFromSource(gf);
  assert.equal(imported.world, 'MAIN');
  assert.equal(reparseEditedSource(imported, gf.replace('foo', 'bar')).world, 'MAIN');
  let a = fromMod('chat', imported, 1, 'art');
  a = addVersion(a, { ...version('window.baz = 1;'), matches: ['https://example.com/*'] }, 2);
  assert.equal(toSource(a).includes('@grant none'), true);
  assert.equal(laterSave(a, imported).world, 'MAIN');
  // unsafeWindow asks for the page too.
  assert.equal(modFromSource(gf.replace('@grant none', '@grant unsafeWindow')).world, 'MAIN');
});

test('a script with real GM grants stays isolated', () => {
  const src = '// ==UserScript==\n// @name GM\n// @match https://example.com/*\n// @grant GM_setValue\n// @grant GM_getValue\n// ==/UserScript==\nGM_setValue("a", 1);\n';
  const m = modFromSource(src);
  assert.equal(m.world, 'USER_SCRIPT');
  assert.equal(reparseEditedSource(m, src + '\n// edit').world, 'USER_SCRIPT');
});

test('the isolated-world markers are honoured on import, and only in that direction', () => {
  const base = (extra: string) => `// ==UserScript==\n// @name X\n// @match https://example.com/*\n${extra}// ==/UserScript==\n`;
  // Violentmonkey: `@inject-into content` runs a `@grant none` script as a content script.
  assert.equal(modFromSource(base('// @grant none\n// @inject-into content\n')).world, 'USER_SCRIPT');
  // Tampermonkey: `@sandbox DOM` is the isolated world.
  assert.equal(modFromSource(base('// @grant none\n// @sandbox DOM\n')).world, 'USER_SCRIPT');
  // auto / page / raw / JavaScript leave the @grant rule to decide, as before. Moving a GM-granted
  // script into the page would cost it its GM functions here, so `page` never forces MAIN.
  assert.equal(modFromSource(base('// @grant none\n// @inject-into auto\n')).world, 'MAIN');
  assert.equal(modFromSource(base('// @grant GM_setValue\n// @inject-into page\n')).world, 'USER_SCRIPT');
  assert.equal(modFromSource(base('// @grant none\n// @sandbox raw\n')).world, 'MAIN');
  // A locale-suffixed key is never a marker.
  assert.equal(modFromSource(base('// @grant none\n// @inject-into:fr content\n')).world, 'MAIN');
});

test('an update that adds or drops @inject-into content is reported as a world change', () => {
  const before = '// ==UserScript==\n// @name X\n// @version 1\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\n';
  const after = before.replace('// @version 1', '// @version 2').replace('// @grant none', '// @grant none\n// @inject-into content');
  assert.deepEqual(powersDiff(before, after).world, { from: 'page', to: 'isolated' });
});

// ---------- mods saved before the fix ----------

/** The header buildSource used to emit, exactly. */
const LEGACY = [
  '// ==UserScript==',
  '// @name        Hide the banner',
  '// @description Hides the promo banner.',
  '// @version     1.0',
  '// @match       *://*.example.com/*',
  '// @grant       none',
  '// ==/UserScript==',
  '',
  V1,
  '',
].join('\n');

function stored(over: Partial<Mod>): Mod {
  return { ...modFromSource(LEGACY), id: 'm1', ...over };
}

test('a mod saved once before the fix (isolated, legacy header) gets a header that agrees with it', () => {
  // Only the first save forced USER_SCRIPT, so this pair can only have come from modFromProposal.
  // The mod has always run isolated; rewriting its header to say so changes nothing it does, and
  // stops its next dashboard edit from moving it to the page.
  const m = normalizeMod(stored({ world: 'USER_SCRIPT', grants: ['none'] }));
  assert.equal(m.world, 'USER_SCRIPT');
  assert.doesNotMatch(m.source, /@grant\s+none/);
  assert.match(m.source, /@inject-into content/);
  assert.deepEqual(m.grants, []);
  assert.ok(m.source.endsWith(`${V1}\n`));
  assert.equal(reparseEditedSource(m, m.source.replace('.promo', '.nag')).world, 'USER_SCRIPT');
});

test('a mod already moved to the page by the bug is left alone: telling it from a real @grant none is guesswork', () => {
  // Its later versions were tested by test_mod in the page world, and a person may have written
  // this exact header themselves. Nothing here proves which, so nothing is rewritten.
  const m = normalizeMod(stored({ world: 'MAIN', grants: ['none'] }));
  assert.equal(m.world, 'MAIN');
  assert.equal(m.source, LEGACY);
});

test('an isolated mod whose header has anything else in it is left alone', () => {
  const src = LEGACY.replace('// @grant       none', '// @grant       none\n// @run-at      document-start');
  const m = normalizeMod({ ...modFromSource(src), id: 'm2', world: 'USER_SCRIPT' });
  assert.equal(m.source, src);
});

test('the on-load repair touches nothing but that one header line, and keeps the mod\'s dates and version', () => {
  const before = stored({ world: 'USER_SCRIPT', grants: ['none'], createdAt: 1000, updatedAt: 2000 });
  const m = normalizeMod(before);
  assert.equal(m.updatedAt, 2000);
  assert.equal(m.createdAt, 1000);
  assert.equal(m.version, '1.0');
  assert.equal(m.id, 'm1');
  // Line for line: the grant line became the two markers, nothing else moved.
  const want = LEGACY.replace('// @grant       none', '// @inject-into content\n// @sandbox     DOM');
  assert.equal(m.source, want);
  // Idempotent: a second load finds nothing to do.
  assert.equal(normalizeMod(m).source, want);
});

test('"exactly the old generated header" is exact: near misses are left alone', () => {
  const nearMisses: Array<[string, string]> = [
    ['one space before none, as a person types it', LEGACY.replace('// @grant       none', '// @grant none')],
    ['reordered keys', LEGACY.replace('// @version     1.0\n// @match       *://*.example.com/*', '// @match       *://*.example.com/*\n// @version     1.0')],
    ['another version', LEGACY.replace('1.0', '1.0.1')],
    ['an extra key', LEGACY.replace('// @grant       none', '// @run-at      document-start\n// @grant       none')],
    ['a second grant', LEGACY.replace('// @grant       none', '// @grant       none\n// @grant       GM_addStyle')],
    ['a locale variant', LEGACY.replace('// @description', '// @name:fr     Cacher\n// @description')],
    ['a downloadURL', LEGACY.replace('// @grant       none', '// @downloadURL https://x.example/a.user.js\n// @grant       none')],
    ['CRLF line endings', LEGACY.replace(/\n/g, '\r\n')],
    ['something before the header', `// my script\n${LEGACY}`],
    ['a blank line inside the header', LEGACY.replace('// @grant       none', '\n// @grant       none')],
  ];
  for (const [why, src] of nearMisses) {
    assert.equal(upgradeGeneratedHeader(src), null, why);
    const m = normalizeMod({ ...modFromSource(src), id: 'x', world: 'USER_SCRIPT' });
    assert.equal(m.source, src, why);
  }
});

test('an isolated mod whose BODY holds the old grant line keeps its body byte for byte', () => {
  // A real GM grant makes it isolated for its own reasons; the text in a template string is data.
  const src = [
    '// ==UserScript==',
    '// @name        GMish',
    '// @description d',
    '// @version     1.0',
    '// @match       *://*.example.com/*',
    '// @grant       GM_addStyle',
    '// ==/UserScript==',
    '',
    'const tpl = `',
    '// @grant       none',
    '`;',
    '',
  ].join('\n');
  const m = normalizeMod({ ...modFromSource(src), id: 'gm' });
  assert.equal(m.world, 'USER_SCRIPT');
  assert.equal(m.source, src);
});

test('an imported @grant none script with the generated look is never repaired: its world says the page', () => {
  const m = normalizeMod({ ...modFromSource(LEGACY), id: 'imp' });
  assert.equal(m.world, 'MAIN');
  assert.equal(m.source, LEGACY);
});

test('a draft stored with the old header, saved into the isolated mod it was opened on, keeps it isolated', () => {
  // open_mod before the fix copied the header onto the draft; the draft is still in storage.
  const isolated = stored({ world: 'USER_SCRIPT', grants: ['none'] });
  let a = fromMod('chat', isolated, 1, 'art');
  assert.match(toSource(a), /@grant       none/, 'the draft carries the old header');
  a = addVersion(a, version(V2), 2);
  const into = normalizeMod(isolated);
  const saved = reparseEditedSource(into, draftSourceFor(toSource(a), into));
  assert.equal(saved.world, 'USER_SCRIPT');
  assert.match(saved.source, /@inject-into content/);
  assert.ok(saved.source.includes(V2));
  // A page-world mod, or an imported one, is saved exactly as written.
  const page = stored({ world: 'MAIN', grants: ['none'] });
  assert.equal(draftSourceFor(toSource(a), page), toSource(a));
  assert.equal(reparseEditedSource(page, draftSourceFor(toSource(a), page)).world, 'MAIN');
  // And a header someone wrote is not the generated one, whatever the mod's world.
  const typed = toSource(a).replace('// @grant       none', '// @grant none');
  assert.equal(draftSourceFor(typed, into), typed);
});
