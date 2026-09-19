// The per-chat draft mod: how versions accumulate, what a rollback does to the history, whether
// the diff says the right thing, and that a draft survives a round trip through buildSource.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addVersion,
  artifactKey,
  createArtifact,
  currentVersion,
  diffLines,
  diffText,
  draftBlock,
  draftHeadline,
  fromMod,
  lineCount,
  proposalCardLabel,
  proposalCardState,
  rollbackTo,
  toProposal,
  toSource,
  type Artifact,
  type NewVersion,
} from '../lib/artifact.ts';
import { capChats, itemsKey, messagesKey, type Chat } from '../lib/chats.ts';
import { parseHeader, stripHeader } from '../lib/mods.ts';
import type { Mod } from '../lib/types';

const V1 = `const style = document.createElement('style');
style.textContent = '.sidebar { display: none !important; }';
document.head.appendChild(style);`;

const V2 = `const style = document.createElement('style');
style.textContent = '.sidebar { display: none !important; } .button { color: blue; }';
document.head.appendChild(style);`;

function draft(over: Partial<NewVersion> = {}): NewVersion {
  return {
    code: V1,
    name: 'Wikipedia: full-width article',
    description: 'Hides the sidebar.',
    matches: ['*://*.wikipedia.org/wiki/*'],
    source: 'proposal',
    ...over,
  };
}

/** An artifact at v1, with a fixed id and timestamp so assertions can be exact. */
function seed(): Artifact {
  return createArtifact('chat-1', draft(), 1000, 'art-1');
}

// ---------- versions ----------

test('the first proposal creates v1 and makes it current', () => {
  const a = seed();
  assert.equal(a.chatId, 'chat-1');
  assert.equal(a.versions.length, 1);
  assert.equal(a.current, 1);
  assert.equal(currentVersion(a)?.code, V1);
  // The top-level mirror is the current version's, so a one-line renderer needs no lookup.
  assert.equal(a.name, 'Wikipedia: full-width article');
  assert.deepEqual(a.matches, ['*://*.wikipedia.org/wiki/*']);
  assert.equal(a.versions[0]?.source, 'proposal');
});

test('a changed proposal appends v2 and moves current, leaving v1 readable', () => {
  const a = addVersion(seed(), draft({ code: V2 }), 2000);
  assert.equal(a.versions.length, 2);
  assert.equal(a.current, 2);
  assert.equal(currentVersion(a)?.code, V2);
  // v1 is still exactly what it was: the history is append-only.
  assert.equal(a.versions[0]?.code, V1);
  assert.equal(a.versions[0]?.n, 1);
});

test('an identical consecutive proposal is deduped rather than becoming a version', () => {
  const a = seed();
  const again = addVersion(a, draft(), 2000);
  assert.equal(again.versions.length, 1, 'the model re-proposing the same script is not a new draft');
  assert.equal(again.current, 1);
});

test('dedupe compares the whole draft, not just the code', () => {
  const a = seed();
  assert.equal(addVersion(a, draft({ name: 'Something else' }), 2000).versions.length, 2, 'a rename is a change');
  assert.equal(addVersion(a, draft({ description: 'Different.' }), 2000).versions.length, 2, 'a new description is a change');
  assert.equal(addVersion(a, draft({ matches: ['*://example.com/*'] }), 2000).versions.length, 2, 'new match patterns are a change');
});

test('dedupe is only about the CONSECUTIVE version: going back to old code is a real version', () => {
  let a = seed();
  a = addVersion(a, draft({ code: V2 }), 2000);
  a = addVersion(a, draft({ code: V1 }), 3000);
  assert.equal(a.versions.length, 3, 'returning to v1’s code is something that happened and is recorded');
  assert.equal(a.current, 3);
  assert.equal(currentVersion(a)?.code, V1);
});

test('a re-proposal that changes only the untested caveat updates it without inventing a version', () => {
  const a = addVersion(seed(), draft({ untestedReason: 'the page would not let me run it' }), 2000);
  assert.equal(a.versions.length, 1);
  assert.equal(a.untestedReason, 'the page would not let me run it');
  // …and a version that IS testable clears it again.
  const cleared = addVersion(a, draft(), 3000);
  assert.equal(cleared.versions.length, 1);
  assert.equal(cleared.untestedReason, undefined);
});

test('version numbers never repeat, even across a rollback', () => {
  let a = seed();
  a = addVersion(a, draft({ code: V2 }), 2000);
  a = rollbackTo(a, 1, 3000);
  a = addVersion(a, draft({ code: 'other()' }), 4000);
  assert.deepEqual(a.versions.map((v) => v.n), [1, 2, 3, 4]);
});

test('addVersion does not mutate the artifact it was given', () => {
  const a = seed();
  const before = JSON.stringify(a);
  addVersion(a, draft({ code: V2 }), 2000);
  assert.equal(JSON.stringify(a), before);
});

// ---------- the saved state of a proposal card ----------
//
// The owner's report: he saved the mod the model proposed, asked for a change, and the SECOND
// proposal card came up already reading as saved. The old rule was a `saved` boolean stamped onto
// every proposal row in the transcript at save time, which answered "did this chat ever save?" and
// was read as "is this script installed?" — two different questions the moment the model revises
// the draft. These pin the derived rule down: saved-ness belongs to a VERSION.

test('a proposal card in a chat that has never saved offers a plain save', () => {
  const a = seed();
  assert.equal(proposalCardState(a, 1), 'unsaved');
  assert.equal(proposalCardLabel(proposalCardState(a, 1)), 'Save & enable');
});

test('after a save, the card for the saved version — and only it — reads as saved', () => {
  const saved: Artifact = { ...seed(), linkedModId: 'mod-1', savedVersion: 1 };
  assert.equal(proposalCardState(saved, 1), 'saved');
  assert.equal(proposalCardLabel(proposalCardState(saved, 1)), 'Saved · enabled');
});

test("the owner's bug: a SECOND proposal after a save does not inherit the first card's saved state", () => {
  // v1 proposed and saved…
  const saved: Artifact = { ...seed(), linkedModId: 'mod-1', savedVersion: 1 };
  // …then the model revises it: "Updating the mod so those span titles get caught too."
  const revised = addVersion(saved, draft({ code: V2 }), 2000);

  assert.equal(revised.current, 2, 'the revision is a new version of the SAME draft');
  assert.equal(revised.linkedModId, 'mod-1', 'it stays linked to the mod the first save created');
  assert.equal(revised.savedVersion, 1, 'the mod still holds v1: nothing has saved v2 yet');

  // The new card must not claim to be installed.
  assert.equal(proposalCardState(revised, 2), 'update');
  assert.equal(proposalCardLabel(proposalCardState(revised, 2)), 'Save & update mod');

  // v1's card goes on reading as saved, and that is correct rather than stale: the mod really does
  // still hold v1 until the user saves the revision. This is the whole difference from the boolean
  // it replaced — "saved" now names a version, so it can be true of one card and false of another
  // at the same time, which is exactly the situation the owner was looking at.
  assert.equal(proposalCardState(revised, 1), 'saved');
});

test('a card with no recorded version never claims to be the saved one', () => {
  const saved: Artifact = { ...seed(), linkedModId: 'mod-1', savedVersion: 1 };
  assert.equal(proposalCardState(saved, undefined), 'update', 'it offers the update rather than guessing');
});

test('with no draft at all there is nothing to save from', () => {
  assert.equal(proposalCardState(null, 1), 'none');
});

test('saving the revision moves saved-ness to it, and the old card gives the claim up', () => {
  const saved: Artifact = { ...seed(), linkedModId: 'mod-1', savedVersion: 1 };
  const revised = addVersion(saved, draft({ code: V2 }), 2000);
  // What entrypoints/background.ts:saveArtifactAsMod writes after the second save.
  const resaved: Artifact = { ...revised, linkedModId: 'mod-1', savedVersion: revised.current };

  assert.equal(proposalCardState(resaved, 2), 'saved');
  assert.equal(proposalCardState(resaved, 1), 'update', 'v1 is no longer what is installed');
  assert.equal(resaved.linkedModId, 'mod-1', 'still one mod, not two');
});

test('a chat started from an existing mod opens already saved at v1, not offering to save it again', () => {
  const mod: Mod = {
    id: 'mod-9',
    name: 'Wikipedia: full-width article',
    description: 'Hides the sidebar.',
    matches: ['*://*.wikipedia.org/wiki/*'],
    source: toSource(seed()),
    enabled: true,
    version: '1.0.0',
    createdAt: 1,
    updatedAt: 1,
  } as Mod;
  const a = fromMod('chat-2', mod, 1000, 'art-2');
  assert.equal(a.linkedModId, 'mod-9');
  assert.equal(a.savedVersion, a.current);
  assert.equal(proposalCardState(a, a.current), 'saved');
});

// ---------- rollback ----------

test('rolling back appends the old code as a new version rather than truncating the history', () => {
  let a = seed();
  a = addVersion(a, draft({ code: V2 }), 2000);
  a = rollbackTo(a, 1, 3000);

  assert.equal(a.versions.length, 3, 'nothing is thrown away: v2 is still there to roll forward to');
  assert.equal(a.current, 3);
  assert.equal(currentVersion(a)?.code, V1, 'the draft is v1’s code again');
  assert.equal(a.versions[2]?.source, 'rollback');
  assert.equal(a.versions[1]?.code, V2);
});

test('a rollback is itself undoable, by rolling back to the version it replaced', () => {
  let a = seed();
  a = addVersion(a, draft({ code: V2 }), 2000);
  a = rollbackTo(a, 1, 3000); // v3 == v1
  a = rollbackTo(a, 2, 4000); // v4 == v2
  assert.equal(currentVersion(a)?.code, V2);
  assert.equal(a.versions.length, 4);
});

test('rolling back to the current version, or to one that does not exist, changes nothing', () => {
  const a = addVersion(seed(), draft({ code: V2 }), 2000);
  assert.equal(rollbackTo(a, 2, 3000), a, 'already current');
  assert.equal(rollbackTo(a, 99, 3000), a, 'no such version');
});

test('a rollback restores the name and matches of the version it goes back to, not just the code', () => {
  let a = seed();
  a = addVersion(a, draft({ code: V2, name: 'Renamed', matches: ['*://example.com/*'] }), 2000);
  a = rollbackTo(a, 1, 3000);
  assert.equal(a.name, 'Wikipedia: full-width article');
  assert.deepEqual(a.matches, ['*://*.wikipedia.org/wiki/*']);
});

// ---------- diff ----------

test('an unchanged text produces no hunks at all', () => {
  assert.deepEqual(diffLines(V1, V1), []);
  assert.equal(diffText(V1, V1), '');
});

test('a replaced line shows as one deletion and one addition', () => {
  const hunks = diffLines('a\nb\nc', 'a\nB\nc');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0]?.lines, [' a', '-b', '+B', ' c']);
  assert.equal(hunks[0]?.oldStart, 1);
  assert.equal(hunks[0]?.newStart, 1);
});

test('an inserted line is an addition with no deletion', () => {
  const hunks = diffLines('a\nc', 'a\nb\nc');
  assert.deepEqual(hunks[0]?.lines, [' a', '+b', ' c']);
  assert.equal(hunks[0]?.oldLines, 2);
  assert.equal(hunks[0]?.newLines, 3);
});

test('a deleted line is a deletion with no addition', () => {
  const hunks = diffLines('a\nb\nc', 'a\nc');
  assert.deepEqual(hunks[0]?.lines, [' a', '-b', ' c']);
  assert.equal(hunks[0]?.oldLines, 3);
  assert.equal(hunks[0]?.newLines, 2);
});

test('an empty original is all additions, and an emptied text is all deletions', () => {
  assert.deepEqual(diffLines('', 'a\nb')[0]?.lines, ['+a', '+b']);
  assert.deepEqual(diffLines('a\nb', '')[0]?.lines, ['-a', '-b']);
});

test('changes far apart become separate hunks; changes close together share one', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const far = a.split('\n');
  far[1] = 'CHANGED near the top';
  far[28] = 'CHANGED near the bottom';
  assert.equal(diffLines(a, far.join('\n')).length, 2, '27 unchanged lines between them is two hunks');

  const near = a.split('\n');
  near[10] = 'CHANGED';
  near[12] = 'ALSO CHANGED';
  assert.equal(diffLines(a, near.join('\n')).length, 1, 'one unchanged line between them is a single hunk');
});

test('the unified output is exactly what a reader expects', () => {
  // The snapshot. A change to the hunk header format or the context width is a change to what the
  // Diff toggle shows, and should have to be made deliberately here first.
  const before = ['function greet(name) {', "  const el = document.createElement('div');", "  el.textContent = 'hello ' + name;", '  document.body.appendChild(el);', '}'].join('\n');
  const after = ['function greet(name) {', "  const el = document.createElement('div');", "  el.textContent = 'hi ' + name;", "  el.style.color = 'blue';", '  document.body.appendChild(el);', '}'].join('\n');
  assert.equal(
    diffText(before, after),
    [
      '@@ -1,5 +1,6 @@',
      ' function greet(name) {',
      "   const el = document.createElement('div');",
      "-  el.textContent = 'hello ' + name;",
      "+  el.textContent = 'hi ' + name;",
      "+  el.style.color = 'blue';",
      '   document.body.appendChild(el);',
      ' }',
    ].join('\n'),
  );
});

test('the diff between two real draft versions names the line that moved', () => {
  const hunks = diffLines(V1, V2);
  const changed = hunks.flatMap((h) => h.lines).filter((l) => l.startsWith('-') || l.startsWith('+'));
  assert.equal(changed.length, 2);
  assert.ok(changed[1]?.includes('color: blue'), `the addition should carry the new rule, got ${JSON.stringify(changed[1])}`);
});

test('a trailing newline is not reported as a changed line', () => {
  assert.deepEqual(diffLines('a\nb\n', 'a\nb'), []);
});

// ---------- source round trip ----------

test('toSource emits a userscript whose header parses back to the draft', () => {
  const a = seed();
  const source = toSource(a);
  const header = parseHeader(source);
  assert.equal(header.name, a.name);
  assert.equal(header.description, a.description);
  assert.deepEqual(header.matches, a.matches);
  // The body survives byte for byte, which is what makes Export and Save the same script the user
  // was looking at in the panel.
  assert.equal(stripHeader(source).trim(), V1);
});

test('a draft round trips through a mod and back without drifting', () => {
  const a = seed();
  const mod: Mod = { ...baseMod(), id: 'mod-1', name: a.name, description: a.description, matches: a.matches, source: toSource(a) };
  const back = fromMod('chat-2', mod, 5000, 'art-2');
  assert.equal(currentVersion(back)?.code, V1, 'the body came back unchanged');
  assert.equal(back.name, a.name);
  assert.deepEqual(back.matches, a.matches);
  assert.equal(back.linkedModId, 'mod-1', 'an artifact seeded from a mod is already linked to it');
  assert.equal(back.versions[0]?.source, 'user-edit');
});

test('toProposal hands the current version to the paths that speak ModProposal', () => {
  const a = addVersion(seed(), draft({ code: V2, untestedReason: 'could not run here' }), 2000);
  const p = toProposal(a);
  assert.equal(p?.code, V2);
  assert.equal(p?.untestedReason, 'could not run here');
});

// ---------- the block the model sees ----------

test('the draft headline says the version, the name, the matches and the size', () => {
  const line = draftHeadline(seed());
  assert.match(line, /^\[Current draft mod v1 "Wikipedia: full-width article" · matches \*:\/\/\*\.wikipedia\.org\/wiki\/\* · 3 lines\]$/);
});

test('the draft block carries the full current code, fenced, and marks itself as user-side', () => {
  const block = draftBlock(addVersion(seed(), draft({ code: V2 }), 2000));
  assert.ok(block.includes('v2'), 'it names the version the model is editing');
  assert.ok(block.includes(V2), 'the model is given the whole script, not a summary');
  assert.ok(!block.includes(V1), 'only the current version is sent');
  assert.ok(/not page content/i.test(block), 'the block says what it is, so page text cannot pose as it');
  assert.ok(block.includes('```'), 'the code is fenced so its own text cannot end the block');
});

test('lineCount counts what a reader would count', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('one'), 1);
  assert.equal(lineCount('one\ntwo\n'), 2, 'a trailing newline is not a line');
});

// ---------- storage keys and cleanup ----------

test('an artifact is keyed by its chat, so nothing else can read or overwrite it', () => {
  assert.equal(artifactKey('abc'), 'chat:abc:artifact');
  assert.notEqual(artifactKey('abc'), artifactKey('abd'));
});

test('the chat cap evicts artifacts along with the transcripts it drops', () => {
  // capChats names the ids that go; the background removes all three keys for each. This asserts
  // the artifact key is derivable for exactly those ids, which is what keeps a dropped chat from
  // leaving its draft behind in storage forever.
  const chats: Chat[] = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    host: 'example.com',
    title: `c${i}`,
    createdAt: i,
    updatedAt: i,
  }));
  const { kept, dropped } = capChats(chats, 3);
  assert.deepEqual(dropped.sort(), ['c0', 'c1']);
  assert.equal(kept.length, 3);
  const removed = dropped.flatMap((id) => [messagesKey(id), itemsKey(id), artifactKey(id)]);
  assert.deepEqual(removed, ['chat:c0:messages', 'chat:c0:items', 'chat:c0:artifact', 'chat:c1:messages', 'chat:c1:items', 'chat:c1:artifact']);
});

/** A Mod with the fields fromMod reads; the rest are defaults nothing here looks at. */
function baseMod(): Mod {
  return {
    id: 'mod-0',
    name: '',
    description: '',
    version: '1.0',
    matches: [],
    excludeMatches: [],
    includeGlobs: [],
    excludeGlobs: [],
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    allFrames: true,
    grants: [],
    connect: [],
    requires: [],
    resources: [],
    source: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}
