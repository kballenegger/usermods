// How a one-off run (the Try button, and the agent's run_script tool) reports its result on each
// engine. Everything else the wrapper does (the console capture, the DOM
// counts, the line offset) is unchanged from what shipped and covered by test/runscript.test.ts.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapForExecution } from '../lib/exec/wrap.ts';

test('the chrome transport reports through chrome.runtime, the bridge through the runner', () => {
  const viaChrome = wrapForExecution('return 1', 'run-1');
  const viaBridge = wrapForExecution('return 1', 'run-1', 'bridge');
  assert.match(viaChrome.wrapped, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(viaChrome.wrapped, /__usermodsReport/);
  // Safari evaluates the code with chrome shadowed, so the result has to come back through the
  // function the runner passes in. See lib/exec/evaluate.ts.
  assert.match(viaBridge.wrapped, /__usermodsReport/);
  assert.doesNotMatch(viaBridge.wrapped, /chrome\.runtime\.sendMessage/);
});

test('both transports report the same runId and message type', () => {
  for (const t of ['chrome', 'bridge'] as const) {
    const { wrapped } = wrapForExecution('return 1', 'run-xyz', t);
    assert.match(wrapped, /'usermods:run-result'/);
    assert.match(wrapped, /"run-xyz"/);
  }
});

test('the line offset is the same on both, so a stack maps the same way', () => {
  // mapStack() subtracts this to report a thrown error at the line the model wrote. If the transport
  // changed it, the same script would blame two different lines on two browsers.
  const a = wrapForExecution('return 1', 'r');
  const b = wrapForExecution('return 1', 'r', 'bridge');
  assert.equal(a.lineOffset, b.lineOffset);
  assert.ok(a.lineOffset > 0);
});

test('a runId with a quote in it cannot break out of the generated string', () => {
  const { wrapped } = wrapForExecution('return 1', `r'"\n`, 'bridge');
  // JSON.stringify is what keeps this honest; the test is here so it stays that way.
  assert.match(wrapped, /runId: "r'\\"\\n"/);
});
