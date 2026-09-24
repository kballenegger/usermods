// How a one-off run (the Try button, and the agent's run_script tool) reports its result on each
// engine. Everything else the wrapper does (the console capture, the DOM
// counts, the line offset) is unchanged from what shipped and covered by test/runscript.test.ts.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapForExecution } from '../lib/exec/wrap.ts';

/**
 * Run the wrapped code for real, with a fake chrome.runtime and a fake __usermodsReport, and return
 * every message each transport received. Node has no document, MutationObserver or
 * requestAnimationFrame; the wrapper already guards each of those, so the run completes here too.
 */
async function run(code: string, runId: string, transport?: 'chrome' | 'bridge') {
  const viaChrome: unknown[] = [];
  const viaBridge: unknown[] = [];
  const chrome = { runtime: { sendMessage: (m: unknown) => void viaChrome.push(m) } };
  const report = (m: unknown) => void viaBridge.push(m);
  const { wrapped } = wrapForExecution(code, runId, transport);
  await new Function('chrome', '__usermodsReport', `return ${wrapped}`)(chrome, report);
  return { viaChrome, viaBridge };
}

/** What a script that returns 1 and touches nothing reports. */
const resultOf = (runId: string) => ({
  type: 'usermods:run-result',
  runId,
  ok: true,
  returnedValue: true,
  result: '1',
  dom: { added: 0, removed: 0, attributes: 0 },
  logs: [],
});

test('the chrome transport reports through chrome.runtime, the bridge through the runner', async () => {
  const chrome = await run('return 1', 'run-1');
  assert.deepEqual(chrome.viaChrome, [resultOf('run-1')]);
  assert.deepEqual(chrome.viaBridge, [], 'the chrome transport must not call the bridge');
  // Safari evaluates the code with chrome shadowed, so the result has to come back through the
  // function the runner passes in. See lib/exec/evaluate.ts.
  const bridge = await run('return 1', 'run-1', 'bridge');
  assert.deepEqual(bridge.viaBridge, [resultOf('run-1')]);
  assert.deepEqual(bridge.viaChrome, [], 'the bridge transport must not call chrome.runtime');
});

test('the line offset is the same on both, so a stack maps the same way', () => {
  // mapStack() subtracts this to report a thrown error at the line the model wrote. If the transport
  // changed it, the same script would blame two different lines on two browsers.
  const a = wrapForExecution('return 1', 'r');
  const b = wrapForExecution('return 1', 'r', 'bridge');
  assert.equal(a.lineOffset, b.lineOffset);
  assert.ok(a.lineOffset > 0);
});

test('a hostile runId arrives intact on both transports instead of breaking the generated code', async () => {
  // JSON.stringify is what keeps this honest; the test is here so it stays that way.
  const hostile = 'r\'"\n`${globalThis}\\';
  const chrome = await run('return 1', hostile, 'chrome');
  assert.deepEqual(chrome.viaChrome, [resultOf(hostile)]);
  const bridge = await run('return 1', hostile, 'bridge');
  assert.deepEqual(bridge.viaBridge, [resultOf(hostile)]);
});
