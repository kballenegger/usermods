// run_script and navigation: a same-document navigation (history.pushState, replaceState, a hash
// change) is not the page going away. Chrome fires tabs.onUpdated status 'loading' for both, and
// the run used to be told "the page navigated, the script's result was lost" on a single-page app
// whose script finished normally. lib/navwatch.ts decides by the document's own identity instead.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeDocument, RECHECK_MS, watchDocument, type NavWatchDeps } from '../lib/navwatch.ts';

/** A fake tab: its current document token and status, and a manual clock for the rechecks. */
function fakeTab(token: string | null = 'doc-1') {
  const state = { token, status: 'complete' as string | undefined, reads: 0 };
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  let now = 0;
  const deps: NavWatchDeps = {
    async docToken() {
      state.reads++;
      if (state.token === null) throw new Error('Cannot access contents of the page');
      return state.token;
    },
    async tabStatus() {
      return state.status;
    },
    schedule(fn, ms) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers) if (t.live && t.at <= now) {
      t.live = false;
      t.fn();
    }
    await settle();
  };
  return { state, deps, advance, pending: () => timers.filter((t) => t.live).length };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('the decision: only the same readable document is the same document', () => {
  assert.equal(judgeDocument('a', 'a'), 'same-document');
  assert.equal(judgeDocument('a', 'b'), 'navigated');
  assert.equal(judgeDocument('a', null), 'navigated', 'a page scripts cannot reach is somewhere else');
  assert.equal(judgeDocument(null, 'a'), 'navigated', 'no baseline: behave as before, a loading ends the wait');
});

test('a pushState (loading, then complete, same document) does not end the run', async () => {
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.status = 'loading';
  w.onUpdated({ status: 'loading', url: 'https://app.example/route2' });
  await settle();
  tab.state.status = 'complete';
  w.onUpdated({ status: 'complete' });
  await tab.advance(RECHECK_MS);
  await tab.advance(RECHECK_MS);
  assert.deepEqual(seen, []);
  assert.equal(tab.pending(), 0, 'nothing keeps polling once the tab has settled');
  w.stop();
});

test('a real navigation (new document by the time loading fires, as Chrome does) is reported at once, with its URL', async () => {
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.token = 'doc-2';
  tab.state.status = 'loading';
  w.onUpdated({ status: 'loading', url: 'https://example.com/other' });
  await settle();
  assert.deepEqual(seen, ['https://example.com/other']);
  // …and only once, whatever else the tab reports.
  w.onUpdated({ status: 'loading', url: 'https://example.com/again' });
  await settle();
  assert.deepEqual(seen, ['https://example.com/other']);
});

test('a navigation to a page scripts cannot reach counts as navigated', async () => {
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.token = null;
  w.onUpdated({ status: 'loading' }, 'https://chromewebstore.google.com/');
  await settle();
  assert.deepEqual(seen, ['https://chromewebstore.google.com/']);
});

test('a loading that arrives before the new document commits is caught by the recheck', async () => {
  // Not what Chrome does today, but tabs.onUpdated timing is unspecified (and Safari's may differ):
  // the old document still answers, the tab is still loading, so it is read again until it is not.
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.status = 'loading';
  w.onUpdated({ status: 'loading', url: 'https://example.com/slow' });
  await settle();
  assert.deepEqual(seen, []);
  await tab.advance(RECHECK_MS);
  assert.deepEqual(seen, [], 'still the old document while the response is in flight');
  tab.state.token = 'doc-2';
  await tab.advance(RECHECK_MS);
  assert.deepEqual(seen, ['https://example.com/slow']);
  assert.equal(tab.pending(), 0);
});

test('a navigation that never commits (a download, a 204) leaves the run waiting for its report', async () => {
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.status = 'loading';
  w.onUpdated({ status: 'loading', url: 'https://example.com/file.zip' });
  await tab.advance(RECHECK_MS);
  tab.state.status = 'complete';
  await tab.advance(RECHECK_MS);
  assert.deepEqual(seen, []);
  assert.equal(tab.pending(), 0);
});

test('without a start token (the page could not be read) a loading ends the run, as it always did', async () => {
  const tab = fakeTab(null);
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.token = 'doc-1';
  w.onUpdated({ status: 'loading', url: 'https://example.com/x' });
  await settle();
  assert.deepEqual(seen, ['https://example.com/x']);
});

test('events that are not a loading, and anything after stop(), do nothing', async () => {
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.token = 'doc-2';
  w.onUpdated({ status: 'complete' });
  w.onUpdated({ url: 'https://example.com/moved' });
  await settle();
  assert.deepEqual(seen, []);
  assert.equal(tab.state.reads, 1, 'only the start token was read');
  w.stop();
  w.onUpdated({ status: 'loading' });
  await settle();
  assert.deepEqual(seen, []);
});

test('stop() cancels a pending recheck', async () => {
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.status = 'loading';
  w.onUpdated({ status: 'loading' });
  await settle();
  assert.equal(tab.pending(), 1);
  w.stop();
  tab.state.token = 'doc-2';
  await tab.advance(RECHECK_MS);
  assert.deepEqual(seen, []);
});

test('ready settles only once the starting document has been read, and also when it cannot be', async () => {
  // The caller injects the run after `ready`, so a script whose first statement navigates cannot
  // have its NEW document read as the start (that would make its navigation look like a pushState).
  let release: (t: string | null) => void = () => {};
  const deps: NavWatchDeps = {
    docToken: () => new Promise((r) => (release = r)),
    tabStatus: async () => 'complete',
    schedule: () => () => {},
  };
  const w = watchDocument(deps, () => {});
  let ready = false;
  void w.ready.then(() => (ready = true));
  await settle();
  assert.equal(ready, false, 'not before the read answers');
  release('doc-1');
  await settle();
  assert.equal(ready, true);
  const failing = watchDocument({ ...deps, docToken: () => Promise.reject(new Error('no access')) }, () => {});
  await failing.ready; // resolves, never rejects
  w.stop();
  failing.stop();
});

test('a read still in flight when the run ends reports nothing afterwards', async () => {
  let reads = 0;
  let late: (t: string) => void = () => {};
  const deps: NavWatchDeps = {
    docToken: () => (++reads === 1 ? Promise.resolve('doc-1') : new Promise((r) => (late = r))),
    tabStatus: async () => 'loading',
    schedule: () => () => {},
  };
  const seen: string[] = [];
  const w = watchDocument(deps, (u) => seen.push(u));
  await settle();
  w.onUpdated({ status: 'loading', url: 'https://example.com/next' });
  await settle();
  w.stop();
  late('doc-2');
  await settle();
  assert.deepEqual(seen, []);
});

test('a loading that lands while a read is in flight gets a read of its own', async () => {
  // pushState, then a real navigation a moment later: the first read sees the old document, and
  // the second event must not be swallowed by it.
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.status = 'loading';
  w.onUpdated({ status: 'loading', url: 'https://app.example/route' });
  tab.state.token = 'doc-2';
  w.onUpdated({ status: 'loading', url: 'https://example.com/elsewhere' });
  await settle();
  await settle();
  assert.deepEqual(seen, ['https://example.com/elsewhere']);
});

test('a tab that disappears during a recheck ends the run as closed', async () => {
  const tab = fakeTab();
  const seen: string[] = [];
  const w = watchDocument(tab.deps, (u) => seen.push(u));
  await settle();
  tab.state.status = undefined;
  w.onUpdated({ status: 'loading' });
  await settle();
  assert.deepEqual(seen, ['a closed tab']);
});
