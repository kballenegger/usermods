// Editing an installed mod in chat: which chat a mod opens in, what the model is told runs on the
// page, what open_mod is allowed to do over a draft, whether an imported userscript survives the
// round trip, and whether a save is about to mint a twin.
//
// The owner's report was "i don't see an easy way to tell it you want to keep adding to a mod".
// Every rule below is one of the three directions that answers it — from the mod, from the chat,
// and from the model — and all of them are pure, so they are pinned here rather than only in a
// browser flow.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adoptMod,
  createArtifact,
  currentVersion,
  detachFromMod,
  draftBlock,
  fromMod,
  reheader,
  rollbackTo,
  toSource,
  type Artifact,
  type NewVersion,
} from '../lib/artifact.ts';
import {
  draftStanding,
  duplicateOf,
  editModPlan,
  likelyUrlFor,
  modsBlock,
  modsForUrl,
  openModDecision,
  runsOnPage,
  sameMatches,
} from '../lib/modmatch.ts';
import { modFromSource, parseHeader } from '../lib/mods.ts';
import { NEUTRAL_TOOLS, countReads } from '../lib/agent/budget.ts';
import { TOOLS } from '../lib/agent/tools.ts';
import { SYSTEM_PROMPT } from '../lib/agent/prompt.ts';
import type { Mod } from '../lib/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * An imported userscript with everything a chat-written mod does not have: a metadata block with
 * @require, @resource, @grant, @connect, @run-at, @noframes, a real @version and a @downloadURL.
 * This is the script the round-trip tests are about.
 */
const IMPORTED_SOURCE = `// ==UserScript==
// @name        Kingfisher Enhancer
// @namespace   https://example.org/
// @description Makes the kingfisher article better.
// @version     2.4.1
// @author      A. Person
// @match       *://*.wikipedia.org/wiki/*
// @exclude     *://*.wikipedia.org/wiki/Special:*
// @require     https://cdn.example.org/lib.js
// @resource    theme https://cdn.example.org/theme.css
// @grant       GM_setValue
// @grant       GM_getValue
// @connect     api.example.org
// @run-at      document-start
// @noframes
// @downloadURL https://example.org/kingfisher.user.js
// ==/UserScript==

GM_setValue('ran', true);
document.body.classList.add('enhanced');`;

function imported(over: Partial<Mod> = {}): Mod {
  return {
    ...modFromSource(IMPORTED_SOURCE),
    id: 'mod-imported',
    enabled: true,
    createdAt: 1000,
    updatedAt: 2000,
    requires: [{ url: 'https://cdn.example.org/lib.js', code: 'window.lib = 1;' }],
    ...over,
  };
}

/** A mod as the model writes them: a generated header and nothing else in it. */
function written(over: Partial<Mod> = {}): Mod {
  const source = `// ==UserScript==
// @name        Hide the promo banner
// @description Hides the promo banner.
// @version     1.0
// @match       *://*.wikipedia.org/wiki/*
// @grant       none
// ==/UserScript==

document.querySelector('#promo')?.remove();
`;
  return { ...modFromSource(source), id: 'mod-written', enabled: true, createdAt: 1, updatedAt: 2, ...over };
}

const draftOf = (over: Partial<NewVersion> = {}): NewVersion => ({
  code: 'document.body.style.background = "red";',
  name: 'A draft',
  description: 'Something new.',
  matches: ['*://*.example.com/*'],
  source: 'proposal',
  ...over,
});

// ---------------------------------------------------------------------------
// fromMod: the seeded draft is the installed mod, and reads as saved
// ---------------------------------------------------------------------------

test('fromMod seeds v1 from the mod, linked and already saved', () => {
  const mod = written();
  const a = fromMod('chat-1', mod);
  assert.equal(a.versions.length, 1);
  assert.equal(a.current, 1);
  assert.equal(a.linkedModId, mod.id);
  // The whole point: a chat that opens an installed mod must not offer to "save" what is already
  // saved. savedVersion === current is what makes the panel read as up to date.
  assert.equal(a.savedVersion, 1);
  assert.equal(a.name, 'Hide the promo banner');
  assert.ok(!currentVersion(a)!.code.includes('==UserScript=='), 'the body must not carry the header');
});

test('fromMod keeps an imported mod’s whole metadata block on the version', () => {
  const a = fromMod('chat-1', imported());
  const v = currentVersion(a)!;
  assert.ok(v.header, 'an imported mod’s header must be kept, or a save would regenerate one');
  for (const line of ['@require', '@resource', '@grant', '@connect', '@run-at', '@noframes', '@downloadURL', '@namespace', '@version     2.4.1']) {
    assert.ok(v.header!.text.includes(line), `the kept header lost ${line}`);
  }
});

// ---------------------------------------------------------------------------
// The round trip an imported userscript has to survive
// ---------------------------------------------------------------------------

test('an imported userscript survives seed → model revision → save', () => {
  const mod = imported();
  const a = fromMod('chat-1', mod);
  // What a propose_mod looks like: a body and four fields, and nothing about the header. This is
  // exactly the case that used to strip every dependency the script had.
  const revised = adoptedProposal(a, 'GM_setValue("ran", true);\ndocument.body.classList.add("enhanced2");');
  const source = toSource(revised);

  const h = parseHeader(source);
  assert.deepEqual(h.grants, ['GM_setValue', 'GM_getValue'], 'the grants were lost');
  assert.deepEqual(h.requires, ['https://cdn.example.org/lib.js'], 'the @require was lost');
  assert.deepEqual(h.resources.map((r) => r.name), ['theme'], 'the @resource was lost');
  assert.deepEqual(h.connect, ['api.example.org'], 'the @connect was lost');
  assert.equal(h.runAt, 'document_start', 'the @run-at was lost');
  assert.equal(h.noFrames, true, 'the @noframes was lost');
  assert.equal(h.version, '2.4.1', 'the @version was lost, so Update would compare against nothing');
  assert.equal(h.downloadUrl, 'https://example.org/kingfisher.user.js', 'the @downloadURL was lost');
  assert.deepEqual(h.excludeMatches, ['*://*.wikipedia.org/wiki/Special:*'], 'the @exclude was lost');
  assert.ok(source.includes('enhanced2'), 'the revised body did not reach the saved source');
  // And exactly one header, not a generated one on top of the kept one.
  assert.equal(source.match(/==UserScript==/g)?.length, 1);
});

test('a revision that renames or re-matches rewrites those lines INSIDE the kept header', () => {
  const a = fromMod('chat-1', imported());
  const revised = adoptedProposal(a, 'x();', { name: 'Kingfisher Enhancer Plus', matches: ['*://en.wikipedia.org/wiki/*'] });
  const source = toSource(revised);
  const h = parseHeader(source);
  assert.equal(h.name, 'Kingfisher Enhancer Plus');
  assert.deepEqual(h.matches, ['*://en.wikipedia.org/wiki/*'], 'the old @match must not survive a narrowing');
  // Everything the draft does NOT own is still there.
  assert.deepEqual(h.grants, ['GM_setValue', 'GM_getValue']);
  assert.ok(source.includes('@namespace   https://example.org/'));
});

test('a mod the model wrote still gets a generated header, as it always did', () => {
  const a = createArtifact('chat-1', draftOf());
  const source = toSource(a);
  assert.ok(source.includes('==UserScript=='));
  assert.ok(source.includes('@grant       none'));
  assert.ok(source.includes('@match       *://*.example.com/*'));
});

test('reheader leaves every line it does not own alone', () => {
  const header = ['// ==UserScript==', '// @name        Old', '// @weird-key   keep me', '// @name:fr     Vieux', '// ==/UserScript=='].join('\n');
  const out = reheader(header, { name: 'New', description: '', matches: ['*://a.example/*'] });
  assert.ok(out.includes('@name        New'));
  assert.ok(out.includes('@weird-key   keep me'), 'an unknown key must survive');
  // A locale variant is the author's translation, not ours to rewrite.
  assert.ok(out.includes('@name:fr     Vieux'), 'a locale-suffixed key must not be rewritten');
  // A header with no @match gains the draft's, rather than saving a script that never runs.
  assert.ok(out.includes('@match'), 'the draft’s patterns must be added when the header had none');
});

/** Apply a propose_mod-shaped revision to an artifact, the way recordProposal does. */
function adoptedProposal(a: Artifact, code: string, over: { name?: string; matches?: string[] } = {}): Artifact {
  const v = currentVersion(a)!;
  return {
    ...a,
    versions: [
      ...a.versions,
      {
        n: a.current + 1,
        code,
        name: over.name ?? v.name,
        description: v.description,
        matches: over.matches ?? v.matches,
        createdAt: Date.now(),
        source: 'proposal' as const,
        // This is the inheritance addVersion does, asserted separately below.
        ...(v.header ? { header: v.header } : {}),
      },
    ],
    current: a.current + 1,
    name: over.name ?? v.name,
    matches: over.matches ?? v.matches,
  };
}

test('addVersion inherits the header, so a revision cannot drop it', () => {
  const a = fromMod('chat-1', imported());
  const next = adoptMod(a, imported({ id: 'mod-imported' }));
  assert.ok(currentVersion(next)!.header, 'the header must ride forward');
});

test('a rollback restores the header its target carried, not the one in force now', () => {
  // v1 is the imported mod; open_mod then adopts a DIFFERENT mod, which brings its own header.
  // Rolling back to v1 must bring v1's header with it rather than leaving the draft wearing the
  // second mod's — otherwise a rollback would save the first script under the second's dependencies.
  const a = fromMod('chat-1', imported());
  const b = adoptMod(a, written());
  assert.ok(!currentVersion(b)!.header!.text.includes('@require'), 'adopting another mod replaces the kept header with ITS header');
  const back = rollbackTo(b, 1);
  assert.ok(toSource(back).includes('@require'), 'rolling back past an open_mod must restore that version’s own header');
  assert.ok(toSource(back).includes('@namespace'), 'and all of it, not only the lines the draft owns');
});

// ---------------------------------------------------------------------------
// adoptMod and detach
// ---------------------------------------------------------------------------

test('adoptMod appends rather than starting over, so nothing is lost', () => {
  const a = createArtifact('chat-1', draftOf());
  const b = adoptMod(a, written());
  assert.equal(b.versions.length, 2, 'the draft’s own v1 must still be in the history');
  assert.equal(b.current, 2);
  assert.equal(b.versions[0]!.code, 'document.body.style.background = "red";', 'v1’s code must be untouched');
  assert.equal(b.linkedModId, 'mod-written');
  assert.equal(b.savedVersion, 2, 'the adopted version IS the mod, so it reads as saved');
  // One rollback away from where the user was.
  assert.equal(currentVersion(rollbackTo(b, 1))!.code, 'document.body.style.background = "red";');
});

test('detachFromMod clears the link and the saved version, and nothing else', () => {
  const a = fromMod('chat-1', written());
  const d = detachFromMod(a);
  assert.equal(d.linkedModId, undefined);
  // savedVersion goes with it: with no mod, "which version is installed" has no answer, and a
  // number left behind would make a fresh unsaved draft read as already saved.
  assert.equal(d.savedVersion, undefined);
  assert.equal(d.versions.length, a.versions.length, 'detaching must not touch the history');
  assert.equal(d.id, a.id);
  assert.equal(d.chatId, a.chatId);
  assert.equal(currentVersion(d)!.code, currentVersion(a)!.code);
  // And it says nothing about deleting: there is no mod in an Artifact to delete.
  assert.ok(!('mod' in d));
});

test('detaching an unlinked artifact is a no-op', () => {
  const a = createArtifact('chat-1', draftOf());
  assert.equal(detachFromMod(a), a);
});

// ---------------------------------------------------------------------------
// The draft block the model reads
// ---------------------------------------------------------------------------

test('a linked draft tells the model it is editing an installed mod', () => {
  const block = draftBlock(fromMod('chat-1', written()));
  assert.match(block, /installed mod \(id mod-written\) that the user is EDITING/);
  assert.match(block, /Saving rewrites that mod in place/);
  assert.match(block, /keep everything it already does/i);
});

test('an unlinked draft says none of that', () => {
  const block = draftBlock(createArtifact('chat-1', draftOf()));
  assert.ok(!/EDITING/.test(block));
  assert.ok(!/metadata block/.test(block));
});

test('an imported draft quotes its metadata block and forbids writing one', () => {
  const block = draftBlock(fromMod('chat-1', imported()));
  assert.match(block, /do NOT write one into your code/);
  assert.ok(block.includes('@require     https://cdn.example.org/lib.js'), 'the model must be shown the block it must not drop');
});

// ---------------------------------------------------------------------------
// modsForUrl / modsBlock: what the model is told runs here
// ---------------------------------------------------------------------------

const onWiki = (over: Partial<Mod> = {}) => written({ id: 'a', name: 'Wiki A', matches: ['*://*.wikipedia.org/wiki/*'], ...over });
const onExample = (over: Partial<Mod> = {}) => written({ id: 'b', name: 'Example B', matches: ['*://example.com/*'], ...over });

test('modsForUrl lists only the mods whose patterns cover the URL', () => {
  const mods = [onWiki(), onExample()];
  assert.deepEqual(modsForUrl(mods, 'https://en.wikipedia.org/wiki/Kingfisher').map((m) => m.id), ['a']);
  assert.deepEqual(modsForUrl(mods, 'https://example.com/x').map((m) => m.id), ['b']);
  assert.deepEqual(modsForUrl(mods, 'https://nowhere.test/').map((m) => m.id), []);
});

test('modsForUrl honours wildcards, subdomains and @exclude', () => {
  const sub = written({ id: 'sub', matches: ['*://*.example.com/*'] });
  assert.equal(modsForUrl([sub], 'https://deep.sub.example.com/page').length, 1, 'a *. host must cover subdomains');
  // `*.` here is lib/mods urlMatches, which is glob expansion and deliberately display-only: it
  // needs a label before the dot, so the BARE host does not match even though Chrome's own matcher
  // would accept it. That is pre-existing behaviour, shared with the Mods tab's "on this site"
  // split, and pinned here because this list is now also what the MODEL is told about — the two
  // surfaces agree by construction, which is the property that matters. A script that cares lists
  // both patterns, as the line below does.
  assert.equal(modsForUrl([sub], 'http://example.com/').length, 0, 'a bare host is not covered by *.<host> in this matcher');
  assert.equal(
    modsForUrl([written({ id: 'bare', matches: ['*://example.com/*', '*://*.example.com/*'] })], 'http://example.com/').length,
    1,
    'a header that lists both patterns covers both',
  );
  const path = written({ id: 'p', matches: ['https://example.com/docs/*'] });
  assert.equal(modsForUrl([path], 'https://example.com/docs/a/b').length, 1);
  assert.equal(modsForUrl([path], 'https://example.com/other').length, 0, 'a path pattern must not cover the whole site');
  assert.equal(modsForUrl([path], 'http://example.com/docs/a').length, 0, 'an https-only pattern must not cover http');
  const excluded = written({ id: 'e', matches: ['*://*.example.com/*'], excludeMatches: ['*://*.example.com/admin/*'] });
  assert.equal(modsForUrl([excluded], 'https://example.com/admin/x').length, 0, '@exclude must remove a page the @match covered');
  const everywhere = written({ id: 'all', matches: ['*://*/*'] });
  assert.equal(modsForUrl([everywhere], 'https://anything.test/x').length, 1);
});

test('modsForUrl lists disabled mods too, and puts the linked one first', () => {
  const mods = [onWiki({ id: 'off', name: 'Zeta off', enabled: false }), onWiki({ id: 'on', name: 'Alpha on' }), onWiki({ id: 'mine', name: 'Mine' })];
  const listed = modsForUrl(mods, 'https://en.wikipedia.org/wiki/X', 'mine');
  // A mod switched off is still where a change belongs — a model that cannot see it writes a second
  // mod that fights the first the moment it is switched back on.
  assert.deepEqual(listed.map((m) => m.id), ['mine', 'on', 'off']);
  assert.equal(listed[0]!.linked, true);
  assert.equal(listed[2]!.enabled, false);
});

test('modsForUrl lists nothing for a page with no URL', () => {
  assert.deepEqual(modsForUrl([onWiki()], ''), []);
});

test('modsBlock names each mod, its state and which one this chat is editing', () => {
  const block = modsBlock(
    modsForUrl(
      [onWiki({ id: 'a', name: 'Wiki A', description: 'Hides the banner.' }), onWiki({ id: 'c', name: 'Wiki C', description: '', enabled: false })],
      'https://en.wikipedia.org/wiki/X',
      'a',
    ),
  );
  assert.match(block, /\[Mods already installed on this page: 2\]/);
  assert.match(block, /- a · "Wiki A" — Hides the banner\. · enabled · THIS CHAT IS EDITING THIS ONE/);
  assert.match(block, /- c · "Wiki C" · disabled/);
  assert.match(block, /open_mod/);
});

test('modsBlock is empty when nothing runs here, so a turn carries no empty heading', () => {
  assert.equal(modsBlock([]), '');
});

// ---------------------------------------------------------------------------
// open_mod over a draft
// ---------------------------------------------------------------------------

test('draftStanding tells an unsaved draft from a saved one', () => {
  assert.equal(draftStanding(null), 'none');
  assert.equal(draftStanding(createArtifact('c', draftOf())), 'unsaved');
  const saved = fromMod('c', written());
  assert.equal(draftStanding(saved), 'saved');
  // Saved, then the model proposed something: the mod holds v1, the draft is at v2.
  assert.equal(draftStanding({ ...saved, current: 2 }), 'unsaved');
});

test('open_mod is refused over an unsaved draft, and says both ways out', () => {
  const r = openModDecision('unsaved');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /unsaved changes/);
  assert.match((r as { reason: string }).reason, /replace: true/);
  // And it promises what adoptMod actually does, so the model is not lying to the user.
  assert.match((r as { reason: string }).reason, /versions are kept/);
});

test('open_mod is allowed with no draft, with a saved draft, or with replace', () => {
  assert.deepEqual(openModDecision('none'), { ok: true, noop: false });
  assert.deepEqual(openModDecision('saved'), { ok: true, noop: false });
  assert.deepEqual(openModDecision('unsaved', { replace: true }), { ok: true, noop: false });
});

test('open_mod on the mod this chat already edits is a no-op, not an error', () => {
  // Refusing it would teach the model not to be careful, which is the opposite of what is wanted.
  assert.deepEqual(openModDecision('unsaved', { alreadyLinked: true }), { ok: true, noop: true });
});

test('open_mod is a page-read budget neutral', () => {
  assert.ok(NEUTRAL_TOOLS.has('open_mod'));
  // Neither charged as a read (which would make the wanted behaviour cost investigation budget)…
  assert.equal(countReads(3, ['open_mod']), 3);
  // …nor credited as an act (which would clear a streak of reads that had earned a nudge).
  assert.equal(countReads(3, ['get_page', 'open_mod']), 4);
});

test('the open_mod tool is declared with mod_id and replace', () => {
  const tool = TOOLS.find((t) => t.name === 'open_mod');
  assert.ok(tool, 'open_mod must be offered to the model');
  const schema = tool!.inputSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
  assert.deepEqual(schema.required, ['mod_id']);
  assert.ok('replace' in schema.properties);
  assert.equal(schema.additionalProperties, false);
});

test('the system prompt teaches when to open a mod and when to make a new one', () => {
  assert.match(SYSTEM_PROMPT, /Mods already installed on this page/);
  assert.match(SYSTEM_PROMPT, /call open_mod with its id/);
  // The three branches the brief asks for, in one sentence each.
  assert.match(SYSTEM_PROMPT, /"also", "too", "as well"/);
  assert.match(SYSTEM_PROMPT, /unrelated to every mod listed, write a new one/);
  assert.match(SYSTEM_PROMPT, /cannot tell, ask in ONE sentence/);
  // And that it must not throw a metadata block away.
  assert.match(SYSTEM_PROMPT, /never propose a script that would drop its @require/);
  // Detaching is the user's to do, not the model's to fake.
  assert.match(SYSTEM_PROMPT, /Save as a new mod instead/);
});

// ---------------------------------------------------------------------------
// editModPlan: which chat a mod opens in
// ---------------------------------------------------------------------------

const chat = (id: string, over: Partial<Parameters<typeof editModPlan>[1][number]> = {}) => ({
  id,
  host: 'example.com',
  archived: false,
  updatedAt: 100,
  ...over,
});

test('a mod with a chat reuses that chat', () => {
  const plan = editModPlan('m1', [chat('c1'), chat('c2', { editingModId: 'm1' })], chat('c1'));
  assert.deepEqual(plan, { action: 'reuse', chatId: 'c2', unarchive: false });
});

test('reusing an archived chat unarchives it', () => {
  const plan = editModPlan('m1', [chat('c2', { editingModId: 'm1', archived: true })], null);
  assert.deepEqual(plan, { action: 'reuse', chatId: 'c2', unarchive: true });
});

test('when two chats edit one mod, the most recent wins', () => {
  const plan = editModPlan('m1', [chat('old', { editingModId: 'm1', updatedAt: 1 }), chat('new', { editingModId: 'm1', updatedAt: 9 })], null);
  assert.equal((plan as { chatId: string }).chatId, 'new');
});

test('an empty chat on screen is seeded rather than a new one created', () => {
  const plan = editModPlan('m1', [chat('c1')], chat('c1', { empty: true }));
  assert.deepEqual(plan, { action: 'seed', chatId: 'c1' });
});

test('a chat with an unsaved draft is never taken over', () => {
  // This is the addendum's rule: picking a mod must not silently discard work that exists nowhere
  // else, so the mod gets a chat of its own and the draft is left exactly where it was.
  const plan = editModPlan('m1', [chat('c1')], chat('c1', { unsaved: true, empty: false }));
  assert.deepEqual(plan, { action: 'create', because: 'busy' });
});

test('a chat with a transcript but no draft is also not taken over', () => {
  assert.deepEqual(editModPlan('m1', [chat('c1')], chat('c1', { empty: false })), { action: 'create', because: 'busy' });
});

test('with no chat on screen a mod gets a new chat', () => {
  assert.deepEqual(editModPlan('m1', [], null), { action: 'create', because: 'none' });
});

// ---------------------------------------------------------------------------
// Where a mod runs, for the "this does not run here" line
// ---------------------------------------------------------------------------

test('runsOnPage answers about the tab in front of the user', () => {
  assert.equal(runsOnPage(onWiki(), 'https://en.wikipedia.org/wiki/X'), true);
  assert.equal(runsOnPage(onWiki(), 'https://example.com/'), false);
  assert.equal(runsOnPage(onWiki(), ''), false);
});

test('likelyUrlFor derives a URL only from a pattern simple enough to be right', () => {
  assert.equal(likelyUrlFor(['*://*.example.com/*']), 'https://example.com/');
  assert.equal(likelyUrlFor(['https://example.com/docs/*']), 'https://example.com/docs/');
  assert.equal(likelyUrlFor(['https://example.com']), 'https://example.com/');
  // A host wildcard in the middle names no site, so nothing is offered rather than a wrong link.
  assert.equal(likelyUrlFor(['*://*/*']), '');
  assert.equal(likelyUrlFor([]), '');
});

// ---------------------------------------------------------------------------
// The duplicate guard
// ---------------------------------------------------------------------------

test('sameMatches ignores order but not content', () => {
  assert.equal(sameMatches(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameMatches(['a'], ['a', 'b']), false);
  assert.equal(sameMatches([], []), true);
});

test('a save that would twin an installed mod is caught by name AND reach', () => {
  const installed = [written({ id: 'x', name: 'Hide the promo banner', matches: ['*://*.wikipedia.org/wiki/*'] })];
  const twin = duplicateOf(installed, { name: 'hide the PROMO banner', matches: ['*://*.wikipedia.org/wiki/*'] });
  assert.equal(twin?.id, 'x', 'the name compares loosely, because the model retypes it every turn');
});

test('the same name on a different site is not a duplicate', () => {
  const installed = [written({ id: 'x', name: 'Dark mode', matches: ['*://a.example/*'] })];
  assert.equal(duplicateOf(installed, { name: 'Dark mode', matches: ['*://b.example/*'] }), undefined);
});

test('a different name with the same patterns is not a duplicate', () => {
  // Every mod for a site shares its patterns, so patterns alone would flag all of them.
  const installed = [written({ id: 'x', name: 'Hide the banner', matches: ['*://a.example/*'] })];
  assert.equal(duplicateOf(installed, { name: 'Widen the article', matches: ['*://a.example/*'] }), undefined);
});

test('the mod a chat is already linked to is never its own duplicate', () => {
  const installed = [written({ id: 'x', name: 'Hide it', matches: ['*://a.example/*'] })];
  assert.equal(duplicateOf(installed, { name: 'Hide it', matches: ['*://a.example/*'] }, 'x'), undefined);
});
