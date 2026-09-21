// Which mods a document gets, when they run, and the ledger that stops one running twice.
//
// On Chrome the browser does the matching, the frame rule and the timing. Under the content-script
// engine usermods does all three itself, so all three are tested here rather than trusted.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { LEDGER_TTL_MS, RunLedger, modsToRun, phaseFor, phasesElapsed } from '../lib/exec/plan.ts';
import type { Mod } from '../lib/types.ts';

function mod(over: Partial<Mod> = {}): Mod {
  return {
    id: 'm1',
    name: 'test',
    description: '',
    version: '1.0',
    matches: ['*://example.com/*'],
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
    source: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const TOP = { url: 'https://example.com/page', topFrame: true };

test('an enabled matching mod runs in the top frame', () => {
  assert.deepEqual(
    modsToRun([mod()], TOP).map((m) => m.id),
    ['m1'],
  );
});

test('a disabled mod never runs, whatever it matches', () => {
  assert.deepEqual(modsToRun([mod({ enabled: false })], TOP), []);
});

test('a mod that does not match the url does not run', () => {
  assert.deepEqual(modsToRun([mod()], { url: 'https://other.com/', topFrame: true }), []);
});

test('excludeMatches wins over matches, as it does on Chrome', () => {
  assert.deepEqual(modsToRun([mod({ excludeMatches: ['*://example.com/page*'] })], TOP), []);
});

test('allFrames:false keeps a mod out of a subframe', () => {
  const sub = { url: 'https://example.com/page', topFrame: false };
  assert.deepEqual(modsToRun([mod()], sub), []);
  assert.deepEqual(
    modsToRun([mod({ allFrames: true })], sub).map((m) => m.id),
    ['m1'],
  );
});

test('a mod matching nothing runs nowhere, rather than everywhere', () => {
  // register() rejects one of these on Chrome. The dangerous reading of "no patterns" is "all
  // patterns", so it is worth an explicit test rather than an implicit filter.
  assert.deepEqual(modsToRun([mod({ matches: [], includeGlobs: [] })], TOP), []);
});

test('a document with no url gets nothing', () => {
  assert.deepEqual(modsToRun([mod({ matches: ['<all_urls>'] })], { url: '', topFrame: true }), []);
});

test('the saved order is the run order', () => {
  const list = [mod({ id: 'a' }), mod({ id: 'b' }), mod({ id: 'c' })];
  assert.deepEqual(
    modsToRun(list, TOP).map((m) => m.id),
    ['a', 'b', 'c'],
  );
});

test('runAt maps onto the three phases the runner can wait for', () => {
  assert.equal(phaseFor('document_start'), 'start');
  assert.equal(phaseFor('document_end'), 'end');
  assert.equal(phaseFor('document_idle'), 'idle');
});

test('a claim answered late still runs what has already passed', () => {
  // The failure this prevents: the background was suspended, the reply arrives after load, and a
  // document_end mod waits for a DOMContentLoaded that fired ten seconds ago.
  assert.deepEqual(phasesElapsed('complete'), ['start', 'end', 'idle']);
  assert.deepEqual(phasesElapsed('interactive'), ['start', 'end']);
  assert.deepEqual(phasesElapsed('loading'), ['start']);
  assert.deepEqual(phasesElapsed('nonsense'), ['start']);
});

test('a repeated claim replays instead of minting a second run', () => {
  const ledger = new RunLedger<string>();
  const sender = { tabId: 3, frameId: 0 };
  assert.equal(ledger.replay('doc-1', sender, 100), null);
  ledger.record('doc-1', sender, 'scripts-for-doc-1', 100);
  assert.equal(ledger.replay('doc-1', sender, 200), 'scripts-for-doc-1');
});

test('a docKey presented from another frame reads nothing', () => {
  const ledger = new RunLedger<string>();
  ledger.record('doc-1', { tabId: 3, frameId: 0 }, 'secret', 100);
  // The key is page-side data, so a collision, accidental or arranged, must not cross frames.
  assert.equal(ledger.replay('doc-1', { tabId: 3, frameId: 9 }, 100), null);
  assert.equal(ledger.replay('doc-1', { tabId: 4, frameId: 0 }, 100), null);
});

test('a claim record expires, and the expiry drops it', () => {
  const ledger = new RunLedger<string>();
  ledger.record('doc-1', { tabId: 3, frameId: 0 }, 'x', 0);
  assert.equal(ledger.replay('doc-1', { tabId: 3, frameId: 0 }, LEDGER_TTL_MS), 'x');
  assert.equal(ledger.replay('doc-1', { tabId: 3, frameId: 0 }, LEDGER_TTL_MS + 1), null);
  assert.equal(ledger.size, 0);
});

test('a reload is a new document, so it runs again', () => {
  const ledger = new RunLedger<string>();
  const sender = { tabId: 3, frameId: 0 };
  ledger.record('doc-1', sender, 'first', 100);
  // The runner generates a fresh key per document, so a same-url reload simply misses the ledger.
  assert.equal(ledger.replay('doc-2', sender, 100), null);
});

test('forgetting a frame or a tab clears its records', () => {
  const ledger = new RunLedger<string>();
  ledger.record('a', { tabId: 1, frameId: 0 }, 'x', 0);
  ledger.record('b', { tabId: 1, frameId: 2 }, 'y', 0);
  ledger.record('c', { tabId: 2, frameId: 0 }, 'z', 0);
  ledger.forgetFrame(1, 2);
  assert.equal(ledger.size, 2);
  ledger.forgetTab(1);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.replay('c', { tabId: 2, frameId: 0 }, 0), 'z');
});

test('prune clears the stale and keeps the fresh', () => {
  const ledger = new RunLedger<string>();
  ledger.record('old', { tabId: 1, frameId: 0 }, 'x', 0);
  ledger.record('new', { tabId: 1, frameId: 1 }, 'y', LEDGER_TTL_MS);
  ledger.prune(LEDGER_TTL_MS + 1);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.replay('new', { tabId: 1, frameId: 1 }, LEDGER_TTL_MS + 1), 'y');
});
