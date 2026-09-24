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

// ---------- a wait in progress ----------
//
// wait_for is the one tool whose silence is its normal behaviour, so the line has to treat it
// differently in two ways: it names the thing being waited for, and it is not accused of stalling
// while it does exactly what it was asked to do.

test('a wait names its condition, with the condition in the identifier font', () => {
  // The prose leads and the selector follows, which is the opposite of every other tool line.
  const a = activityFor(state({ phase: 'tool', tool: 'wait_for', detail: 'waiting for .result', elapsed: 3_000 }));
  assert.ok(a);
  assert.equal(a.label, 'waiting for');
  assert.equal(a.mono, '.result', 'the selector belongs in the mono slot, not buried in the prose');
  assert.equal(a.labelFirst, true);
  assert.equal(activityText(a), 'waiting for .result · 3s');
});

test('a wait on text or a URL reads the same way', () => {
  assert.equal(line({ phase: 'tool', tool: 'wait_for', detail: 'waiting for "Loaded"', elapsed: 1_000 }), 'waiting for "Loaded" · 1s');
  assert.equal(line({ phase: 'tool', tool: 'wait_for', detail: 'waiting for /checkout', elapsed: 2_000 }), 'waiting for /checkout · 2s');
});

test('a 15s wait is not a stall: silence is what a wait DOES', () => {
  // The ordinary threshold would put "the provider may be stuck" on screen for a tool behaving
  // exactly as designed, which teaches the user to distrust the one line meant to be trustworthy.
  const waiting = state({ phase: 'tool', tool: 'wait_for', detail: 'waiting for .result', elapsed: 15_000, sinceLastEvent: 15_000 });
  const a = activityFor(waiting);
  assert.ok(a);
  assert.equal(a.tone, 'live');
  assert.equal(a.pulse, true);
  assert.equal(a.action, undefined, 'a legitimate wait must not be offering Stop as if something were wrong');
  assert.doesNotMatch(activityText(a), /stuck/);

  // Even at the longest timeout the tool permits, plus a round trip.
  const longest = activityFor(state({ phase: 'tool', tool: 'wait_for', detail: 'waiting for .x', elapsed: 21_000, sinceLastEvent: 21_000 }));
  assert.equal(longest?.tone, 'live');
});

test('a wait that outruns every legitimate timeout is still called out', () => {
  // Not infinite: past WAIT_STALL_MS something really has hung, and the line says so.
  const a = activityFor(state({ phase: 'tool', tool: 'wait_for', detail: 'waiting for .x', elapsed: 50_000, sinceLastEvent: 50_000 }));
  assert.equal(a?.tone, 'warn');
  assert.equal(a?.action, 'stop');
});

test('the wait exemption is scoped to wait_for, so a real stall is still caught', () => {
  // A run_script silent for 30s is not waiting by design; it has hung, and the old threshold holds.
  const a = activityFor(state({ phase: 'tool', tool: 'run_script', detail: 'hide the modal', elapsed: 95_000, sinceLastEvent: 95_000 }));
  assert.equal(a?.tone, 'warn');
  assert.match(activityText(a!), /may be stuck/);
});

// ---------- per chat, not per panel ----------
//
// Runs are keyed by chat and several can be in flight at once, so the indicator is a property of a
// conversation. These are the cases that would have leaked one chat's run into another's line.

import { IDLE_ACTIVITY, activityFromEvent, allDisconnected, withActivity, withoutActivity, type ChatActivity } from '../lib/activity.ts';

/** Fold a sequence of events into a map the way the panel's port listener does. */
function fold(events: Array<{ chatId: string; e: Parameters<typeof activityFromEvent>[1]; at?: number }>) {
  let map: ReadonlyMap<string, ChatActivity> = new Map();
  for (const { chatId, e, at } of events) {
    map = withActivity(map, chatId, (a) => activityFromEvent(a, e, at ?? 1000));
  }
  return map;
}

test('two chats running at once keep separate lines', () => {
  const map = fold([
    { chatId: 'a', e: { type: 'status', phase: 'model', detail: 'waiting for model', iteration: 1 } },
    { chatId: 'b', e: { type: 'status', phase: 'tool', tool: 'run_script', detail: 'hide the sidebar', iteration: 2 } },
  ]);
  assert.equal(map.get('a')?.phase, 'model');
  assert.equal(map.get('a')?.detail, 'waiting for model');
  assert.equal(map.get('b')?.phase, 'tool');
  assert.equal(map.get('b')?.tool, 'run_script');
});

test('one chat finishing does not silence another that is still running', () => {
  const map = fold([
    { chatId: 'a', e: { type: 'status', phase: 'model' } },
    { chatId: 'b', e: { type: 'status', phase: 'tool', tool: 'get_page' } },
    { chatId: 'a', e: { type: 'done' } },
  ]);
  assert.equal(map.has('a'), false, "the finished chat's line is gone");
  assert.equal(map.get('b')?.tool, 'get_page', "the other chat's line is untouched");
});

test('a finished chat leaves no entry for the next run to inherit', () => {
  const map = fold([
    { chatId: 'a', e: { type: 'status', phase: 'tool', tool: 'get_page', iteration: 3 } },
    { chatId: 'a', e: { type: 'status', phase: 'idle' } },
  ]);
  assert.equal(map.size, 0);
});

test("a chat's elapsed clock starts at its own first event, not another chat's", () => {
  const map = fold([
    { chatId: 'a', e: { type: 'status', phase: 'model' }, at: 1_000 },
    { chatId: 'b', e: { type: 'status', phase: 'model' }, at: 5_000 },
    { chatId: 'a', e: { type: 'text' }, at: 6_000 },
  ]);
  assert.equal(map.get('a')?.startedAt, 1_000);
  assert.equal(map.get('b')?.startedAt, 5_000);
  assert.equal(map.get('a')?.lastEventAt, 6_000, 'and its own last event drives its stall detection');
  assert.equal(map.get('b')?.lastEventAt, 5_000);
});

test('an error ends only the chat it happened in', () => {
  const map = fold([
    { chatId: 'a', e: { type: 'status', phase: 'model' } },
    { chatId: 'b', e: { type: 'status', phase: 'model' } },
    { chatId: 'a', e: { type: 'error' } },
  ]);
  assert.equal(map.has('a'), false);
  assert.equal(map.get('b')?.phase, 'model');
});

test('a dead port marks every mid-run chat disconnected, and leaves idle ones alone', () => {
  const before = fold([
    { chatId: 'a', e: { type: 'status', phase: 'model' } },
    { chatId: 'b', e: { type: 'status', phase: 'tool', tool: 'get_page' } },
  ]);
  const after = allDisconnected(before);
  assert.equal(after.get('a')?.disconnected, true);
  assert.equal(after.get('b')?.disconnected, true);
  // A map with nothing running is returned unchanged (identity), so React can skip the render.
  const nothingRunning: ReadonlyMap<string, ChatActivity> = new Map();
  assert.equal(allDisconnected(nothingRunning), nothingRunning);
  // …and a second disconnect changes nothing either.
  assert.equal(allDisconnected(after), after);
});

test('a disconnected line survives even though its phase reads idle, because it still says something', () => {
  const map = withActivity(new Map(), 'a', () => ({ ...IDLE_ACTIVITY, disconnected: true }));
  assert.equal(map.get('a')?.disconnected, true);
  assert.equal(activityFor({ phase: 'idle', elapsed: 0, sinceLastEvent: 0, disconnected: true })?.action, 'retry');
});

test('stopping one chat clears its line and only its line', () => {
  const before = fold([
    { chatId: 'a', e: { type: 'status', phase: 'model' } },
    { chatId: 'b', e: { type: 'status', phase: 'model' } },
  ]);
  const after = withoutActivity(before, 'a');
  assert.equal(after.has('a'), false);
  assert.equal(after.has('b'), true);
  // Removing a chat that has no line is a no-op, identity included.
  assert.equal(withoutActivity(after, 'a'), after);
});

test('a chat_title event neither revives a finished line nor counts as proof of life', () => {
  const running = fold([{ chatId: 'a', e: { type: 'status', phase: 'model' }, at: 1_000 }]);
  const after = withActivity(running, 'a', (a) => activityFromEvent(a, { type: 'chat_title' }, 9_000));
  assert.equal(after.get('a')?.lastEventAt, 1_000, 'the stall clock is not reset by a rename');
  // And on a chat that already finished it creates nothing.
  const finished = withActivity(new Map(), 'a', (a) => activityFromEvent(a, { type: 'chat_title' }, 9_000));
  assert.equal(finished.size, 0);
});

test("queued counts are each chat's own", () => {
  let map: ReadonlyMap<string, ChatActivity> = new Map();
  map = withActivity(map, 'a', () => ({ ...IDLE_ACTIVITY, phase: 'model', startedAt: 0, lastEventAt: 0, queued: 2 }));
  map = withActivity(map, 'b', () => ({ ...IDLE_ACTIVITY, phase: 'model', startedAt: 0, lastEventAt: 0, queued: 0 }));
  map = withActivity(map, 'a', (a) => activityFromEvent(a, { type: 'accepted' }, 1_000));
  assert.equal(map.get('a')?.queued, 1);
  assert.equal(map.get('b')?.queued, 0);
});
