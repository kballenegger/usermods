// The Safari keepalive and the automatic resume that backs it up (lib/keepalive.ts,
// lib/keepalive-holder.ts).
//
// Two halves, and both are rules rather than effects, which is why they are testable here at all:
//
//   - which tabs should be holding a port, how long to wait before reconnecting one that dropped,
//     and when a hold has outlived its ceiling;
//   - whether a run that stopped short has earned an automatic pickup — once, never after Stop,
//     never over a live session, and never on Chrome.
//
// The holder itself (the content script's port, its ping and its backoff) is driven here through
// injected fakes, so the state machine is exercised without a browser. What NO test here can prove
// is whether iOS actually honours an open port; see docs/safari.md and docs/qa-checklist.md.
//
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_RESUMED_TEXT,
  autoResumable,
  countAutoResume,
  holdExpired,
  holdPlan,
  KEEPALIVE_MAX_HOLD_MS,
  KEEPALIVE_PING_MS,
  KEEPALIVE_PORT,
  MAX_AUTO_RESUMES,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectDelay,
  shouldAutoResume,
  TAB_CLOSED_TEXT,
  tabsNeedingHold,
} from '../lib/keepalive.ts';
import { createHolder } from '../lib/keepalive-holder.ts';
import type { RunMap, RunRecord } from '../lib/runstate.ts';
import { parseRuns, resumableRuns } from '../lib/runstate.ts';

// ---------- which tabs need a port ----------

test('a run needs a port on the tab it is driving, and two runs on one tab share it', () => {
  assert.deepEqual(tabsNeedingHold([{ chatId: 'a', tabId: 7 }]), [7]);
  // One port, not two: asking the same content script twice buys no extra life and pings twice.
  assert.deepEqual(
    tabsNeedingHold([
      { chatId: 'a', tabId: 7 },
      { chatId: 'b', tabId: 7 },
    ]),
    [7],
  );
  assert.deepEqual(
    tabsNeedingHold([
      { chatId: 'a', tabId: 9 },
      { chatId: 'b', tabId: 2 },
    ]),
    [2, 9],
    'sorted, so the caller’s diff is stable',
  );
});

test('a run with no real tab asks nothing to hold a port', () => {
  // -1 is what a run records when the tab could not be resolved. Nothing can host a content script
  // there, so asking would be a message into the void on every single wake.
  assert.deepEqual(tabsNeedingHold([{ chatId: 'a', tabId: -1 }]), []);
  assert.deepEqual(tabsNeedingHold([{ chatId: 'a', tabId: 1.5 }]), []);
  assert.deepEqual(tabsNeedingHold([]), []);
});

test('no run in flight means no port anywhere — the battery promise', () => {
  // The one claim worth pinning: with nothing running, everything held is released and nothing is
  // acquired. An extension sitting idle on a phone pings nobody.
  assert.deepEqual(holdPlan([3, 4, 5], []), { acquire: [], release: [3, 4, 5] });
  assert.deepEqual(holdPlan([], []), { acquire: [], release: [] });
});

test('the plan is the diff between what is held and what the runs need', () => {
  assert.deepEqual(holdPlan([], [{ chatId: 'a', tabId: 7 }]), { acquire: [7], release: [] });
  // Already held: nothing to do. This is what stops a second run on the same tab re-asking.
  assert.deepEqual(holdPlan([7], [{ chatId: 'a', tabId: 7 }]), { acquire: [], release: [] });
  assert.deepEqual(
    holdPlan(
      [1, 2],
      [
        { chatId: 'a', tabId: 2 },
        { chatId: 'b', tabId: 3 },
      ],
    ),
    { acquire: [3], release: [1] },
  );
});

// ---------- reconnect backoff ----------

test('a dropped port is retried quickly first, then backs off to a ceiling', () => {
  // A drop is the NORMAL case during a navigation, so the first retry is fast: the new document's
  // content script is milliseconds away.
  assert.equal(reconnectDelay(1), RECONNECT_BASE_MS);
  assert.equal(reconnectDelay(2), 1000);
  assert.equal(reconnectDelay(3), 2000);
  assert.equal(reconnectDelay(4), 4000);
  assert.equal(reconnectDelay(5), RECONNECT_MAX_MS);
  // It never gives up: a suspended Safari background is only woken by something reaching for it.
  assert.equal(reconnectDelay(50), RECONNECT_MAX_MS);
  assert.equal(reconnectDelay(0), RECONNECT_BASE_MS, 'a nonsense attempt number still yields a real delay');
});

test('the ping interval is under every suspension window anybody has reported', () => {
  // 9s is the interval from the forum report that measured an effect (thread 764594). The assertion
  // is on the ORDER of magnitude, so a well-meant "round it to a minute" is caught here.
  assert.ok(KEEPALIVE_PING_MS <= 10_000, 'a ping slower than 10s is not a keepalive on iOS');
  assert.ok(KEEPALIVE_PING_MS >= 1_000, 'and a ping faster than a second is just traffic');
});

// ---------- the hold ceiling ----------

test('a hold is dropped once it has outlived the ceiling, so nothing pins the worker forever', () => {
  assert.equal(holdExpired(0, KEEPALIVE_MAX_HOLD_MS - 1), false);
  assert.equal(holdExpired(0, KEEPALIVE_MAX_HOLD_MS), true);
  assert.equal(holdExpired(1000, 1000 + KEEPALIVE_MAX_HOLD_MS + 5), true);
  // Comfortably past the agent loop's own limits, so a healthy run is never cut off by this.
  assert.ok(KEEPALIVE_MAX_HOLD_MS >= 10 * 60 * 1000, 'the ceiling must not be reachable by an ordinary long run');
});

// ---------- the holder's state machine ----------

/** A fake port plus a fake clock, so the holder's lifecycle is driven without a browser. */
function harness({ failConnects = 0 }: { failConnects?: number } = {}) {
  const timers: Array<{ id: number; fn: () => void; ms: number; kind: 'timeout' | 'interval' }> = [];
  let nextId = 1;
  const ports: Array<{ name: string; messages: unknown[]; disconnected: boolean; onMessage: Array<(m: unknown) => void>; onDisconnect: Array<() => void> }> = [];
  let connects = 0;
  const connect = (name: string) => {
    connects += 1;
    if (connects <= failConnects) throw new Error('extension context invalidated');
    const p = { name, messages: [] as unknown[], disconnected: false, onMessage: [] as Array<(m: unknown) => void>, onDisconnect: [] as Array<() => void> };
    ports.push(p);
    return {
      name,
      postMessage: (m: unknown) => {
        if (p.disconnected) throw new Error('port closed');
        p.messages.push(m);
      },
      disconnect: () => {
        p.disconnected = true;
      },
      onMessage: { addListener: (fn: (m: unknown) => void) => p.onMessage.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => p.onDisconnect.push(fn) },
    } as unknown as chrome.runtime.Port;
  };
  const holder = createHolder({
    connect,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, ms, kind: 'timeout' });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, ms, kind: 'interval' });
      return id;
    },
    clearInterval: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    holder,
    ports,
    timers,
    get connects() {
      return connects;
    },
    /** Run every pending timeout once (intervals stay registered, as real ones do). */
    fireTimeouts() {
      for (const t of timers.filter((x) => x.kind === 'timeout')) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    fireIntervals() {
      for (const t of [...timers.filter((x) => x.kind === 'interval')]) t.fn();
    },
    /** The engine tearing a port down: a navigation, or the background being suspended. */
    dropLast() {
      const p = ports[ports.length - 1]!;
      p.disconnected = true;
      for (const fn of p.onDisconnect) fn();
    },
  };
}

test('nothing is opened and nothing is pinged until the background asks', () => {
  // The battery claim, at the other end of the wire: a content script on an ordinary page that is
  // not hosting a run does nothing at all.
  const h = harness();
  assert.equal(h.connects, 0);
  assert.equal(h.timers.length, 0);
  assert.equal(h.holder.connected, false);
});

test('start opens one named port and pings it on the interval', () => {
  const h = harness();
  h.holder.start();
  assert.equal(h.connects, 1);
  assert.equal(h.ports[0]!.name, KEEPALIVE_PORT, 'named, so the background can tell it from the panel and exec ports');
  assert.equal(h.holder.connected, true);
  h.fireIntervals();
  h.fireIntervals();
  assert.equal(h.ports[0]!.messages.length, 2, 'the traffic is the mechanism');
  // Idempotent: the background may ask twice (a reconnect crossing a fresh run).
  h.holder.start();
  assert.equal(h.connects, 1, 'a second start does not open a second port');
});

test('a dropped port is reconnected, with the backoff', () => {
  const h = harness();
  h.holder.start();
  h.dropLast();
  assert.equal(h.holder.connected, false);
  const retry = h.timers.find((t) => t.kind === 'timeout');
  assert.equal(retry?.ms, RECONNECT_BASE_MS, 'the first retry is the quick one');
  h.fireTimeouts();
  assert.equal(h.connects, 2);
  assert.equal(h.holder.connected, true);
});

test('repeated drops back off, and a successful connect resets the backoff', () => {
  const h = harness();
  h.holder.start();
  h.dropLast();
  h.fireTimeouts(); // attempt 1 -> connects, which resets
  h.dropLast();
  assert.equal(h.timers.find((t) => t.kind === 'timeout')?.ms, RECONNECT_BASE_MS, 'a connect that succeeded resets the delay');
  // A connect that keeps failing outright does climb.
  const f = harness({ failConnects: 3 });
  f.holder.start();
  assert.equal(f.holder.connected, false, 'a throwing connect is a drop, not a crash');
  assert.equal(f.timers.find((t) => t.kind === 'timeout')?.ms, RECONNECT_BASE_MS);
  f.fireTimeouts();
  assert.equal(f.timers.find((t) => t.kind === 'timeout')?.ms, 1000);
  f.fireTimeouts();
  assert.equal(f.timers.find((t) => t.kind === 'timeout')?.ms, 2000);
  f.fireTimeouts();
  assert.equal(f.holder.connected, true, 'and it gets there once the context is back');
});

test('release from the background stops the holder dead — no port, no ping, no reconnect', () => {
  // The run ended. A holder that kept pinging past it is exactly the battery drain the ceiling and
  // the plan diff exist to prevent, so this is the assertion that matters most on a phone.
  const h = harness();
  h.holder.start();
  const p = h.ports[0]!;
  for (const fn of p.onMessage) fn({ type: 'release' });
  assert.equal(h.holder.connected, false);
  assert.equal(p.disconnected, true);
  assert.equal(h.timers.length, 0, 'the ping interval and any pending retry are both cancelled');
  h.fireTimeouts();
  assert.equal(h.connects, 1, 'and it does not come back by itself');
});

test('stop() is final too, and a drop after it reconnects nothing', () => {
  const h = harness();
  h.holder.start();
  h.holder.stop();
  assert.equal(h.timers.length, 0);
  assert.equal(h.connects, 1);
  h.fireTimeouts();
  assert.equal(h.connects, 1);
});

test('a message that is not a release is ignored', () => {
  const h = harness();
  h.holder.start();
  for (const fn of h.ports[0]!.onMessage) fn({ type: 'something-else' });
  for (const fn of h.ports[0]!.onMessage) fn(null);
  assert.equal(h.holder.connected, true);
});

// ---------- the automatic resume ----------

const rec = (over: Partial<RunRecord> = {}): RunRecord => ({ state: 'interrupted', tabId: 4, startedAt: 100, updatedAt: 200, ...over });

test('a run Safari took away is picked up automatically', () => {
  // The case the owner described: a run that was going, that nobody stopped, whose worker is gone.
  assert.equal(shouldAutoResume({ record: rec(), live: false, safari: true }), true);
});

test('Chrome keeps the manual button', () => {
  // Chrome's worker eviction is rare and its keepalive is documented and works. Silently
  // re-sending a model request there is a behaviour change nobody asked for.
  assert.equal(shouldAutoResume({ record: rec(), live: false, safari: false }), false);
});

test('a chat that is running right now is never resumed — the double-run guard', () => {
  // The one thing this must never do: run the same conversation twice against the same chat.
  assert.equal(shouldAutoResume({ record: rec(), live: true, safari: true }), false);
  assert.equal(shouldAutoResume({ record: rec({ state: 'running' }), live: true, safari: true }), false);
});

test('Stop means stop: a run the user ended is never resumed', () => {
  assert.equal(shouldAutoResume({ record: rec({ stoppedByUser: true }), live: false, safari: true }), false);
  // Even with attempts left and everything else in order.
  assert.equal(shouldAutoResume({ record: rec({ stoppedByUser: true, autoResumes: 0 }), live: false, safari: true }), false);
});

test('a failure the provider actually answered is not resumed automatically', () => {
  // 'failed' means the provider gave an answer and it was a bad one (no key, a 400, out of
  // retries). Sending the same thing again fails the same way; that is what the button is for.
  assert.equal(shouldAutoResume({ record: rec({ state: 'failed', error: 'Invalid API key' }), live: false, safari: true }), false);
  // 'running' has not been through markInterrupted yet: nothing has established that it is dead.
  assert.equal(shouldAutoResume({ record: rec({ state: 'running' }), live: false, safari: true }), false);
});

test('it cannot loop: one automatic pickup, then the button comes back', () => {
  assert.equal(MAX_AUTO_RESUMES, 1);
  assert.equal(shouldAutoResume({ record: rec({ autoResumes: 0 }), live: false, safari: true }), true);
  assert.equal(shouldAutoResume({ record: rec({ autoResumes: 1 }), live: false, safari: true }), false);
  assert.equal(shouldAutoResume({ record: rec({ autoResumes: 9 }), live: false, safari: true }), false);
});

test('the attempt is counted on the record, so a worker that dies mid-resume still knows', () => {
  const runs: RunMap = { a: rec(), b: rec() };
  const once = countAutoResume(runs, 'a');
  assert.equal(once.a!.autoResumes, 1);
  assert.equal(once.b!.autoResumes, undefined, 'only the chat being resumed');
  assert.equal(runs.a!.autoResumes, undefined, 'the input is not mutated');
  assert.equal(countAutoResume(once, 'a').a!.autoResumes, 2);
  assert.equal(countAutoResume(runs, 'missing'), runs, 'a chat with no record is left alone');
});

test('the whole map at once: which chats resume themselves, oldest first', () => {
  const runs: RunMap = {
    stopped: rec({ stoppedByUser: true, startedAt: 1 }),
    newer: rec({ startedAt: 30 }),
    failed: rec({ state: 'failed', error: 'nope', startedAt: 2 }),
    older: rec({ startedAt: 10 }),
    spent: rec({ autoResumes: 1, startedAt: 3 }),
    live: rec({ startedAt: 4 }),
  };
  assert.deepEqual(autoResumable(runs, (id) => id === 'live', true), ['older', 'newer']);
  assert.deepEqual(autoResumable(runs, () => false, false), [], 'nothing at all on Chrome');
});

// ---------- the record survives storage ----------

test('the two new fields survive a round trip through storage, defensively', () => {
  const parsed = parseRuns({
    a: { state: 'interrupted', tabId: 3, startedAt: 1, updatedAt: 2, stoppedByUser: true, autoResumes: 1 },
    b: { state: 'interrupted', tabId: 3, startedAt: 1, updatedAt: 2, stoppedByUser: 'yes', autoResumes: 'two' },
    c: { state: 'interrupted', tabId: 3, startedAt: 1, updatedAt: 2, autoResumes: Number.NaN },
  });
  assert.equal(parsed.a!.stoppedByUser, true);
  assert.equal(parsed.a!.autoResumes, 1);
  // Junk reads as absent rather than as truthy: a bogus `stoppedByUser` must not be able to block a
  // legitimate resume, and a bogus count must not defeat the bound by making every comparison false.
  assert.equal(parsed.b!.stoppedByUser, undefined);
  assert.equal(parsed.b!.autoResumes, undefined);
  assert.equal(parsed.c!.autoResumes, undefined);
  assert.equal(shouldAutoResume({ record: parsed.c!, live: false, safari: true }), true);
});

test('a run that already picked itself up says so to the panel', () => {
  // The panel needs to tell "this came back by itself" from "this needs a button", because the
  // second automatic attempt does not exist.
  const out = resumableRuns({ auto: rec({ autoResumes: 1 }), plain: rec() });
  assert.equal(out.auto!.autoResumed, true);
  assert.equal(out.plain!.autoResumed, undefined);
});

// ---------- the strings the user reads ----------

test('the notes say what happened, in one sentence each', () => {
  assert.match(AUTO_RESUMED_TEXT, /Safari/, 'it names what paused it, so the user is not left guessing');
  assert.ok(!/error|fail/i.test(AUTO_RESUMED_TEXT), 'this is not a failure and must not read like one');
  assert.match(TAB_CLOSED_TEXT, /tab/i);
  for (const s of [AUTO_RESUMED_TEXT, TAB_CLOSED_TEXT]) {
    assert.ok(s.length > 20 && s.length < 140, `${JSON.stringify(s)} is a sentence, not a code or a paragraph`);
  }
});
