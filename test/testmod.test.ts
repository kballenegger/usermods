// test_mod: the proposal gate's three states, the source comparison behind them, what the model is
// told after a test, and the rules that keep a temporary registration from outliving its test.
//
// The browser half (a real chrome.userScripts registration, a reload, the recorder) is exercised by
// scripts/reviewer-walkthrough.mjs; everything that decides something is here.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runAgent, type AgentEnv } from '../lib/agent/loop.ts';
import { checkProposal, testedAs, testedNote, type ProposalContext } from '../lib/agent/propose.ts';
import { renderTestResult, sourceKey, type TestModResult } from '../lib/agent/testmod.ts';
import {
  TEST_MARKER_KEY,
  TEST_RUN_PREFIX,
  composeTest,
  engineRunsModOn,
  guardOnce,
  inPageWorld,
  isTestRunId,
  markerCode,
  patternsForPage,
  relayCode,
  testRunId,
  testRunsToSweep,
  unmarkerCode,
} from '../lib/exec/testrun.ts';
import type { Provider, ProviderResponse } from '../lib/providers/types.ts';
import type { AgentEventBody, ModProposal, Msg, Part, Settings } from '../lib/types.ts';

const CODE = `const s = document.createElement('style');\ns.textContent = '.ad { display: none !important; }';\ndocument.head.appendChild(s);`;
const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({ testedSinceProposal: false, userText: 'hide the ads', ...over });

// ---------------------------------------------------------------------------
// Source comparison
// ---------------------------------------------------------------------------

test('sourceKey ignores what the draft owns and what editors change, and nothing else', () => {
  const withHeader = `// ==UserScript==\n// @name X\n// @match *://*/*\n// ==/UserScript==\n\n${CODE}`;
  assert.equal(sourceKey(withHeader), sourceKey(CODE), 'the header is kept by the draft, so it is not part of the comparison');
  assert.equal(sourceKey(CODE.replace(/\n/g, '\r\n')), sourceKey(CODE), 'CRLF');
  assert.equal(sourceKey(`\n\n${CODE.replace(/\n/g, '   \n')}  \n\n`), sourceKey(CODE), 'trailing whitespace and blank edges');
  assert.notEqual(sourceKey(CODE.replace('none', 'block')), sourceKey(CODE), 'a real edit is a different script');
  assert.notEqual(sourceKey(CODE.replace('\n', '\n  ')), sourceKey(CODE), 'leading indentation is kept: it is part of what was written');
});

// ---------------------------------------------------------------------------
// The gate's three states
// ---------------------------------------------------------------------------

test('test_mod with reload on the proposed code is "tested as the saved mod on a fresh load"', () => {
  const c = ctx({ testedSinceProposal: true, lastTest: { key: sourceKey(CODE), fresh: true, ok: true } });
  assert.equal(testedAs(c, CODE), 'fresh-load');
  assert.equal(testedAs(c, `${CODE}\n`), 'fresh-load', 'a trailing newline is the same script');
  assert.match(testedNote(c, CODE), /saved mod on a fresh load/);
});

test('test_mod without reload is "tested on the open page only"', () => {
  const c = ctx({ testedSinceProposal: true, lastTest: { key: sourceKey(CODE), fresh: false, ok: true } });
  assert.equal(testedAs(c, CODE), 'open-page');
  assert.equal(testedNote(c, CODE), 'The card says it was tested on the open page only, not as the saved mod on a fresh load.');
});

test('proposing code other than what test_mod ran is only "open page", and the model is told why', () => {
  const c = ctx({ testedSinceProposal: true, lastTest: { key: sourceKey(CODE), fresh: true, ok: true } });
  const edited = CODE.replace('none', 'block');
  assert.equal(testedAs(c, edited), 'open-page');
  assert.match(testedNote(c, edited), /not what test_mod last ran/);
});

test('a test_mod that failed on this code says so on the card, rather than "tested"', () => {
  // run_script succeeded earlier; test_mod of this code then threw at load.
  const c = ctx({ testedSinceProposal: true, lastTest: { key: sourceKey(CODE), fresh: true, ok: false } });
  assert.equal(testedAs(c, CODE), 'mod-failed');
  assert.match(testedNote(c, CODE), /failed when test_mod ran it/);
  // Also when the model gave an untested_reason instead of a successful run: the failure is not hidden.
  assert.equal(testedAs(ctx({ lastTest: { key: sourceKey(CODE), fresh: false, ok: false } }), CODE), 'mod-failed');
  // A failure of OTHER code says nothing about this one: back to what the other runs showed.
  assert.equal(testedAs(c, CODE.replace('none', 'block')), 'open-page');
});

test('run_script alone is "open page"; nothing run is untested and the card says nothing', () => {
  assert.equal(testedAs(ctx({ testedSinceProposal: true }), CODE), 'open-page');
  assert.equal(testedAs(ctx(), CODE), undefined);
  assert.equal(testedNote(ctx(), CODE), '');
});

test('the gate is no stricter than before: any successful run passes, untested_reason still bypasses', () => {
  // A run_script of unrelated code still lets the proposal through; the card tells the truth instead.
  assert.equal(checkProposal({ code: CODE, matches: ['*://*.example.com/*'] }, ctx({ testedSinceProposal: true })), null);
  // The scripted smoke conversations: no run at all, untested_reason given. Unchanged.
  assert.equal(checkProposal({ code: CODE, matches: ['*://*.example.com/*'], untestedReason: 'chrome.userScripts is unavailable' }, ctx()), null);
  // Nothing run and no reason: refused, and pointed at test_mod.
  assert.match(checkProposal({ code: CODE, matches: ['*://*.example.com/*'] }, ctx()) ?? '', /test_mod/);
  // The other guardrails still hold after a fresh-load test.
  const tested = ctx({ testedSinceProposal: true, lastTest: { key: sourceKey('eval("1")'), fresh: true, ok: true } });
  assert.match(checkProposal({ code: 'eval("1")', matches: ['*://*.example.com/*'] }, tested) ?? '', /eval/);
  assert.match(checkProposal({ code: CODE, matches: ['<all_urls>'] }, tested) ?? '', /every site/);
});

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

const ok = (over: Partial<TestModResult> = {}): TestModResult => ({
  fresh: true,
  runAt: 'document_idle',
  world: 'USER_SCRIPT',
  requires: 0,
  run: { outcome: { kind: 'ok', returnedValue: false, dom: { added: 1, removed: 0, attributes: 0 } }, logs: [] },
  ...over,
});

test('a fresh-load run says how faithful it was, then run_script\'s own report, then the re-check', () => {
  const r = renderTestResult(ok({ requires: 2, persisted: { changes: 1, undone: 0, examples: [] } }));
  assert.equal(r.isError, false);
  const lines = r.text.split('\n');
  assert.equal(lines[0], 'Ran as the saved mod: tab reloaded, script ran at document_idle in the USER_SCRIPT world with 2 @require files.');
  assert.match(lines[1]!, /^Completed\. No return value\. DOM: 0 removed, 1 added/);
  assert.equal(lines[2], '2s later: all 1 change still in place.');
});

test('without reload the result says plainly that the page was already loaded', () => {
  const r = renderTestResult(ok({ fresh: false }));
  assert.match(r.text, /^Ran as the saved mod on the already-loaded page \(no reload\)/);
  assert.match(r.text, /document_idle on a fresh load was not exercised/);
});

test('a page that put the change back is named, with the fix', () => {
  const r = renderTestResult(ok({ persisted: { changes: 3, undone: 2, examples: ['div#modal is back', 'style on body was reset'] } }));
  assert.match(r.text, /2s later: the page had undone 2 of 3 changes \(div#modal is back; style on body was reset\)\. Re-apply them/);
  assert.equal(r.isError, false, 'it ran; the model decides what to do about the page');
});

test('a throw at load is an error, carries the mapped line, and has no re-check', () => {
  const r = renderTestResult(ok({ run: { outcome: { kind: 'threw', error: 'ReferenceError: GM_addStyle is not defined\n    at <anonymous>:3:1' }, logs: ['warn: before'] } }));
  assert.equal(r.isError, true);
  assert.match(r.text, /Error: ReferenceError: GM_addStyle is not defined\n {4}at <anonymous>:3:1/);
  assert.match(r.text, /Console:\nwarn: before/);
  assert.doesNotMatch(r.text, /2s later/);
});

test('notes and a failed re-check are said, not hidden', () => {
  const r = renderTestResult(ok({ notes: ['Note: the draft\'s @match does not cover this page.'], persisted: null }));
  assert.match(r.text, /\nNote: the draft's @match does not cover this page\.\n/);
  assert.match(r.text, /2s later: could not re-check the page\./);
  assert.match(renderTestResult(ok({ persisted: { changes: 0, undone: 0, examples: [] } })).text, /nothing to re-check/);
});

// ---------------------------------------------------------------------------
// The cleanup rule and the one-shot guard
// ---------------------------------------------------------------------------

test('only reserved ids are ever swept, and a running test is spared', () => {
  const saved = '0b7c8f0e-4a3b-4c1d-9e2f-111111111111';
  const leaked = testRunId('dead');
  const leakedRelay = `${testRunId('dead')}.relay`;
  const running = testRunId('live');
  assert.ok(isTestRunId(leaked) && isTestRunId(leakedRelay));
  assert.ok(!isTestRunId(saved), 'a saved mod id (a UUID) is never reserved');
  assert.deepEqual(testRunsToSweep([saved, leaked, leakedRelay, running]), [leaked, leakedRelay, running], 'at worker start nothing is running');
  assert.deepEqual(testRunsToSweep([saved, leaked, running], new Set([running])), [leaked]);
  assert.ok(TEST_RUN_PREFIX.endsWith('.'), 'the prefix cannot be a UUID prefix');
});

/** Run guarded code in a sandbox with its own sessionStorage and clock. */
function sandbox(now: number) {
  const store = new Map<string, string>();
  const ran: string[] = [];
  const context = vm.createContext({
    ran,
    Date: { now: () => now },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return { store, ran, run: (code: string) => vm.runInContext(code, context) };
}

test('a registered test runs once, in the marked tab, before it expires, and never otherwise', () => {
  const body = `ran.push('mod')`;
  const guarded = guardOnce(body, 'run-1', 1_000);

  const unmarked = sandbox(0);
  unmarked.run(guarded);
  assert.deepEqual(unmarked.ran, [], 'another tab (no marker) runs nothing: a leaked registration is inert');

  const tab = sandbox(0);
  tab.run(markerCode('run-1'));
  assert.equal(tab.store.get(TEST_MARKER_KEY), 'run-1');
  tab.run(guarded);
  tab.run(guarded);
  assert.deepEqual(tab.ran, ['mod'], 'once: the marker is consumed by the first run');
  assert.equal(tab.store.has(TEST_MARKER_KEY), false);

  const late = sandbox(5_000);
  late.run(markerCode('run-1'));
  late.run(guarded);
  assert.deepEqual(late.ran, [], 'after expiresAt it refuses even in the marked tab');

  const other = sandbox(0);
  other.run(markerCode('run-2'));
  other.run(guarded);
  assert.deepEqual(other.ran, [], 'a different run\'s marker does not unlock this one');
  other.run(unmarkerCode('run-1'));
  assert.equal(other.store.get(TEST_MARKER_KEY), 'run-2', 'disarming one run never clears another\'s marker');
  other.run(unmarkerCode('run-2'));
  assert.equal(other.store.has(TEST_MARKER_KEY), false);
});

test('the guard adds no line before the code, so stack lines still map', () => {
  assert.equal(guardOnce('X', 'r', 1).split('\n')[0]!.endsWith('X'), true);
  assert.equal(inPageWorld('X', 'r').split('\n')[0]!.endsWith('X'), true);
});

// ---------------------------------------------------------------------------
// Where the saved mod would run
// ---------------------------------------------------------------------------

const reach = (matches: string[], excludeMatches: string[] = []) => ({ matches, excludeMatches, includeGlobs: [], excludeGlobs: [] });

test('each engine answers with its own matcher: Chrome lets *.host cover the bare host', () => {
  const site = reach(['*://*.example.com/*']);
  assert.equal(engineRunsModOn(site, 'https://example.com/a', 'user-scripts'), true, 'Chrome: *.example.com covers example.com');
  assert.equal(engineRunsModOn(site, 'https://example.com/a', 'content-script'), false, 'the content-script engine matches with modMatchesUrl, which does not');
  assert.equal(engineRunsModOn(site, 'https://www.example.com/a', 'content-script'), true);
  assert.equal(engineRunsModOn(reach(['*://*.wikipedia.org/wiki/*']), 'https://en.wikipedia.org/w/index.php', 'user-scripts'), false, 'the path still has to match');
  assert.equal(engineRunsModOn(reach(['*://*.example.com/*'], ['*://*.example.com/admin/*']), 'https://example.com/admin/x', 'user-scripts'), false, 'an @exclude covers the bare host too');
});

test('a draft that does not cover the page is tested under patterns that do, on either engine', () => {
  assert.deepEqual(patternsForPage('https://www.example.com/x', 'user-scripts'), ['*://*.example.com/*', '*://www.example.com/*']);
  assert.deepEqual(patternsForPage('https://example.com/x', 'content-script'), ['*://*.example.com/*', '*://example.com/*']);
  // Chrome refuses a port in a registered pattern ("Invalid port"), found by the real-browser probe.
  assert.deepEqual(patternsForPage('http://127.0.0.1:8823/nag', 'user-scripts'), ['*://*.127.0.0.1/*', '*://127.0.0.1/*']);
  assert.deepEqual(patternsForPage('http://127.0.0.1:8823/nag', 'content-script'), ['*://*.127.0.0.1/*', '*://127.0.0.1:8823/*']);
  for (const url of ['https://example.com/x', 'https://www.example.com/x', 'http://localhost:8080/y', 'http://127.0.0.1:8823/nag']) {
    for (const engine of ['user-scripts', 'content-script'] as const) assert.ok(engineRunsModOn(reach(patternsForPage(url, engine)), url, engine), `${engine} ${url}`);
  }
  assert.ok(engineRunsModOn(reach(['*://*.example.com/*']), 'http://example.com:8080/', 'user-scripts'), 'Chrome: no port in the pattern matches any port');
});

// ---------------------------------------------------------------------------
// Composition and line mapping
// ---------------------------------------------------------------------------

test('a throw on line N of the body maps back to line N through shim, recorder and wrapper', () => {
  const body = `const a = 1;\nconst b = 2;\nnope();`;
  // Shaped like buildRegisteredCode: shim lines, an @require unit, then the source (header + body).
  const registered = `(function () {\nconst shim = 1;\n__evaluate('@require x', function () {\nconst lib = 1;\n})();\n__evaluate('script', function () {\n// ==UserScript==\n// @name T\n// ==/UserScript==\n\n${body}\n})();\n})();`;
  for (const world of ['USER_SCRIPT', 'MAIN'] as const) {
    const c = composeTest(registered, body, 'run-9', 'chrome', world);
    const lines = c.code.split('\n');
    const at = lines.findIndex((l) => l.includes('nope();')) + 1;
    assert.equal(at - c.lineOffset, 3, `${world}: the third body line`);
    assert.equal(c.bodyLines, 3);
  }
});

test('a page-world run reports over a DOM event whatever the engine, and the relay forwards it', () => {
  const main = composeTest('(function(){})();', 'x', 'run-7', 'chrome', 'MAIN').code;
  assert.match(main, /__usermodsReport\(\{ type: 'usermods:run-result'/, 'the bridge transport, not chrome.runtime');
  assert.match(main, /new CustomEvent\("usermods-run-run-7"/);
  const isolated = composeTest('(function(){})();', 'x', 'run-7', 'chrome', 'USER_SCRIPT').code;
  assert.match(isolated, /chrome\.runtime\.sendMessage\(\{ type: 'usermods:run-result'/);

  // The relay, run for real against a fake document: the page-world event reaches the engine's sender.
  const sent: unknown[] = [];
  let listener: ((e: { detail: string }) => void) | null = null;
  const context = vm.createContext({
    document: { addEventListener: (_n: string, fn: (e: { detail: string }) => void) => void (listener = fn) },
    chrome: { runtime: { sendMessage: (m: unknown) => void sent.push(m) } },
    __usermodsReport: (m: unknown) => void sent.push({ bridged: m }),
  });
  vm.runInContext(relayCode('run-7', 'chrome'), context);
  listener!({ detail: JSON.stringify({ type: 'usermods:run-result', runId: 'run-7', ok: true }) });
  vm.runInContext(relayCode('run-7', 'bridge'), context);
  listener!({ detail: JSON.stringify({ runId: 'run-7' }) });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'usermods:run-result', runId: 'run-7', ok: true }, { bridged: { runId: 'run-7' } }]);
});

// ---------------------------------------------------------------------------
// Through the loop
// ---------------------------------------------------------------------------


const SETTINGS = { provider: 'openai-compatible', baseUrl: 'http://unused.invalid/v1', apiKey: '', model: 'fake' } as Settings;
const toolCall = (id: string, name: string, input: Record<string, unknown>): Part => ({ type: 'tool_call', id, name, input });
const step = (calls: Part[]): ProviderResponse => ({ content: calls, stopReason: calls.length ? 'tool_use' : 'end_turn' });

function loopHarness(replies: ProviderResponse[], testResult: TestModResult | null) {
  const tests: Array<{ code: string; reload: boolean }> = [];
  const provider: Provider = {
    async chat() {
      const r = replies.shift();
      if (!r) throw new Error('out of replies');
      return r;
    },
  };
  const env: AgentEnv = {
    sendToContent: async <T>() => ({ text: '' }) as T,
    runScript: async () => ({ outcome: { kind: 'ok', returnedValue: false }, logs: [] }),
    screenshot: async () => ({ mediaType: 'image/png', data: '' }),
    pageInfo: async () => ({ url: 'https://example.com/', title: 'Example' }),
    wait: async () => ({ met: true, elapsedMs: 0 }) as never,
    ...(testResult
      ? {
          testMod: async (code: string, reload: boolean) => {
            tests.push({ code, reload });
            return testResult;
          },
        }
      : {}),
  };
  const events: AgentEventBody[] = [];
  return { provider, env, events, tests };
}

const propose = (code: string) => toolCall('p1', 'propose_mod', { name: 'No ads', description: 'Hides ads.', matches: ['*://*.example.com/*'], code });

test('test_mod with reload, then propose_mod of the same code: the card says fresh load', async () => {
  const h = loopHarness([step([toolCall('t1', 'test_mod', { code: CODE, reload: true })]), step([propose(CODE)])], ok());
  const out = await runAgent({ settings: SETTINGS, history: [], turn: { id: 'u', text: 'hide the ads' }, pullQueued: () => [], env: h.env, emit: (e) => h.events.push(e), signal: new AbortController().signal, provider: h.provider });
  assert.deepEqual(h.tests, [{ code: CODE, reload: true }]);
  const proposal = h.events.find((e): e is Extract<AgentEventBody, { type: 'proposal' }> => e.type === 'proposal')?.proposal as ModProposal;
  assert.equal(proposal.tested, 'fresh-load');
  const results = out.messages.flatMap((m) => m.content).filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');
  const proposeResult = results.at(-1)!.content[0] as { text: string };
  assert.match(proposeResult.text, /tested as the saved mod on a fresh load/);
});

test('a test_mod that throws at load leaves propose refused unless something else ran', async () => {
  const threw = ok({ run: { outcome: { kind: 'threw', error: 'TypeError: x is null' }, logs: [] } });
  const h = loopHarness([step([toolCall('t1', 'test_mod', { code: CODE, reload: true })]), step([propose(CODE)]), step([])], threw);
  const out = await runAgent({ settings: SETTINGS, history: [], turn: { id: 'u', text: 'hide the ads' }, pullQueued: () => [], env: h.env, emit: (e) => h.events.push(e), signal: new AbortController().signal, provider: h.provider });
  const results = out.messages.flatMap((m) => m.content).filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');
  assert.equal(results[0]!.isError, true);
  assert.match((results[0]!.content[0] as { text: string }).text, /Error: TypeError: x is null/);
  assert.equal(results[1]!.isError, true, 'the failed test does not satisfy the gate');
  assert.ok(!h.events.some((e) => e.type === 'proposal'));
});

test('run_script worked but test_mod of the proposed code threw: proposed, and the card says it failed', async () => {
  const threw = ok({ run: { outcome: { kind: 'threw', error: 'TypeError: x is null' }, logs: [] } });
  const h = loopHarness([step([toolCall('r1', 'run_script', { code: CODE })]), step([toolCall('t1', 'test_mod', { code: CODE, reload: true })]), step([propose(CODE)]), step([])], threw);
  const out = await runAgent({ settings: SETTINGS, history: [], turn: { id: 'u', text: 'hide the ads' }, pullQueued: () => [], env: h.env, emit: (e) => h.events.push(e), signal: new AbortController().signal, provider: h.provider });
  const proposal = h.events.find((e): e is Extract<AgentEventBody, { type: 'proposal' }> => e.type === 'proposal')?.proposal as ModProposal;
  assert.equal(proposal.tested, 'mod-failed');
  const results = out.messages.flatMap((m) => m.content).filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');
  assert.match((results[2]!.content[0] as { text: string }).text, /failed when test_mod ran it as the saved mod/);
});

test('without a testMod in the environment the tool says so instead of pretending', async () => {
  const h = loopHarness([step([toolCall('t1', 'test_mod', { code: CODE })]), step([])], null);
  const out = await runAgent({ settings: SETTINGS, history: [], turn: { id: 'u', text: 'hide the ads' }, pullQueued: () => [], env: h.env, emit: (e) => h.events.push(e), signal: new AbortController().signal, provider: h.provider });
  const r = out.messages.flatMap((m) => m.content).find((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result')!;
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /not available/);
});

test('a resumed run remembers the test_mod the dead run made', async () => {
  // The previous run tested with reload and died before proposing.
  const history: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'hide the ads' }] },
    { role: 'assistant', content: [toolCall('t1', 'test_mod', { code: CODE, reload: true })] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: [{ type: 'text', text: 'Ran as the saved mod…' }] }] },
  ];
  const h = loopHarness([step([propose(CODE)])], ok());
  await runAgent({ settings: SETTINGS, history, turn: null, pullQueued: () => [], env: h.env, emit: (e) => h.events.push(e), signal: new AbortController().signal, provider: h.provider });
  const proposal = h.events.find((e): e is Extract<AgentEventBody, { type: 'proposal' }> => e.type === 'proposal')?.proposal as ModProposal;
  assert.equal(proposal.tested, 'fresh-load');
});
