// wait_for: input validation, the wording the model reads back, the abuse guard, and the labels
// the panel shows. Everything here is pure, so the whole contract of the tool is testable without
// a browser — which matters more than usual for this one, because chrome.userScripts is
// unavailable under automation and run_script's then_wait composition can only be exercised here.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONSECUTIVE_WAIT_LIMIT,
  CUMULATIVE_WAIT_LIMIT_MS,
  DEFAULT_QUIET_MS,
  DEFAULT_TIMEOUT_MS,
  EMPTY_TALLY,
  MAX_QUIET_MS,
  MAX_SLEEP_MS,
  MAX_TIMEOUT_MS,
  MIN_QUIET_MS,
  describeCondition,
  foldWait,
  formatMs,
  formatSeconds,
  isDomCondition,
  markNudged,
  parseWaitInput,
  renderWaitResult,
  urlMatches,
  waitAbuseNudge,
  waitActivityDetail,
  waitConditionLabel,
  waitIdentifier,
  waitRowSummary,
  type WaitCondition,
  type WaitSpec,
} from '../lib/agent/wait.ts';
import { ACT_TOOLS, NEUTRAL_TOOLS, READ_TOOLS, countReads, readBudgetNudge } from '../lib/agent/budget.ts';
import { toolDotClass, toolDotState, toolRowTitle } from '../lib/transcript.ts';
import { TOOLS } from '../lib/agent/tools.ts';

/** Parse, asserting success, and hand back the spec. */
function spec(raw: unknown): WaitSpec {
  const r = parseWaitInput(raw);
  assert.ok(r.ok, `expected ${JSON.stringify(raw)} to parse, got ${r.ok ? '' : r.error}`);
  return r.spec;
}

/** Parse, asserting failure, and hand back the message. */
function refusal(raw: unknown): string {
  const r = parseWaitInput(raw);
  assert.ok(!r.ok, `expected ${JSON.stringify(raw)} to be refused, but it parsed`);
  return r.error;
}

// ---------------------------------------------------------------------------
// One condition per call
// ---------------------------------------------------------------------------

test('a bare selector defaults to visible, count 1, and the default timeout', () => {
  const s = spec({ selector: '.result' });
  assert.deepEqual(s.condition, { kind: 'selector', selector: '.result', state: 'visible', count: 1 });
  assert.equal(s.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('two conditions are refused by name, rather than one being silently ignored', () => {
  // Silently answering a different question than the one asked is how an agent loses the thread,
  // so this must name both halves.
  const msg = refusal({ selector: '.result', url: '/checkout' });
  assert.match(msg, /exactly one condition/);
  assert.match(msg, /selector and url/);
});

test('selector + text is ONE condition: the text filters the matched elements', () => {
  const s = spec({ selector: 'li', text: 'Done' });
  assert.deepEqual(s.condition, { kind: 'selector', selector: 'li', state: 'visible', count: 1, text: 'Done' });
});

test('text on its own is the page-text condition, and gone inverts it', () => {
  assert.deepEqual(spec({ text: 'Loaded' }).condition, { kind: 'text', text: 'Loaded', gone: false });
  assert.deepEqual(spec({ text: 'Loading…', gone: true }).condition, { kind: 'text', text: 'Loading…', gone: true });
});

test('no condition at all is refused, and the message lists what is on offer', () => {
  assert.match(refusal({}), /selector, text, url, load, idle or ms/);
  assert.match(refusal({ timeout_ms: 3000 }), /selector, text, url, load, idle or ms/);
});

test('a non-object input is refused rather than treated as an empty condition', () => {
  assert.match(refusal('visible'), /object describing one condition/);
  assert.match(refusal(null), /object describing one condition/);
});

// ---------------------------------------------------------------------------
// Each kind's own validation
// ---------------------------------------------------------------------------

test('every element state is accepted and anything else is refused by name', () => {
  for (const state of ['attached', 'visible', 'hidden', 'detached']) {
    assert.equal(spec({ selector: '.x', state }).condition.kind, 'selector');
  }
  assert.match(refusal({ selector: '.x', state: 'showing' }), /attached, visible, hidden, detached/);
});

test('count must be a positive integer, and is floored', () => {
  assert.equal((spec({ selector: '.x', count: 3 }).condition as Extract<WaitCondition, { kind: 'selector' }>).count, 3);
  assert.equal((spec({ selector: '.x', count: 2.7 }).condition as Extract<WaitCondition, { kind: 'selector' }>).count, 2);
  assert.match(refusal({ selector: '.x', count: 0 }), /positive integer/);
  assert.match(refusal({ selector: '.x', count: -1 }), /positive integer/);
});

test('count with state detached is refused: it asks for N elements that are not there', () => {
  // Waiting 5s and reporting a timeout would read as the page's fault for a contradiction we can
  // see in the input.
  assert.match(refusal({ selector: '.x', state: 'detached', count: 2 }), /does not apply to state "detached"/);
  // count: 1 is the default and means nothing here, so it stays legal.
  assert.equal(spec({ selector: '.x', state: 'detached', count: 1 }).condition.kind, 'selector');
});

test('an empty selector or empty text is refused, rather than waiting for nothing', () => {
  assert.match(refusal({ selector: '   ' }), /non-empty CSS selector/);
  // An empty or blank text would match every page instantly, which is a wait that silently does
  // nothing — worse than a refusal, because the model reads "matched after 0ms" and believes it.
  assert.match(refusal({ text: '' }), /non-empty string/);
  assert.match(refusal({ text: '   ' }), /non-empty string/);
});

test('a url pattern is a substring unless it is wrapped in slashes', () => {
  assert.deepEqual(spec({ url: '/checkout' }).condition, { kind: 'url', pattern: '/checkout', regex: false });
  assert.deepEqual(spec({ url: '/\\/cart\\/\\d+/' }).condition, { kind: 'url', pattern: '/\\/cart\\/\\d+/', regex: true });
});

test('a broken regex is an INPUT error, not a wait that can never match', () => {
  assert.match(refusal({ url: '/(unclosed/' }), /Invalid regular expression/);
});

test('urlMatches does substrings, regexes, and does not carry lastIndex between calls', () => {
  const sub = spec({ url: '/checkout' }).condition as Extract<WaitCondition, { kind: 'url' }>;
  assert.equal(urlMatches('https://shop.example.com/checkout/1', sub), true);
  assert.equal(urlMatches('https://shop.example.com/cart', sub), false);

  const re = spec({ url: '/step=\\d+/' }).condition as Extract<WaitCondition, { kind: 'url' }>;
  assert.equal(urlMatches('https://x.test/?step=2', re), true);
  assert.equal(urlMatches('https://x.test/?step=none', re), false);

  // A /g regex keeps lastIndex across .test() calls, which would make the same URL match, then
  // not match, then match — a wait that resolves or not depending on how often it was polled.
  const global = spec({ url: '/item/g' }).condition as Extract<WaitCondition, { kind: 'url' }>;
  const url = 'https://x.test/item/item';
  assert.equal(urlMatches(url, global), true);
  assert.equal(urlMatches(url, global), true);
  assert.equal(urlMatches(url, global), true);
});

test('load takes only the two documented states', () => {
  assert.deepEqual(spec({ load: 'complete' }).condition, { kind: 'load', state: 'complete' });
  assert.deepEqual(spec({ load: 'domcontentloaded' }).condition, { kind: 'load', state: 'domcontentloaded' });
  assert.match(refusal({ load: 'networkidle' }), /domcontentloaded, complete/);
});

test('idle accepts the three shapes a model will try, and clamps the quiet window', () => {
  assert.deepEqual(spec({ idle: true }).condition, { kind: 'idle', quietMs: DEFAULT_QUIET_MS });
  assert.deepEqual(spec({ idle: true, quiet_ms: 800 }).condition, { kind: 'idle', quietMs: 800 });
  assert.deepEqual(spec({ idle: 300 }).condition, { kind: 'idle', quietMs: 300 });
  assert.deepEqual(spec({ idle: { quiet_ms: 250 } }).condition, { kind: 'idle', quietMs: 250 });
  // Out of range in both directions.
  assert.deepEqual(spec({ idle: true, quiet_ms: 5 }).condition, { kind: 'idle', quietMs: MIN_QUIET_MS });
  assert.deepEqual(spec({ idle: true, quiet_ms: 99_999 }).condition, { kind: 'idle', quietMs: MAX_QUIET_MS });
});

test('ms is capped at 5s, far below the timeout cap, because a blind sleep is the last resort', () => {
  assert.deepEqual(spec({ ms: 800 }).condition, { kind: 'ms', ms: 800 });
  assert.deepEqual(spec({ ms: 60_000 }).condition, { kind: 'ms', ms: MAX_SLEEP_MS });
  assert.ok(MAX_SLEEP_MS < MAX_TIMEOUT_MS, 'a blind sleep must not be allowed to run as long as a real condition');
  assert.match(refusal({ ms: -5 }), /number of milliseconds/);
});

test('a plain delay takes its own duration as its timeout, so the two cannot contradict', () => {
  // {ms: 3000, timeout_ms: 1000} would otherwise be a sleep that times out before it finishes, and
  // there is no honest thing to report for that.
  assert.equal(spec({ ms: 3000, timeout_ms: 1000 }).timeoutMs, 3000);
});

test('timeout_ms is clamped to the cap and must be positive', () => {
  assert.equal(spec({ selector: '.x', timeout_ms: 12_000 }).timeoutMs, 12_000);
  assert.equal(spec({ selector: '.x', timeout_ms: 90_000 }).timeoutMs, MAX_TIMEOUT_MS);
  assert.match(refusal({ selector: '.x', timeout_ms: 0 }), /positive number/);
});

// ---------------------------------------------------------------------------
// Where each condition runs
// ---------------------------------------------------------------------------

test('DOM conditions run in the page; url and load cannot, because the page is destroyed', () => {
  assert.equal(isDomCondition(spec({ selector: '.x' }).condition), true);
  assert.equal(isDomCondition(spec({ text: 'hi' }).condition), true);
  assert.equal(isDomCondition(spec({ idle: true }).condition), true);
  assert.equal(isDomCondition(spec({ url: '/x' }).condition), false);
  assert.equal(isDomCondition(spec({ load: 'complete' }).condition), false);
  assert.equal(isDomCondition(spec({ ms: 100 }).condition), false);
});

// ---------------------------------------------------------------------------
// What the model reads back
// ---------------------------------------------------------------------------

test('a match reports how long it took and what matched', () => {
  const s = spec({ selector: '.result' });
  const r = renderWaitResult(s, {
    matched: true,
    elapsedMs: 1240,
    detail: '3 elements match .result and are visible (first: <li class="result">Alpha)',
  });
  assert.equal(r.isError, false);
  assert.equal(r.text, 'matched after 1,240ms: 3 elements match .result and are visible (first: <li class="result">Alpha)');
});

test('an already-true condition reports ~0ms rather than pretending to have waited', () => {
  const r = renderWaitResult(spec({ selector: '.x' }), { matched: true, elapsedMs: 0, detail: '1 element matches .x and is visible' });
  assert.match(r.text, /^matched after 0ms:/);
});

test('a timeout is NOT an error, says so, and carries the diagnostics', () => {
  // This is the whole design. A model handed isError goes back to polling; a model handed the
  // page's actual state changes its selector.
  const s = spec({ selector: '.result', timeout_ms: 5000 });
  const r = renderWaitResult(s, {
    matched: false,
    elapsedMs: 5001,
    diagnostics: ['0 elements match .result.', 'closest: 12 element(s) match li', 'document.readyState=complete; 0 mutation batches observed in the last 5001ms.'],
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /^Timed out after 5,001ms waiting for \.result to be visible\./);
  assert.match(r.text, /This is not an error/);
  assert.match(r.text, /0 elements match \.result\./);
  assert.match(r.text, /closest: 12 element\(s\) match li/);
  // And it tells the model what the two readings mean for its next step.
  assert.match(r.text, /change approach rather than waiting again/);
});

test('only a wait that could not run at all is an error', () => {
  const s = spec({ selector: '.x' });
  const closed = renderWaitResult(s, { matched: false, elapsedMs: 40, failure: 'The tab was closed while waiting.' });
  assert.equal(closed.isError, true);
  assert.equal(closed.text, 'The tab was closed while waiting.');
});

test('describeCondition says what a person would say', () => {
  assert.equal(describeCondition(spec({ selector: '.result' }).condition), '.result to be visible');
  assert.equal(describeCondition(spec({ selector: '.row', count: 3 }).condition), '3 elements matching .row to be visible');
  assert.equal(describeCondition(spec({ selector: 'li', text: 'Done' }).condition), 'li containing "Done" to be visible');
  assert.equal(describeCondition(spec({ selector: '.modal', state: 'detached' }).condition), '.modal to be gone from the DOM');
  assert.equal(describeCondition(spec({ text: 'Loaded' }).condition), 'the text "Loaded" to appear on the page');
  assert.equal(describeCondition(spec({ text: 'Spinner', gone: true }).condition), 'the text "Spinner" to disappear from the page');
  assert.equal(describeCondition(spec({ url: '/checkout' }).condition), 'the URL to match /checkout');
  assert.equal(describeCondition(spec({ load: 'complete' }).condition), 'the page to reach complete');
  assert.equal(describeCondition(spec({ idle: true }).condition), 'the DOM to stop changing for 500ms');
  assert.equal(describeCondition(spec({ ms: 750 }).condition), '750ms to pass');
});

test('durations read the way a person would write them', () => {
  assert.equal(formatMs(1240), '1,240ms');
  assert.equal(formatMs(0), '0ms');
  assert.equal(formatSeconds(1240), '1.2s');
  assert.equal(formatSeconds(5000), '5s');
  assert.equal(formatSeconds(15_400), '15s');
});

// ---------------------------------------------------------------------------
// The labels the panel shows
// ---------------------------------------------------------------------------

test('the activity line names what is being waited for', () => {
  assert.equal(waitActivityDetail(spec({ selector: '.result' }).condition), 'waiting for .result');
  assert.equal(waitActivityDetail(spec({ text: 'Loaded' }).condition), 'waiting for "Loaded"');
  assert.equal(waitActivityDetail(spec({ url: '/checkout' }).condition), 'waiting for /checkout');
});

test('a long selector is truncated so it cannot push the elapsed timer off a 420px panel', () => {
  const long = '.a-very-long-generated-class-name-from-some-build-tool > li.item';
  const id = waitIdentifier(spec({ selector: long }).condition);
  assert.ok(id.length <= 32, `identifier was ${id.length} chars: ${id}`);
  assert.ok(id.endsWith('…'));
});

test('the transcript row shows the condition, not a bare tool name', () => {
  assert.equal(toolRowTitle('wait_for', { selector: '.result' }), 'wait_for .result visible');
  assert.equal(toolRowTitle('wait_for', { selector: 'li', count: 3, state: 'attached' }), 'wait_for li ×3 attached');
  assert.equal(toolRowTitle('wait_for', { url: '/checkout' }), 'wait_for url /checkout');
  assert.equal(toolRowTitle('wait_for', { idle: true }), 'wait_for idle 500ms');
  // A condition too broken to parse still gives a row that says which tool it was.
  assert.equal(toolRowTitle('wait_for', { selector: '.a', url: '/b' }), 'wait_for');
  // Everything else keeps the behaviour it had.
  assert.equal(toolRowTitle('run_script', { description: 'hide the modal' }), 'run_script: hide the modal');
  assert.equal(toolRowTitle('find_elements', { selector: '#login' }), 'find_elements #login');
  assert.equal(toolRowTitle('screenshot', {}), 'screenshot');
});

test('waitConditionLabel stays compact enough for a row', () => {
  assert.equal(waitConditionLabel(spec({ selector: 'li', text: 'Done' }).condition), 'li "Done" visible');
  assert.equal(waitConditionLabel(spec({ text: 'Loading', gone: true }).condition), 'text "Loading" gone');
  assert.equal(waitConditionLabel(spec({ load: 'complete' }).condition), 'load complete');
});

test('a timed-out wait takes the amber waiting dot, not the error dot', () => {
  // The distinction IS the feature: painting a timeout coral teaches the user that waiting went
  // wrong when it went exactly as designed.
  const timedOut = { kind: 'tool', id: '1', name: 'wait_for', input: { selector: '.x' }, summary: 'timed out after 5s' } as const;
  assert.equal(toolDotState(timedOut), 'waiting');
  assert.equal(toolDotClass(toolDotState(timedOut)), ' running');

  const matched = { kind: 'tool', id: '2', name: 'wait_for', input: { selector: '.x' }, summary: 'matched after 1.2s' } as const;
  assert.equal(toolDotState(matched), 'ok');
  assert.equal(toolDotClass(toolDotState(matched)), '');

  // A wait that genuinely failed (closed tab) still reads as an error.
  const failed = { kind: 'tool', id: '3', name: 'wait_for', input: { selector: '.x' }, summary: 'The tab was closed while waiting.', isError: true } as const;
  assert.equal(toolDotState(failed), 'error');
  assert.equal(toolDotClass(toolDotState(failed)), ' error');

  // Still running.
  const running = { kind: 'tool', id: '4', name: 'wait_for', input: { selector: '.x' } } as const;
  assert.equal(toolDotState(running), 'running');
});

test('waitRowSummary is what the dot state is read from, so the two cannot drift', () => {
  assert.equal(waitRowSummary({ matched: true, elapsedMs: 1240 }), 'matched after 1.2s');
  assert.equal(waitRowSummary({ matched: false, elapsedMs: 5000 }), 'timed out after 5s');
  const summary = waitRowSummary({ matched: false, elapsedMs: 5000 });
  assert.equal(toolDotState({ kind: 'tool', id: '1', name: 'wait_for', input: {}, summary }), 'waiting');
});

// ---------------------------------------------------------------------------
// Budgets: a wait is neither a read nor an act
// ---------------------------------------------------------------------------

test('wait_for is in neither budget set, so it cannot trip or reset the read budget', () => {
  assert.equal(READ_TOOLS.has('wait_for'), false, 'charging for a wait would push the model back to polling');
  assert.equal(ACT_TOOLS.has('wait_for'), false, 'a wait proves nothing about the page, so it must not clear a read streak');
  assert.equal(NEUTRAL_TOOLS.has('wait_for'), true);
});

test('waiting between reads neither advances nor resets the read count', () => {
  let reads = 0;
  reads = countReads(reads, ['get_page']);
  reads = countReads(reads, ['wait_for']);
  assert.equal(reads, 1, 'the wait itself must not count as a read');
  reads = countReads(reads, ['find_elements']);
  reads = countReads(reads, ['wait_for']);
  reads = countReads(reads, ['get_styles']);
  assert.equal(reads, 3, 'and it must not have laundered the streak either');
  // Which means the read nudge still fires on the read that crosses the budget.
  const before = reads;
  reads = countReads(reads, ['get_page']);
  assert.match(readBudgetNudge(reads, before) ?? '', /4 page reads/);
});

// ---------------------------------------------------------------------------
// The abuse guard
// ---------------------------------------------------------------------------

test('a lone wait, and waits separated by real work, are never nudged', () => {
  let t = foldWait(EMPTY_TALLY, ['wait_for'], 400);
  assert.equal(waitAbuseNudge(t), null);
  // wait, act, wait, act, wait: the intended rhythm.
  for (let i = 0; i < 5; i++) {
    t = foldWait(t, ['run_script'], 0);
    t = foldWait(t, ['wait_for'], 900);
    assert.equal(waitAbuseNudge(t), null, `nudged on cycle ${i} of normal use`);
  }
});

test('more than three waits in a row earns the nudge, once', () => {
  let t = EMPTY_TALLY;
  for (let i = 0; i < CONSECUTIVE_WAIT_LIMIT; i++) {
    t = foldWait(t, ['wait_for'], 500);
    assert.equal(waitAbuseNudge(t), null, `fired early, at ${i + 1} waits`);
  }
  t = foldWait(t, ['wait_for'], 500);
  const nudge = waitAbuseNudge(t);
  assert.equal(nudge, '[You have waited 4 times in a row. If the condition is not going to happen, change approach or tell the user what is blocking you.]');

  // It does not repeat on every later wait of the same streak.
  t = markNudged(t);
  t = foldWait(t, ['wait_for'], 500);
  assert.equal(waitAbuseNudge(t), null);
});

test('acting clears the streak AND re-arms the nudge, so a later streak is caught too', () => {
  let t = EMPTY_TALLY;
  for (let i = 0; i < 4; i++) t = foldWait(t, ['wait_for'], 100);
  t = markNudged(foldWait(t, [], 0));
  t = foldWait(t, ['run_script'], 0);
  assert.equal(t.consecutive, 0);
  for (let i = 0; i < 4; i++) t = foldWait(t, ['wait_for'], 100);
  assert.ok(waitAbuseNudge(t), 'a second streak after doing real work must be caught again');
});

test('a minute of cumulative waiting is caught even when the waits were not consecutive', () => {
  // Three 20s waits with work between them never trip the streak rule, but they have eaten a
  // minute of the user's turn, which is the other thing worth saying out loud.
  let t = EMPTY_TALLY;
  for (let i = 0; i < 3; i++) {
    t = foldWait(t, ['run_script'], 0);
    t = foldWait(t, ['wait_for'], 20_000);
    assert.equal(t.consecutive, 1, 'these waits are never consecutive, so only the time rule can catch them');
  }
  assert.equal(t.totalMs, CUMULATIVE_WAIT_LIMIT_MS, 'exactly the limit: spending it counts as spending it');
  // And it says so in the language of what actually happened. The streak wording ("you have waited
  // 1 times in a row") would be visibly false here, and a nudge the model can see is wrong is one
  // it is right to discount.
  assert.equal(
    waitAbuseNudge(t),
    '[You have spent 60s of this turn waiting. If the condition is not going to happen, change approach or tell the user what is blocking you.]',
  );
});

test('the tally charges what a wait really cost, not what it was allowed to cost', () => {
  // A wait that matched in 30ms must not be charged its 20s timeout, or the cheap correct wait —
  // the one we want the model making — would be the one that trips the guard.
  let t = EMPTY_TALLY;
  for (let i = 0; i < 20; i++) {
    t = foldWait(t, ['run_script'], 0);
    t = foldWait(t, ['wait_for'], 30);
  }
  assert.equal(t.totalMs, 600);
  assert.equal(waitAbuseNudge(t), null);
});

test('a batch with a wait and a real tool together counts as acting', () => {
  const t = foldWait({ consecutive: 3, totalMs: 0, nudged: false }, ['wait_for', 'get_page'], 200);
  assert.equal(t.consecutive, 1, 'the streak restarts at this batch rather than continuing');
  assert.equal(waitAbuseNudge(t), null);
});

// ---------------------------------------------------------------------------
// then_wait: composition, which cannot be exercised in a browser
// ---------------------------------------------------------------------------
//
// chrome.userScripts is unavailable in an automated profile, so run_script never runs in the
// browser flow and the composition below has no other home. These assert the two halves of the
// contract the loop implements: then_wait takes exactly the same input as wait_for, and a
// navigation stops being a lost result when it is the thing the model asked to wait for.

test('then_wait takes exactly the same condition shape as wait_for', () => {
  const direct = spec({ selector: '.result', state: 'attached', timeout_ms: 8000 });
  const composed = spec({ selector: '.result', state: 'attached', timeout_ms: 8000 });
  assert.deepEqual(composed, direct);
});

test('then_wait rejects the same malformed conditions, so a bad one costs no page change', () => {
  // The loop parses then_wait BEFORE running the code, so this refusal means the page is untouched.
  assert.match(refusal({ selector: '.a', load: 'complete' }), /exactly one condition/);
  assert.match(refusal({ url: '/(broken/' }), /Invalid regular expression/);
});

test('a navigation is the expected outcome only for a url or load then_wait', () => {
  // This mirrors the rule in lib/agent/loop.ts: a script that navigates normally loses its result,
  // but when the model said it was waiting for the navigation, that same outcome is success.
  const expected = (c: WaitCondition) => c.kind === 'url' || c.kind === 'load';
  assert.equal(expected(spec({ url: '/checkout' }).condition), true);
  assert.equal(expected(spec({ load: 'complete' }).condition), true);
  assert.equal(expected(spec({ selector: '.result' }).condition), false);
  assert.equal(expected(spec({ text: 'Done' }).condition), false);
  assert.equal(expected(spec({ idle: true }).condition), false);
});

// ---------------------------------------------------------------------------
// The schema the model actually sees
// ---------------------------------------------------------------------------

test('wait_for is offered, closed to stray keys, and tells the model when to reach for it', () => {
  const tool = TOOLS.find((t) => t.name === 'wait_for');
  assert.ok(tool, 'the tool must be in the list the provider is handed');
  const schema = tool.inputSchema as { properties: Record<string, unknown>; additionalProperties: boolean };
  assert.equal(schema.additionalProperties, false);
  for (const key of ['selector', 'state', 'count', 'text', 'gone', 'url', 'load', 'idle', 'quiet_ms', 'ms', 'timeout_ms']) {
    assert.ok(key in schema.properties, `wait_for is missing ${key}`);
  }
  // The description is the only thing that decides whether the model reaches for this instead of
  // polling, so its promises are pinned here.
  assert.match(tool.description, /never poll with run_script/i);
  assert.match(tool.description, /timeout is NOT an error/i);
  assert.match(tool.description, /exactly one condition/i);
});

test('run_script offers then_wait with the same condition keys', () => {
  const run = TOOLS.find((t) => t.name === 'run_script');
  assert.ok(run);
  const schema = run.inputSchema as { properties: Record<string, { properties?: Record<string, unknown> }> };
  const then = schema.properties.then_wait;
  assert.ok(then?.properties, 'run_script must offer then_wait');
  for (const key of ['selector', 'state', 'count', 'text', 'url', 'load', 'idle', 'ms', 'timeout_ms']) {
    assert.ok(key in then.properties, `then_wait is missing ${key}`);
  }
});

test('the prompt teaches waiting instead of polling, and keeps mods on MutationObserver', async () => {
  const { SYSTEM_PROMPT } = await import('../lib/agent/prompt.ts');
  assert.match(SYSTEM_PROMPT, /wait_for/);
  assert.match(SYSTEM_PROMPT, /then_wait/);
  assert.match(SYSTEM_PROMPT, /Never poll/i);
  // The advice for the MOD itself is unchanged: wait_for is for the agent's own testing.
  assert.match(SYSTEM_PROMPT, /MutationObserver/);
});
