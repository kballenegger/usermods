// run_script's source transform and result rendering.
//
// The smoke run leaves Chrome's "Allow User Scripts" toggle off, so chrome.userScripts is not there
// and none of this is exercised by it (scripts/reviewer-walkthrough.mjs does turn the toggle on,
// for one conversation). Keeping the whole decision in pure functions is what makes every case of
// it testable.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeCallbackError,
  formatDomEffect,
  mapStack,
  mergeLateErrors,
  parseError,
  prepareRunScript,
  renderLateErrors,
  renderRunResult,
  type RunSource,
} from '../lib/runscript.ts';

/** The transformed code, or the failure message, as one string — convenient for assertions. */
function prep(code: string): string {
  const r = prepareRunScript(code);
  return r.ok ? r.code : `ERROR: ${r.message}`;
}

// ---------- the last expression becomes the return value ----------

test('a bare expression is returned', () => {
  assert.equal(prep('1 + 1'), 'return 1 + 1;');
  const r = prepareRunScript('1 + 1');
  assert.equal(r.ok && r.rewritten, true);
});

test('an expression after other statements is returned, and the statements are untouched', () => {
  assert.equal(
    prep('const els = document.querySelectorAll(".ad");\nels.length'),
    'const els = document.querySelectorAll(".ad");\nreturn els.length;',
  );
});

test('a mutation-only call is still returned, so its value (undefined) is honest rather than ambiguous', () => {
  assert.equal(
    prep('document.querySelectorAll(".ad").forEach(e => e.remove())'),
    'return document.querySelectorAll(".ad").forEach(e => e.remove());',
  );
});

test('a trailing semicolon is not doubled', () => {
  assert.equal(prep('1 + 1;'), 'return 1 + 1;');
  assert.equal(prep('foo();'), 'return foo();');
});

test('a trailing comment survives and stays after the inserted return', () => {
  assert.equal(prep('1 + 1 // the answer'), 'return 1 + 1; // the answer');
  assert.equal(prep('foo();\n// done'), 'return foo();\n// done');
});

test('an explicit return is left exactly as written', () => {
  const code = 'const n = 2;\nreturn n * 3;';
  assert.equal(prep(code), code);
  const r = prepareRunScript(code);
  assert.equal(r.ok && r.rewritten, false);
});

test('an explicit return in the middle keeps working and the trailing expression is still rewritten', () => {
  assert.equal(
    prep('if (!document.body) return "no body";\ndocument.title'),
    'if (!document.body) return "no body";\nreturn document.title;',
  );
});

test('top-level await parses, and an awaited expression last is returned', () => {
  assert.equal(prep('await fetch("/x")'), 'return await fetch("/x");');
  assert.equal(
    prep('const r = await fetch("/x");\nawait r.text()'),
    'const r = await fetch("/x");\nreturn await r.text();',
  );
});

test('a declaration last is left alone — there is no completion value to return', () => {
  const decl = 'const style = document.createElement("style");\nconst n = 1;';
  assert.equal(prep(decl), decl);
  assert.equal(prepareRunScript(decl).ok && (prepareRunScript(decl) as { rewritten: boolean }).rewritten, false);
  const fn = 'function drop() { document.querySelector(".ad")?.remove(); }\ndrop();';
  assert.equal(prep(fn), 'function drop() { document.querySelector(".ad")?.remove(); }\nreturn drop();');
});

test('a loop or if last is left alone', () => {
  const loop = 'let n = 0;\nfor (const el of document.querySelectorAll("p")) { n++; }';
  assert.equal(prep(loop), loop);
});

test('an object literal last is returned as an expression, not read as a block', () => {
  // `{ a: 1 }` alone is a block with a label, so acorn does not see an ExpressionStatement and we
  // must not rewrite it; parenthesised it is an expression and we must.
  assert.equal(prep('({ removed: 3, kept: 1 })'), 'return ({ removed: 3, kept: 1 });');
  assert.equal(prep('const out = { a: 1 };\nout'), 'const out = { a: 1 };\nreturn out;');
});

test('a template literal containing the word return is not confused for one', () => {
  const code = 'const msg = `press return to continue`;\nmsg';
  assert.equal(prep(code), 'const msg = `press return to continue`;\nreturn msg;');
  // And a template literal as the last expression is itself returned.
  assert.equal(prep('`removed ${n} nodes; return value below`'), 'return `removed ${n} nodes; return value below`;');
});

test('a syntax error is reported with line and column, and nothing is injected', () => {
  const r = prepareRunScript('const a = ;\nfoo()');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.line, 1);
  assert.match(r.message, /^Syntax error at line 1, column \d+: /);
  // Acorn's own "(1:10)" suffix is stripped, because we state the position ourselves.
  assert.doesNotMatch(r.message, /\(\d+:\d+\)/);
});

test('a syntax error on a later line reports that line', () => {
  const r = prepareRunScript('const a = 1;\nconst b = 2;\nfunction (');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.line, 3);
});

test('parseError is null for code that parses and mirrors prepareRunScript otherwise', () => {
  assert.equal(parseError('document.title'), null);
  assert.equal(parseError('return 1;'), null);
  assert.equal(parseError('const a = ;')?.line, 1);
});

// ---------- rendering the outcome ----------

test('a run with no return value says so, rather than "Result: undefined"', () => {
  const r = renderRunResult({ outcome: { kind: 'ok', returnedValue: false, dom: { added: 0, removed: 14, attributes: 2 } }, logs: [] });
  assert.equal(r.isError, false);
  assert.equal(r.text, 'Completed. No return value. DOM: 14 removed, 0 added, 2 attributes changed.');
  assert.doesNotMatch(r.text, /undefined/);
});

test('a run that changed nothing at all says that too', () => {
  const r = renderRunResult({ outcome: { kind: 'ok', returnedValue: false, dom: { added: 0, removed: 0, attributes: 0 } }, logs: [] });
  assert.equal(r.text, 'Completed. No return value. DOM: nothing changed.');
});

test('a returned value is reported as before, with the DOM summary appended when there is one', () => {
  assert.equal(
    renderRunResult({ outcome: { kind: 'ok', returnedValue: true, result: '3', dom: { added: 0, removed: 3, attributes: 0 } }, logs: [] }).text,
    'Result: 3 DOM: 3 removed, 0 added, 0 attributes changed.',
  );
  assert.equal(
    renderRunResult({ outcome: { kind: 'ok', returnedValue: true, result: '3', dom: { added: 0, removed: 0, attributes: 0 } }, logs: [] }).text,
    'Result: 3',
  );
});

test('a navigation is named as one and is not an error the model should retry', () => {
  const r = renderRunResult({ outcome: { kind: 'navigated', url: 'https://example.com/next' }, logs: [] });
  assert.equal(r.isError, false);
  assert.match(r.text, /navigated to https:\/\/example\.com\/next/);
  assert.match(r.text, /result was lost/);
  assert.doesNotMatch(r.text, /Timed out|timed out/);
});

test('an injection failure says nothing ran, and includes the reason', () => {
  const r = renderRunResult({ outcome: { kind: 'injection-failed', reason: 'Cannot access a chrome:// URL' }, logs: [] });
  assert.equal(r.isError, true);
  assert.match(r.text, /nothing ran/);
  assert.match(r.text, /chrome:\/\/ URL/);
});

test('a genuine timeout is distinguishable from all three of the above', () => {
  const r = renderRunResult({ outcome: { kind: 'timeout', seconds: 20 }, logs: [] });
  assert.equal(r.isError, true);
  assert.match(r.text, /No result after 20s/);
  assert.match(r.text, /may still be running/);
});

test('console output rides along with every outcome', () => {
  const r = renderRunResult({ outcome: { kind: 'ok', returnedValue: false }, logs: ['hello', 'warn: careful'] });
  assert.match(r.text, /Console:\nhello\nwarn: careful/);
});

test('formatDomEffect is null when nothing moved, so the caller can say so its own way', () => {
  assert.equal(formatDomEffect(undefined), null);
  assert.equal(formatDomEffect({ added: 0, removed: 0, attributes: 0 }), null);
  assert.equal(formatDomEffect({ added: 1, removed: 0, attributes: 1 }), '0 removed, 1 added, 1 attribute changed');
});

// ---------- stack mapping ----------

test('a thrown stack is trimmed to the user code frames and its lines are mapped back', () => {
  // The wrapper's preamble is 14 lines, so the user's line 2 lands on injected line 16.
  const stack = [
    'TypeError: Cannot read properties of null',
    '    at <anonymous>:16:12',
    '    at <anonymous>:3:5',
    '    at async <anonymous>:40:9',
  ].join('\n');
  const mapped = mapStack(stack, 14, 5);
  assert.match(mapped, /TypeError: Cannot read properties of null/);
  assert.match(mapped, /:2:12/);
  // The wrapper's own frames (before the code, and in the epilogue) are gone.
  assert.doesNotMatch(mapped, /:3:5/);
  assert.doesNotMatch(mapped, /:40:9/);
});

test('a stack with no recognizable frames is returned as-is', () => {
  assert.equal(mapStack('Error: boom', 14, 5), 'Error: boom');
});

// ---------- naming what changed ----------

test('the DOM summary names the nodes it counted, most frequent first, collapsing repeats', () => {
  const text = formatDomEffect({
    added: 1,
    removed: 2,
    attributes: 2,
    targets: {
      added: [['div.modal', 1]],
      removed: [['div.modal-backdrop', 1], ['div#newsletter', 1]],
      attributes: [['body', ['class', 'style'], 2]],
    },
  });
  assert.equal(text, '2 removed (div.modal-backdrop, div#newsletter), 1 added (div.modal), 2 attributes changed (body[class,style])');
  const many = formatDomEffect({
    added: 0,
    removed: 60,
    attributes: 0,
    targets: { added: [], removed: [['a', 1], ['li.ad', 40], ['b', 1], ['c', 1], ['d', 1], ['e', 1], ['f', 15]], attributes: [] },
    // 60 nodes, 7 names: the top five cover 58 of them.
  });
  assert.equal(many, '60 removed (li.ad ×40, f ×15, a, b, c, +2 more), 0 added, 0 attributes changed');
});

test('+N more stays true when the page stopped tallying names', () => {
  // 20 names tallied, but 500 nodes removed: the rest are counted and not named.
  const removed = Array.from({ length: 20 }, (_, i) => [`div.n${i}`, 1] as [string, number]);
  const text = formatDomEffect({ added: 0, removed: 500, attributes: 0, targets: { added: [], removed, attributes: [] } });
  assert.equal(text, '500 removed (div.n0, div.n1, div.n2, div.n3, div.n4, +495 more), 0 added, 0 attributes changed');
});

test('the named summary adds nothing when nothing changed', () => {
  const r = renderRunResult({ outcome: { kind: 'ok', returnedValue: true, result: '3', dom: { added: 0, removed: 0, attributes: 0 } }, logs: [], callbackErrors: [] });
  assert.equal(r.text, 'Result: 3');
});

// ---------- callback errors ----------

const SRC: RunSource = { sourceName: 'usermods-run-abc.js', lineOffset: 14, codeLines: 20 };

test('a callback error is described with the line the model wrote', () => {
  const chrome = describeCallbackError(
    { message: 'TypeError: x is null', stack: 'TypeError: x is null\n    at MutationObserver.<anonymous> (usermods-run-abc.js:26:9)', count: 3 },
    SRC,
  );
  assert.deepEqual(chrome, { text: 'TypeError: x is null (line 12)', count: 3 });
  // Safari's frame format, and a wrapper frame (outside the model's lines) skipped for the next one.
  const safari = describeCallbackError({ message: 'Error: y', stack: '@usermods-run-abc.js:90:1\nf@usermods-run-abc.js:16:4' }, SRC);
  assert.deepEqual(safari, { text: 'Error: y (line 2)', count: 1 });
  // No usable frame: the message alone, never a guessed line.
  assert.deepEqual(describeCallbackError({ message: 'Error: z', stack: 'Error: z\n    at other.js:3:1' }, SRC), { text: 'Error: z', count: 1 });
  assert.deepEqual(describeCallbackError({}, SRC), { text: 'Uncaught error', count: 1 });
});

test('callback errors from the run itself are listed under its result', () => {
  const r = renderRunResult({
    outcome: { kind: 'ok', returnedValue: true, result: '"armed"' },
    logs: [],
    callbackErrors: [
      { text: 'TypeError: x is null (line 12)', count: 40 },
      { text: 'Error: a', count: 1 },
      { text: 'Error: b', count: 1 },
      { text: 'Error: c', count: 1 },
    ],
  });
  assert.equal(r.text, 'Result: "armed"\nUncaught in its callbacks: TypeError: x is null (line 12) ×40; Error: a; Error: b; +1 more');
  assert.equal(r.isError, false);
});

test('dropped console lines are counted', () => {
  const logs = Array.from({ length: 50 }, (_, i) => `l${i}`);
  const r = renderRunResult({ outcome: { kind: 'ok', returnedValue: false }, logs, logCount: 312 });
  assert.match(r.text, /\nConsole \(last 50 of 312 lines\):\nl0\n/);
  const few = renderRunResult({ outcome: { kind: 'ok', returnedValue: false }, logs: ['a'], logCount: 1 });
  assert.match(few.text, /\nConsole:\na$/);
});

// ---------- late errors ----------

test('late errors merge by run and message, the running count replacing the old one, capped at five', () => {
  let buf = mergeLateErrors([], 'r1', [{ text: 'TypeError: x (line 2)', count: 1 }]);
  buf = mergeLateErrors(buf, 'r1', [{ text: 'TypeError: x (line 2)', count: 7 }]);
  assert.deepEqual(buf, [{ runId: 'r1', text: 'TypeError: x (line 2)', count: 7 }]);
  // The same text from another run is another error: its line is in other code.
  buf = mergeLateErrors(buf, 'r2', [{ text: 'TypeError: x (line 2)', count: 1 }]);
  assert.equal(buf.length, 2);
  for (let i = 0; i < 10; i++) buf = mergeLateErrors(buf, 'r2', [{ text: `E${i}`, count: 1 }]);
  assert.equal(buf.length, 5);
});

test('the late line names the latest run\'s errors plainly and an earlier run\'s as such', () => {
  assert.equal(renderLateErrors([], 'r1'), null);
  assert.equal(
    renderLateErrors([{ runId: 'r2', text: 'TypeError: x is null (line 12)', count: 1 }], 'r2'),
    '[Uncaught in your run_script callbacks since the last result: TypeError: x is null (line 12)]',
  );
  assert.equal(
    renderLateErrors(
      [
        { runId: 'r2', text: 'TypeError: x is null (line 12)', count: 3 },
        { runId: 'r1', text: 'Error: old (line 4)', count: 1 },
      ],
      'r2',
    ),
    '[Uncaught in your run_script callbacks since the last result: TypeError: x is null (line 12) ×3; Error: old (line 4) [earlier run]]',
  );
});
