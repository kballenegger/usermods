// Run records: how a worker that has just started finds the runs that died with the last one, and
// what the panel is told it can resume. Plus the two transcript reductions that go with it.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFor, activityFromEvent, activityText, IDLE_ACTIVITY, STALL_MS } from '../lib/activity.ts';
import { markInterrupted, parseRuns, pruneRuns, resumableRuns, type RunMap } from '../lib/runstate.ts';
import { INTERRUPTED_TOOL_SUMMARY, looksUnfinished, reduceItems, settleInterrupted } from '../lib/transcript.ts';
import type { ChatItem } from '../lib/types.ts';

const rec = (state: 'running' | 'failed' | 'interrupted', error?: string) => ({ state, tabId: 7, startedAt: 100, updatedAt: 100, ...(error ? { error } : {}) });

// ---------- interrupted-run detection ----------

test('at worker start, every run recorded as in flight with no live session is interrupted', () => {
  const runs: RunMap = { a: rec('running'), b: rec('failed', '503'), c: rec('running') };
  const out = markInterrupted(runs, () => false, 500);
  assert.deepEqual(out.interrupted, ['a', 'c']);
  assert.equal(out.runs.a!.state, 'interrupted');
  assert.equal(out.runs.a!.updatedAt, 500);
  assert.equal(out.runs.a!.startedAt, 100, 'when it started is kept');
  assert.deepEqual(out.runs.b, runs.b, 'a failed run is already resumable and is left alone');
  assert.equal(runs.a!.state, 'running', 'the input is not mutated');
});

test('a run that is really in flight in this worker is not touched', () => {
  const runs: RunMap = { live: rec('running'), dead: rec('running') };
  const out = markInterrupted(runs, (id) => id === 'live');
  assert.deepEqual(out.interrupted, ['dead']);
  assert.equal(out.runs.live!.state, 'running');
});

test('nothing to mark returns the same map, so the caller skips the write', () => {
  const runs: RunMap = { a: rec('failed', 'x'), b: rec('interrupted') };
  assert.equal(markInterrupted(runs, () => false).runs, runs);
  assert.equal(markInterrupted({}, () => false).interrupted.length, 0);
});

test('only stopped-short runs are resumable, and a failure carries its reason', () => {
  assert.deepEqual(resumableRuns({ a: rec('running'), b: rec('failed', '429 slow down'), c: rec('interrupted') }), {
    b: { state: 'failed', error: '429 slow down' },
    c: { state: 'interrupted' },
  });
});

test('records of chats that no longer exist are dropped', () => {
  const runs: RunMap = { keep: rec('failed', 'x'), gone: rec('interrupted') };
  assert.deepEqual(Object.keys(pruneRuns(runs, new Set(['keep']))), ['keep']);
  assert.equal(pruneRuns(runs, new Set(['keep', 'gone'])), runs);
});

test('whatever is in storage is read defensively', () => {
  assert.deepEqual(parseRuns(undefined), {});
  assert.deepEqual(parseRuns('nope'), {});
  assert.deepEqual(parseRuns({ a: null, b: { state: 'exploded' }, c: { state: 'failed', error: 5 } }), { c: { state: 'failed', tabId: -1, startedAt: 0, updatedAt: 0 } });
});

// ---------- tidying an interrupted transcript ----------

test('an interrupted transcript: the dangling tool row is closed and the queued bubble handed back', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'do it' },
    { kind: 'tool', id: 't1', name: 'get_page', input: {}, summary: 'ok', isError: false },
    { kind: 'tool', id: 't2', name: 'find_elements', input: { selector: 'h1' } },
    { kind: 'user', id: 'u2', text: 'and make it blue', queued: true },
  ];
  assert.equal(looksUnfinished(items), true);
  const out = settleInterrupted(items);
  assert.deepEqual(out.dropped.map((d) => d.text), ['and make it blue']);
  assert.deepEqual(out.items, [
    items[0],
    items[1],
    { kind: 'tool', id: 't2', name: 'find_elements', input: { selector: 'h1' }, summary: INTERRUPTED_TOOL_SUMMARY, isError: true },
  ]);
  assert.equal(looksUnfinished(out.items), false);
  // Idempotent, and a finished transcript is handed back untouched (same array: no write).
  assert.equal(settleInterrupted(out.items).items, out.items);
});

// ---------- taking back a failed attempt's text ----------

test('text_discard removes exactly what the failed attempt streamed', () => {
  let items: ChatItem[] = [{ kind: 'user', id: 'u', text: 'hi' }];
  items = reduceItems(items, { type: 'text', delta: 'Let me lo' });
  items = reduceItems(items, { type: 'text_discard', chars: 9 });
  assert.deepEqual(items, [{ kind: 'user', id: 'u', text: 'hi' }], 'a row that held nothing else is removed');

  // A bubble queued after the partial text does not shield it.
  items = reduceItems(items, { type: 'text', delta: 'partial' });
  items = [...items, { kind: 'user', id: 'q', text: 'queued', queued: true }];
  items = reduceItems(items, { type: 'text_discard', chars: 7 });
  assert.deepEqual(items.map((i) => i.kind), ['user', 'user']);
});

test('text_discard never reaches back into a reply that completed', () => {
  const done: ChatItem[] = [
    { kind: 'assistant', text: 'A finished thought.' },
    { kind: 'tool', id: 't', name: 'get_page', input: {}, summary: 'ok' },
  ];
  assert.equal(reduceItems(done, { type: 'text_discard', chars: 5 }), done);
  assert.equal(reduceItems(done, { type: 'text_discard', chars: 0 }), done);
  // A panel that reconnected mid-stream saw less than was streamed: it removes what it has.
  const partial: ChatItem[] = [{ kind: 'assistant', text: 'abc' }];
  assert.deepEqual(reduceItems(partial, { type: 'text_discard', chars: 50 }), []);
});

// ---------- the activity line during a retry ----------

test('the line says what went wrong, when the next attempt is, and which one it is', () => {
  const base = { phase: 'model' as const, elapsed: 12_000, sinceLastEvent: 0 };
  const line = (retry: NonNullable<Parameters<typeof activityFor>[0]['retry']>) => activityText(activityFor({ ...base, retry })!);
  assert.equal(line({ reason: 'network', attempt: 2, max: 5, remainingMs: 3400 }), 'connection lost · retrying in 4s · attempt 2 of 5');
  assert.equal(line({ reason: 'stream', attempt: 1, max: 5, remainingMs: 900 }), 'connection lost · retrying in 1s · attempt 1 of 5');
  assert.equal(line({ reason: 'rate_limit', attempt: 1, max: 5, remainingMs: 12_000 }), 'rate limited by the provider · retrying in 12s · attempt 1 of 5');
  assert.equal(line({ reason: 'overloaded', attempt: 3, max: 5, remainingMs: 4000 }), 'the provider is overloaded · retrying in 4s · attempt 3 of 5');
  assert.equal(line({ reason: 'server', status: 503, attempt: 5, max: 5, remainingMs: -20 }), 'the provider returned 503 · retrying now · attempt 5 of 5');
  assert.equal(line({ reason: 'offline', attempt: 0, max: 0, remainingMs: 60_000 }), 'you are offline · waiting for the connection to come back');
});

test('a retry wait is a warning with Stop, and is never mistaken for a stall', () => {
  const a = activityFor({ phase: 'model', elapsed: 200_000, sinceLastEvent: STALL_MS + 5000, retry: { reason: 'rate_limit', attempt: 1, max: 5, remainingMs: 30_000 } })!;
  assert.equal(a.tone, 'warn');
  assert.equal(a.action, 'stop');
  assert.match(activityText(a), /^rate limited/);
});

test('the retry notice arrives on a status event and the next ordinary status clears it', () => {
  const retry = { reason: 'network' as const, attempt: 1, max: 5, until: 5000 };
  let a = activityFromEvent({ ...IDLE_ACTIVITY, phase: 'model', startedAt: 0, lastEventAt: 0 }, { type: 'status', phase: 'model', detail: 'retrying', retry }, 1000);
  assert.deepEqual(a.retry, retry);
  a = activityFromEvent(a, { type: 'text_discard' }, 1100);
  assert.deepEqual(a.retry, retry, 'taking the partial text back does not end the wait');
  assert.equal(a.writing, false);
  a = activityFromEvent(a, { type: 'status', phase: 'model', detail: 'continuing' }, 5000);
  assert.equal(a.retry, undefined);
  assert.equal(activityText(activityFor({ phase: a.phase, detail: a.detail, elapsed: 5000, sinceLastEvent: 0 })!), 'continuing · 5s');
});
