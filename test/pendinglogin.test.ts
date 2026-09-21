// The device-code sign-in as a resumable state machine (lib/pendinglogin.ts).
//
// What these cover is the set of things that were impossible in the previous shape, where the flow
// lived in a closure inside `poll(signal)` and in the popup's useState: resuming after the
// background worker was killed, respecting the vendor's interval across that kill, `slow_down`,
// expiry, cancel, success, and two vendors pending at the same time. Every one of them is a real
// Safari sequence rather than a hypothetical — on iOS the popup is dismissed by the verification
// tab opening, and the event page is suspended shortly after.
//
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_INTERVAL_SEC,
  SLOW_DOWN_STEP_SEC,
  applyOutcome,
  clampInterval,
  expiredMessage,
  isExpired,
  msUntilNextPoll,
  pendingFrom,
  pendingKey,
  restore,
  shouldPoll,
  slowDown,
  vendorName,
  type PendingLogin,
  type PollOutcome,
} from '../lib/pendinglogin.ts';

const T0 = 1_700_000_000_000;

function makePending(over: Partial<PendingLogin> = {}): PendingLogin {
  return {
    kind: 'xai',
    deviceCode: 'dev-code-abc',
    userCode: 'WXYZ-1234',
    verificationUri: 'https://auth.x.ai/device',
    intervalSec: 5,
    expiresAt: T0 + 10 * 60 * 1000,
    lastPolledAt: T0,
    startedAt: T0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

test('a record carries everything a cold resume needs', () => {
  const p = pendingFrom(
    'chatgpt',
    { deviceCode: 'auth-id-9', userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/codex/device', intervalSec: 5, expiresAt: T0 + 9e5 },
    T0,
  );
  // The device code is the one piece that cannot be reconstructed from anything else: without it
  // the flow can only be restarted, which hands the user a code that does not match the page they
  // are already looking at.
  assert.equal(p.deviceCode, 'auth-id-9');
  assert.equal(p.userCode, 'ABCD-EFGH');
  assert.equal(p.verificationUri, 'https://auth.openai.com/codex/device');
  assert.equal(p.kind, 'chatgpt');
  assert.equal(p.intervalSec, 5);
  assert.equal(p.expiresAt, T0 + 9e5);
});

test('a fresh record is due for its first poll immediately', () => {
  // Not `now`: the device-code round trip has already cost a second or two, and making the user
  // wait a further full interval before the first check is latency for nothing.
  const p = pendingFrom('xai', { deviceCode: 'd', userCode: 'u', verificationUri: 'https://x', expiresAt: T0 + 6e5 }, T0);
  assert.equal(p.lastPolledAt, 0);
  assert.ok(shouldPoll(p, T0));
});

test('each vendor has its own storage key, so both can be pending at once', () => {
  assert.notEqual(pendingKey('chatgpt'), pendingKey('xai'));
  assert.match(pendingKey('chatgpt'), /chatgpt/);
  assert.match(pendingKey('xai'), /xai/);
});

// ---------------------------------------------------------------------------
// Interval, and why it lives in the record
// ---------------------------------------------------------------------------

test('the interval is clamped to something sane whatever the vendor says', () => {
  assert.equal(clampInterval(5), 5);
  assert.equal(clampInterval(0), 1, 'zero would be a hot loop against the vendor');
  assert.equal(clampInterval(-3), 1);
  assert.equal(clampInterval(9999), MAX_INTERVAL_SEC, 'a vendor cannot stretch the poll past usefulness');
  assert.equal(clampInterval(Number.NaN), 5, 'a missing interval falls back to the RFC default');
  assert.equal(clampInterval(7.9), 7);
});

test('a poll is due from the stored timestamp, not from a live timer', () => {
  // This is what makes resuming safe. The popup ticks every 2s, the background wakes at times
  // nobody controls, and the worker may have died in between. The decision is arithmetic on the
  // record, so no arrangement of callers polls the vendor faster than it asked.
  const p = makePending({ intervalSec: 5, lastPolledAt: T0 });
  assert.ok(!shouldPoll(p, T0 + 1000), 'one second after a poll is too soon');
  assert.ok(!shouldPoll(p, T0 + 4999));
  assert.ok(shouldPoll(p, T0 + 5000), 'exactly the interval is due');
  assert.ok(shouldPoll(p, T0 + 60_000), 'long overdue is still just due');
});

test('a popup ticking faster than the interval cannot outpace the vendor', () => {
  // The popup's own timer is 2s, deliberately faster than any vendor interval, because its job is
  // to be responsive to the ANSWER, not to drive the rate. Simulate 2s ticks over 20s against a
  // 5s interval and count how many would reach the vendor.
  let p = makePending({ intervalSec: 5, lastPolledAt: T0 });
  let polls = 0;
  for (let t = T0 + 2000; t <= T0 + 20_000; t += 2000) {
    if (shouldPoll(p, t)) {
      polls++;
      p = { ...p, lastPolledAt: t };
    }
  }
  // 20s at one poll per 5s, with ticks landing on even seconds: 6s, 12s, 18s.
  assert.equal(polls, 3);
});

test('msUntilNextPoll counts down and floors at zero', () => {
  const p = makePending({ intervalSec: 5, lastPolledAt: T0 });
  assert.equal(msUntilNextPoll(p, T0), 5000);
  assert.equal(msUntilNextPoll(p, T0 + 3000), 2000);
  assert.equal(msUntilNextPoll(p, T0 + 5000), 0);
  assert.equal(msUntilNextPoll(p, T0 + 99_000), 0);
});

// ---------------------------------------------------------------------------
// slow_down
// ---------------------------------------------------------------------------

test('slow_down widens the interval by the RFC step and stops at the ceiling', () => {
  const p = makePending({ intervalSec: 5 });
  assert.equal(slowDown(p).intervalSec, 5 + SLOW_DOWN_STEP_SEC);
  assert.equal(slowDown(slowDown(p)).intervalSec, 5 + 2 * SLOW_DOWN_STEP_SEC);

  // A vendor answering slow_down in a loop must not push the poll past the point where the code
  // would expire unpolled.
  let wide = makePending({ intervalSec: 5 });
  for (let i = 0; i < 50; i++) wide = slowDown(wide);
  assert.equal(wide.intervalSec, MAX_INTERVAL_SEC);
});

test('a slow_down outcome both widens the interval and records the attempt', () => {
  const p = makePending({ intervalSec: 5, lastPolledAt: T0 });
  const effect = applyOutcome(p, { kind: 'slow_down' }, T0 + 5000);
  assert.equal(effect.store, 'keep');
  if (effect.store !== 'keep') return;
  assert.equal(effect.next.intervalSec, 10);
  assert.equal(effect.next.lastPolledAt, T0 + 5000, 'a slow_down still counts as a poll');
  // And the widened interval is honoured from that moment.
  assert.ok(!shouldPoll(effect.next, T0 + 5000 + 9000));
  assert.ok(shouldPoll(effect.next, T0 + 5000 + 10_000));
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test('an expired code stops being polled and is never offered as typeable', () => {
  const p = makePending({ expiresAt: T0 + 60_000, lastPolledAt: T0 });
  assert.ok(!isExpired(p, T0 + 59_999));
  assert.ok(isExpired(p, T0 + 60_000));
  assert.ok(!shouldPoll(p, T0 + 120_000), 'past expiry there is nothing to ask the vendor');

  // And restore shows the "start again" sentence rather than a dead code the user might type.
  const shown = restore(p, T0 + 120_000);
  assert.equal(shown.status, 'error');
  if (shown.status !== 'error') return;
  assert.match(shown.message, /expired/i);
  assert.match(shown.message, /start again/i);
});

test('the expiry sentence names the vendor the user was signing in to', () => {
  assert.match(expiredMessage('xai'), /SuperGrok/);
  assert.match(expiredMessage('chatgpt'), /ChatGPT/);
  assert.equal(vendorName('xai'), 'SuperGrok');
  assert.equal(vendorName('chatgpt'), 'ChatGPT');
});

test('an expired outcome clears the record', () => {
  assert.equal(applyOutcome(makePending(), { kind: 'expired' }, T0).store, 'clear');
});

// ---------------------------------------------------------------------------
// restore: what a reopened popup sees
// ---------------------------------------------------------------------------

test('a reopened popup gets the same code back, not a fresh sign-in button', () => {
  // The iOS sequence this exists for: tabs.create dismisses the popup, the component unmounts, the
  // user approves on the vendor page, comes back, and the popup mounts again. Before this, it drew
  // "Sign in with SuperGrok" while a live code sat on the vendor's page.
  const p = makePending({ userCode: 'WXYZ-1234', verificationUri: 'https://auth.x.ai/device' });
  const shown = restore(p, T0 + 30_000);
  assert.equal(shown.status, 'pending');
  if (shown.status !== 'pending') return;
  assert.equal(shown.userCode, 'WXYZ-1234', 'the same code, so it still matches the vendor page');
  assert.equal(shown.verificationUri, 'https://auth.x.ai/device');
  assert.equal(shown.expiresAt, p.expiresAt);
});

test('nothing pending restores as idle', () => {
  assert.deepEqual(restore(null, T0), { status: 'idle' });
});

// ---------------------------------------------------------------------------
// Folding an outcome back in
// ---------------------------------------------------------------------------

test('a pending answer keeps the flow and marks the attempt', () => {
  const p = makePending({ lastPolledAt: T0 });
  const effect = applyOutcome(p, { kind: 'pending' }, T0 + 5000);
  assert.equal(effect.store, 'keep');
  if (effect.store !== 'keep') return;
  assert.equal(effect.next.lastPolledAt, T0 + 5000);
  assert.equal(effect.next.intervalSec, 5, 'a plain pending does not change the rate');
  assert.equal(effect.next.deviceCode, p.deviceCode, 'the credential survives every fold');
});

test('a transient failure keeps the flow rather than making the user start over', () => {
  // A dropped connection, a 502, a fetch that failed because the phone was locked. The code on the
  // vendor's page is still live and the user is still waiting on it; throwing the flow away would
  // hand them a new code for a page showing the old one.
  const p = makePending({ intervalSec: 5, lastPolledAt: T0 });
  const effect = applyOutcome(p, { kind: 'retry', message: 'Could not reach auth.x.ai.' }, T0 + 5000);
  assert.equal(effect.store, 'keep');
  if (effect.store !== 'keep') return;
  assert.equal(effect.next.intervalSec, 5, 'a retry is not a slow_down: the rate is unchanged');
  assert.equal(effect.next.lastPolledAt, T0 + 5000);
});

test('every terminal outcome clears the record', () => {
  // So a popup opened later cannot resurrect a code the vendor has finished with.
  const terminal: PollOutcome[] = [
    { kind: 'success', tokens: { access: 'a', refresh: 'r', expiresAt: T0 } },
    { kind: 'denied', message: 'declined' },
    { kind: 'expired' },
    { kind: 'fatal', message: 'broken' },
  ];
  for (const outcome of terminal) {
    assert.equal(applyOutcome(makePending(), outcome, T0).store, 'clear', outcome.kind);
  }
});

// ---------------------------------------------------------------------------
// Sequences: the whole machine, run
// ---------------------------------------------------------------------------

/**
 * Drive the machine over a scripted set of vendor answers, the way the background does.
 *
 * `outcomes` is consumed one per ACTUAL poll, so ticks that `shouldPoll` rejects consume nothing —
 * which is what makes the interval assertions below mean anything.
 */
function drive(start: PendingLogin, ticks: number[], outcomes: PollOutcome[]) {
  let p: PendingLogin | null = start;
  const polledAt: number[] = [];
  let ended: PollOutcome | null = null;
  let i = 0;
  for (const now of ticks) {
    if (!p) break;
    if (isExpired(p, now)) {
      ended = { kind: 'expired' };
      p = null;
      break;
    }
    if (!shouldPoll(p, now)) continue;
    const outcome = outcomes[i++] ?? { kind: 'pending' };
    polledAt.push(now);
    const effect = applyOutcome(p, outcome, now);
    if (effect.store === 'clear') {
      ended = outcome;
      p = null;
    } else {
      p = effect.next;
    }
  }
  return { pending: p, polledAt, ended };
}

test('a sign-in survives the worker being killed between polls', () => {
  // The Safari sequence: start, poll, the popup opens the verification tab, the popup is dismissed
  // and the event page is suspended for 40 seconds, then something wakes it. The record is the
  // only thing that crossed the gap, and it is enough.
  const start = pendingFrom('xai', { deviceCode: 'dev-1', userCode: 'WXYZ-1234', verificationUri: 'https://auth.x.ai/device', intervalSec: 5, expiresAt: T0 + 6e5 }, T0);

  const before = drive(start, [T0, T0 + 2000], [{ kind: 'pending' }]);
  assert.ok(before.pending, 'still in flight when the worker dies');

  // Everything in memory is gone; this is what came back off disk.
  const resumed: PendingLogin = JSON.parse(JSON.stringify(before.pending));
  assert.equal(resumed.deviceCode, 'dev-1');
  assert.equal(resumed.userCode, 'WXYZ-1234');

  const after = drive(resumed, [T0 + 45_000], [{ kind: 'success', tokens: { access: 'tok' } }]);
  assert.equal(after.ended?.kind, 'success');
  assert.equal(after.pending, null, 'success clears the pending record');
});

test('a resume does not re-poll before the interval the vendor asked for', () => {
  // A worker that wakes twice in a second — two messages arriving together — must not turn into
  // two vendor requests a second apart.
  const p = makePending({ intervalSec: 5, lastPolledAt: T0 });
  const run = drive(p, [T0 + 500, T0 + 1000, T0 + 1500, T0 + 5000], [{ kind: 'pending' }, { kind: 'pending' }]);
  assert.deepEqual(run.polledAt, [T0 + 5000], 'only the tick past the interval reached the vendor');
});

test('slow_down then success, with the widened rate honoured in between', () => {
  const p = makePending({ intervalSec: 5, lastPolledAt: T0 });
  const ticks = [T0 + 5000, T0 + 8000, T0 + 10_000, T0 + 15_000];
  const run = drive(p, ticks, [{ kind: 'slow_down' }, { kind: 'success', tokens: { access: 'tok' } }]);
  // 5000 polls (due), widens to 10s. 8000 and 10000 are inside the new interval. 15000 is due.
  assert.deepEqual(run.polledAt, [T0 + 5000, T0 + 15_000]);
  assert.equal(run.ended?.kind, 'success');
});

test('a code that runs out while nothing is polling ends as expired, not as pending', () => {
  // The phone was locked for twenty minutes. Whatever wakes next must not show a dead code.
  const p = makePending({ expiresAt: T0 + 6e5, lastPolledAt: T0 });
  const run = drive(p, [T0 + 30 * 60 * 1000], [{ kind: 'pending' }]);
  assert.equal(run.ended?.kind, 'expired');
  assert.deepEqual(run.polledAt, [], 'no request is spent on a code the clock already rejected');
});

test('cancelling is just clearing the record, and a later tick finds nothing', () => {
  // `oauth.cancel` removes the key; the machine then has nothing to resume, which is the point —
  // a cancelled sign-in must not come back when the popup reopens.
  const p: PendingLogin | null = makePending();
  const cancelled: PendingLogin | null = null;
  assert.deepEqual(restore(cancelled, T0), { status: 'idle' });
  assert.equal(restore(p, T0).status, 'pending', 'and before the cancel it did come back');
});

test('both vendors can be pending at once without touching each other', () => {
  const gpt = pendingFrom('chatgpt', { deviceCode: 'gpt-dev', userCode: 'AAAA-1111', verificationUri: 'https://auth.openai.com/codex/device', intervalSec: 5, expiresAt: T0 + 9e5 }, T0);
  const grok = pendingFrom('xai', { deviceCode: 'xai-dev', userCode: 'BBBB-2222', verificationUri: 'https://auth.x.ai/device', intervalSec: 5, expiresAt: T0 + 6e5 }, T0);

  assert.notEqual(pendingKey(gpt.kind), pendingKey(grok.kind));

  // One finishing leaves the other exactly as it was.
  const gptDone = applyOutcome(gpt, { kind: 'success', tokens: { access: 'a' } }, T0 + 5000);
  assert.equal(gptDone.store, 'clear');
  const grokOn = applyOutcome(grok, { kind: 'pending' }, T0 + 5000);
  assert.equal(grokOn.store, 'keep');
  if (grokOn.store !== 'keep') return;
  assert.equal(grokOn.next.deviceCode, 'xai-dev');
  assert.equal(grokOn.next.userCode, 'BBBB-2222');
  assert.equal(restore(grokOn.next, T0 + 6000).status, 'pending');

  // And one failing does not poison the other's rate.
  const grokSlow = applyOutcome(grok, { kind: 'slow_down' }, T0 + 5000);
  assert.equal(grokSlow.store, 'keep');
  if (grokSlow.store !== 'keep') return;
  assert.equal(grokSlow.next.intervalSec, 10);
  assert.equal(gpt.intervalSec, 5, 'the ChatGPT record is untouched');
});
