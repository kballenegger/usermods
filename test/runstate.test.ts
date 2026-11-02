// Run records: how a worker that has just started finds the runs that died with the last one, and
// what the panel is told it can resume. Plus the two transcript reductions that go with it.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFor, activityFromEvent, activityText, IDLE_ACTIVITY, STALL_MS } from '../lib/activity.ts';
import { markInterrupted, nextRunRecord, parseRuns, pendingResumeText, pruneRuns, resumableRuns, withRunSkill, withSkillStep, withoutPending, withPending, type RunMap, type RunRecord } from '../lib/runstate.ts';
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

// ---------- the pending step ----------

test('a pending step is written before the step and cleared with its result', () => {
  const runs: RunMap = { c: { state: 'running', tabId: 1, startedAt: 1, updatedAt: 1 } };
  const during = withPending(runs, 'c', { kind: 'act', label: 'click button "Place order"' }, 50);
  assert.deepEqual(during.c!.pending, { kind: 'act', label: 'click button "Place order"', at: 50 });
  assert.equal(runs.c!.pending, undefined, 'the map handed in is untouched');
  const after = withoutPending(during, 'c', 60);
  assert.equal(after.c!.pending, undefined);
  assert.equal(after.c!.updatedAt, 60);
  assert.equal(withoutPending(after, 'c'), after, 'nothing to clear, nothing to write');
  const none: RunMap = {};
  assert.equal(withPending(none, 'gone', { kind: 'act', label: 'x' }), none, 'a chat with no record has nothing to write on');
});

test('a pending step survives everything that can happen to the record before someone answers it', () => {
  const pending = { kind: 'act' as const, label: 'click button "Place order"', at: 5 };
  const rec: RunRecord = { state: 'running', tabId: 1, startedAt: 1, updatedAt: 1, pending };
  // The worker died over it.
  const { runs } = markInterrupted({ c: rec }, () => false, 9);
  assert.deepEqual(runs.c!.pending, pending);
  // Stored and read back.
  assert.deepEqual(parseRuns(JSON.parse(JSON.stringify(runs))).c!.pending, pending);
  // The panel is told what may have happened.
  assert.deepEqual(resumableRuns(runs).c!.pending, pending);
  // A state change on top of it: Resume writes 'running', and a provider failure writes 'failed'.
  assert.deepEqual(nextRunRecord(runs.c, { state: 'running', tabId: 1 }, 10).pending, pending);
  assert.deepEqual(nextRunRecord(runs.c, { state: 'failed', tabId: 1, error: 'no' }, 10).pending, pending);
});

test('the Resume block names the step and promises to look first', () => {
  assert.equal(pendingResumeText({ label: 'click button "Place order"' }), 'The last action may or may not have happened: click button "Place order". usermods will look at the page before doing anything else.');
});

test('a stored pending step that cannot be read still counts as one', () => {
  const runs = parseRuns({ a: { state: 'interrupted', pending: 'junk' }, b: { state: 'interrupted', pending: { kind: 'nope' } }, c: { state: 'interrupted', pending: null }, d: { state: 'interrupted' } });
  assert.deepEqual(runs.a!.pending, { kind: 'act', label: 'an action', at: 0 });
  assert.deepEqual(runs.b!.pending, { kind: 'act', label: 'an action', at: 0 });
  assert.equal(runs.c!.pending, undefined);
  assert.equal(runs.d!.pending, undefined);
});

test('a state change keeps the count of automatic resumes, so the bound holds across a restart', () => {
  // Resuming writes 'running' over the record, and a count lost there would let the same run pick
  // itself up again every time it died.
  const prev: RunRecord = { state: 'interrupted', tabId: 1, startedAt: 1, updatedAt: 1, autoResumes: 1 };
  assert.equal(nextRunRecord(prev, { state: 'running', tabId: 1 }, 10).autoResumes, 1);
  const fresh = nextRunRecord(undefined, { state: 'running', tabId: 7 }, 10);
  assert.deepEqual(fresh, { state: 'running', tabId: 7, startedAt: 10, updatedAt: 10 });
});

test('a skill’s record: its step moves, survives a stored round trip, and reaches the panel', () => {
  const base: RunMap = { a: { state: 'running', tabId: 1, startedAt: 1, updatedAt: 1 } };
  const withSkill = withRunSkill(base, 'a', { id: 's', name: 'File', step: 0, total: 9, key: 'k' }, 2);
  assert.equal(withSkillStep(withSkill, 'a', 4, 3).a!.skill!.step, 4);
  assert.equal(withSkillStep(base, 'a', 4), base, 'a record that is not a skill’s is left alone');
  const stored = parseRuns(JSON.parse(JSON.stringify(withSkillStep(withSkill, 'a', 4, 3))));
  assert.deepEqual(stored.a!.skill, { id: 's', name: 'File', step: 4, total: 9, key: 'k' });
  const { runs } = markInterrupted(stored, () => false, 5);
  assert.deepEqual(resumableRuns(runs).a!.skill, stored.a!.skill);
});

test('a malformed skill on a record reads as none, and the pending step on it still counts', () => {
  const stored = parseRuns({ a: { state: 'interrupted', tabId: 1, startedAt: 1, updatedAt: 1, skill: { id: 's' }, pending: { kind: 'skill', label: 'x', at: 1 } } });
  assert.equal(stored.a!.skill, undefined);
  assert.equal(stored.a!.pending!.kind, 'skill');
});

test('a chat’s next message writes the record without the skill, and keeps what may have happened', () => {
  const prev: RunRecord = { state: 'interrupted', tabId: 1, startedAt: 1, updatedAt: 1, pending: { kind: 'skill', label: 'x', at: 1 }, skill: { id: 's', name: 'S', step: 1, total: 2, key: 'k' } };
  const next = nextRunRecord(prev, { state: 'running', tabId: 1 }, 9);
  assert.equal(next.skill, undefined);
  assert.equal(next.pending!.label, 'x');
});

test('the Resume block promises a question for a skill, and a look for a model', () => {
  assert.match(pendingResumeText({ label: 'x' }, true), /ask you/);
  assert.match(pendingResumeText({ label: 'x' }), /look at the page/);
});
