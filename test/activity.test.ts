// The activity line's wording and its thresholds: what the panel says while a run is in flight,
// and exactly when "waiting" becomes "still waiting" and then "the provider may be stuck".
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityFor,
  activityText,
  formatElapsed,
  STALL_MS,
  STILL_WAITING_MS,
  type ActivityState,
} from '../lib/activity.ts';

/** A run that has just produced an event, so nothing is stalled unless a test says so. */
function state(over: Partial<ActivityState> = {}): ActivityState {
  return { phase: 'model', elapsed: 0, sinceLastEvent: 0, ...over };
}

/** The whole line as the user reads it. */
function line(over: Partial<ActivityState> = {}): string | null {
  const a = activityFor(state(over));
  return a ? activityText(a) : null;
}

// ---------- the ordinary phases ----------

test('a fresh model call says it is waiting, with the elapsed timer', () => {
  assert.equal(line({ detail: 'waiting for model', elapsed: 12_000 }), 'waiting for model · 12s');
});

test('a later model call in the same turn says it is continuing', () => {
  assert.equal(line({ detail: 'continuing', elapsed: 2_000, iteration: 3 }), 'continuing · 2s · step 3');
});

test('the first text delta turns waiting into writing', () => {
  assert.equal(line({ detail: 'waiting for model', writing: true, elapsed: 3_000 }), 'writing · 3s');
});

test('a tool shows its name and the human description it carries', () => {
  assert.equal(
    line({ phase: 'tool', tool: 'run_script', detail: 'hide the login modal', elapsed: 4_000 }),
    'run_script · hide the login modal · 4s',
  );
});

test('a selector-based tool shows the selector, joined to the name as one identifier', () => {
  assert.equal(line({ phase: 'tool', tool: 'find_elements', detail: '#loginContainer', elapsed: 1_000 }), 'find_elements #loginContainer · 1s');
});

test('a selector goes in the mono run with the tool name; a description does not', () => {
  const sel = activityFor(state({ phase: 'tool', tool: 'find_elements', detail: '#loginContainer' }))!;
  assert.equal(sel.mono, 'find_elements #loginContainer');
  assert.equal(sel.label, '', 'nothing is left over to set in the body font');

  const desc = activityFor(state({ phase: 'tool', tool: 'run_script', detail: 'hide the login modal' }))!;
  assert.equal(desc.mono, 'run_script');
  assert.equal(desc.monoJoin, ' · ');
});

test('a compound selector containing a space reads as prose rather than one identifier', () => {
  // Not a judgement about CSS: a detail with whitespace is too long to sit inside the identifier.
  const a = activityFor(state({ phase: 'tool', tool: 'get_styles', detail: '#a, .b' }))!;
  assert.equal(a.mono, 'get_styles');
  assert.equal(a.label, '#a, .b');
});

test('a tool with no description at all still names itself', () => {
  assert.equal(line({ phase: 'tool', tool: 'screenshot', elapsed: 1_000 }), 'screenshot · 1s');
});

test('the tool name is always the mono part of the line, and a prose description never is', () => {
  const a = activityFor(state({ phase: 'tool', tool: 'run_script', detail: 'widen the diff view' }))!;
  assert.equal(a.mono, 'run_script');
  assert.equal(a.label, 'widen the diff view');
});

test('a model phase has no mono identifier', () => {
  assert.equal(activityFor(state({ detail: 'waiting for model' }))!.mono, undefined);
});

// ---------- step count and the queue ----------

test('the step count is hidden on the first iteration and shown after it', () => {
  assert.ok(!line({ iteration: 1, detail: 'waiting for model' })!.includes('step'));
  assert.ok(line({ iteration: 2, detail: 'continuing' })!.includes('step 2'));
});

test('queued messages are counted on the line', () => {
  assert.equal(line({ detail: 'waiting for model', elapsed: 5_000, queued: 2 }), 'waiting for model · 5s · 2 queued');
});

test('a queue of zero says nothing', () => {
  assert.ok(!line({ detail: 'waiting for model', queued: 0 })!.includes('queued'));
});

// ---------- idle: the line goes away ----------

test('an idle run shows no line at all, which is how it disappears when the run ends', () => {
  assert.equal(activityFor(state({ phase: 'idle', elapsed: 90_000 })), null);
});

test('idle wins even when the clock says the run has been silent for ages', () => {
  assert.equal(activityFor(state({ phase: 'idle', sinceLastEvent: 10 * STALL_MS })), null);
});

// ---------- the still-waiting threshold ----------

test('one millisecond before the still-waiting threshold the line is unchanged', () => {
  assert.equal(line({ detail: 'waiting for model', sinceLastEvent: STILL_WAITING_MS - 1, elapsed: 19_999 }), 'waiting for model · 19s');
});

test('at the still-waiting threshold the line acknowledges the wait, in the same colour', () => {
  const a = activityFor(state({ detail: 'waiting for model', sinceLastEvent: STILL_WAITING_MS, elapsed: 34_000 }))!;
  assert.equal(activityText(a), 'still waiting for model · 34s');
  assert.equal(a.tone, 'live', 'a thinking model is not an error');
  assert.equal(a.action, undefined);
});

test('a model that is already writing never says "still waiting", however long the gap', () => {
  assert.equal(line({ writing: true, sinceLastEvent: STALL_MS - 1, elapsed: 59_000 }), 'writing · 59s');
});

test('a slow tool does not get the still-waiting wording, which is about the provider', () => {
  assert.equal(
    line({ phase: 'tool', tool: 'get_page', sinceLastEvent: STILL_WAITING_MS + 5_000, elapsed: 25_000 }),
    'get_page · 25s',
  );
});

// ---------- the stall threshold ----------

test('one millisecond before the stall threshold nothing has turned yet', () => {
  const a = activityFor(state({ detail: 'waiting for model', sinceLastEvent: STALL_MS - 1, elapsed: 89_999 }))!;
  assert.equal(a.tone, 'live');
  assert.equal(a.action, undefined);
});

test('at the stall threshold the line warns and offers Stop', () => {
  const a = activityFor(state({ detail: 'waiting for model', sinceLastEvent: STALL_MS, elapsed: 90_000 }))!;
  assert.equal(activityText(a), 'no response for 90s · the provider may be stuck');
  assert.equal(a.tone, 'warn');
  assert.equal(a.action, 'stop');
  assert.equal(a.pulse, false, 'a stalled line should stop pretending to move');
});

test('the stall line names the real silence, not the run length, and grows with it', () => {
  const a = activityFor(state({ sinceLastEvent: 154_000, elapsed: 600_000 }))!;
  assert.ok(activityText(a).startsWith('no response for 154s'));
});

test('a tool can stall too, and says the same thing', () => {
  const a = activityFor(state({ phase: 'tool', tool: 'run_script', detail: 'click every load-more button', sinceLastEvent: STALL_MS + 1_000 }))!;
  assert.equal(a.tone, 'warn');
  assert.equal(a.action, 'stop');
});

test('the stall line still carries the step count and queue, so nothing is lost', () => {
  const a = activityFor(state({ sinceLastEvent: STALL_MS, iteration: 4, queued: 1 }))!;
  assert.deepEqual(a.segments, ['step 4', '1 queued']);
});

// ---------- a dead port ----------

test('a lost port is an error, with Retry, whatever phase it happened in', () => {
  const a = activityFor(state({ phase: 'tool', tool: 'get_page', disconnected: true, elapsed: 4_000 }))!;
  assert.equal(activityText(a), 'connection to the background worker was lost');
  assert.equal(a.tone, 'error');
  assert.equal(a.action, 'retry');
  assert.equal(a.pulse, false);
});

test('a lost port outranks a stall: the port is the more specific fact', () => {
  const a = activityFor(state({ disconnected: true, sinceLastEvent: STALL_MS * 2 }))!;
  assert.equal(a.action, 'retry');
});

test('a lost port still shows a line even once the phase reads idle', () => {
  assert.notEqual(activityFor(state({ phase: 'idle', disconnected: true })), null);
});

// ---------- the timer ----------

test('elapsed reads in whole seconds below a minute', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(1_000), '1s');
  assert.equal(formatElapsed(59_999), '59s');
});

test('elapsed switches to minutes and zero-padded seconds at a minute', () => {
  assert.equal(formatElapsed(60_000), '1m 00s');
  assert.equal(formatElapsed(64_000), '1m 04s');
  assert.equal(formatElapsed(3_601_000), '60m 01s');
});

test('a negative clock (a machine that slept) reads zero rather than a minus sign', () => {
  assert.equal(formatElapsed(-5_000), '0s');
});
