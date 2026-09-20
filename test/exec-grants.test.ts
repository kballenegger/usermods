// The capability table that replaces a self-declared modId on Safari's shared message channel.
//
// Every test here is one of the properties lib/exec/grants.ts promises in its header. They are
// security properties rather than behaviour, so they are written as the attack: forge an identity,
// reuse another frame's token, keep calling after the mod was turned off.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { GRANT_TTL_MS, GrantTable } from '../lib/exec/grants.ts';

/** Predictable tokens, so a test can name the one it means. Real minting is 32 CSPRNG bytes. */
function counter(prefix = 't') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const FRAME = { tabId: 7, frameId: 0 };
const NOW = 1_700_000_000_000;

function issue(table: GrantTable, modId: string, over: Partial<{ tabId: number; frameId: number; world: 'USER_SCRIPT' | 'MAIN' }> = {}) {
  return table.issue({ modId, world: over.world ?? 'USER_SCRIPT', tabId: over.tabId ?? FRAME.tabId, frameId: over.frameId ?? FRAME.frameId }, NOW);
}

test('the modId comes from the table, so a message cannot claim to be another mod', () => {
  const table = new GrantTable(counter());
  const mine = issue(table, 'mod-a')!;
  // The forgery this whole module exists to stop: a caller presenting its own token while naming
  // someone else's mod. There is nowhere to put the claim: resolve() takes the token alone.
  const grant = table.resolve(mine.token, FRAME, NOW);
  assert.equal(grant?.modId, 'mod-a');
});

test('two mods in one document get two different tokens, and neither resolves to the other', () => {
  const table = new GrantTable(counter());
  const a = issue(table, 'mod-a')!;
  const b = issue(table, 'mod-b')!;
  assert.notEqual(a.token, b.token);
  assert.equal(table.resolve(a.token, FRAME, NOW)?.modId, 'mod-a');
  assert.equal(table.resolve(b.token, FRAME, NOW)?.modId, 'mod-b');
});

test('a token only works from the frame it was issued to', () => {
  const table = new GrantTable(counter());
  const g = issue(table, 'mod-a')!;
  assert.ok(table.resolve(g.token, { tabId: 7, frameId: 0 }, NOW));
  // A leaked token presented from another tab, or from an iframe in the same tab, is refused. The
  // sender is filled in by the browser, so this is not a claim the caller can dress up.
  assert.equal(table.resolve(g.token, { tabId: 8, frameId: 0 }, NOW), null);
  assert.equal(table.resolve(g.token, { tabId: 7, frameId: 3 }, NOW), null);
  assert.equal(table.resolve(g.token, undefined, NOW), null);
  assert.equal(table.resolve(g.token, {}, NOW), null);
});

test('nothing but a live token resolves', () => {
  const table = new GrantTable(counter());
  issue(table, 'mod-a');
  for (const bogus of ['', 'nope', 't99', null, undefined, 0, 1, {}, [], true]) {
    assert.equal(table.resolve(bogus, FRAME, NOW), null, `${JSON.stringify(bogus)} must not resolve`);
  }
});

test('page-world code is refused a grant outright', () => {
  const table = new GrantTable(counter());
  // MAIN-world code runs where the page can read it, so a token handed there is a token the page
  // has. Chrome's MAIN world has no GM messaging either, so this is the existing contract.
  assert.equal(issue(table, 'mod-a', { world: 'MAIN' }), null);
  assert.equal(table.size, 0);
});

test('a grant expires on its own even if every revoke was missed', () => {
  const table = new GrantTable(counter());
  const g = issue(table, 'mod-a')!;
  assert.ok(table.resolve(g.token, FRAME, NOW + GRANT_TTL_MS));
  assert.equal(table.resolve(g.token, FRAME, NOW + GRANT_TTL_MS + 1), null);
  // The failed resolve drops it rather than leaving it to grow.
  assert.equal(table.size, 0);
});

test('prune drops the expired and keeps the live', () => {
  const table = new GrantTable(counter());
  const old = issue(table, 'mod-a')!;
  const fresh = table.issue({ modId: 'mod-b', world: 'USER_SCRIPT', ...FRAME }, NOW + GRANT_TTL_MS)!;
  table.prune(NOW + GRANT_TTL_MS + 1);
  assert.equal(table.resolve(old.token, FRAME, NOW + GRANT_TTL_MS + 1), null);
  assert.ok(table.resolve(fresh.token, FRAME, NOW + GRANT_TTL_MS + 1));
});

test('disabling a mod stops its running copy calling back', () => {
  const table = new GrantTable(counter());
  const a = issue(table, 'mod-a')!;
  const b = issue(table, 'mod-b')!;
  // Code already injected into a page cannot be un-run. What can be taken away is its capability,
  // which is the whole reason identity lives in a table the background owns.
  table.revokeMod('mod-a');
  assert.equal(table.resolve(a.token, FRAME, NOW), null);
  assert.ok(table.resolve(b.token, FRAME, NOW));
});

test('navigation revokes the frame, and the tab takes its subframes with it', () => {
  const table = new GrantTable(counter());
  const top = issue(table, 'mod-a')!;
  const sub = issue(table, 'mod-a', { frameId: 4 })!;
  const other = issue(table, 'mod-a', { tabId: 9 })!;
  table.revokeFrame(7, 4);
  assert.ok(table.resolve(top.token, { tabId: 7, frameId: 0 }, NOW));
  assert.equal(table.resolve(sub.token, { tabId: 7, frameId: 4 }, NOW), null);
  table.revokeTab(7);
  assert.equal(table.resolve(top.token, { tabId: 7, frameId: 0 }, NOW), null);
  assert.ok(table.resolve(other.token, { tabId: 9, frameId: 0 }, NOW));
});

test('forMod finds every frame of one mod and no one else', () => {
  const table = new GrantTable(counter());
  issue(table, 'mod-a');
  issue(table, 'mod-a', { frameId: 2 });
  issue(table, 'mod-b');
  const mine = table.forMod('mod-a');
  assert.equal(mine.length, 2);
  assert.deepEqual(
    mine.map((g) => g.frameId).sort(),
    [0, 2],
  );
  assert.equal(table.forMod('mod-c').length, 0);
});

test('revokeToken drops exactly one grant', () => {
  const table = new GrantTable(counter());
  const a = issue(table, 'mod-a')!;
  const b = issue(table, 'mod-a', { frameId: 1 })!;
  table.revokeToken(a.token);
  assert.equal(table.resolve(a.token, FRAME, NOW), null);
  assert.ok(table.resolve(b.token, { tabId: 7, frameId: 1 }, NOW));
});
