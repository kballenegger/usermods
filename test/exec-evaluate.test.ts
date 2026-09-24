// Evaluating a mod under the content-script engine, and detecting a page that refused.
//
// The CSP behaviour is the part worth pinning: a blocked inline script does not throw and does not
// report, so the only thing separating "ran" from "silently skipped" is the sentinel. A fake document
// stands in for both outcomes.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPageInjection, evalAllowed, evaluateIsolated, injectIntoPage, sentinelAttribute, type InjectDoc } from '../lib/exec/evaluate.ts';

/**
 * A document that runs, or refuses to run, an appended inline script.
 *
 * Without `csp`, an appended script really executes: its text runs with this fake as `document`.
 * As in a browser, an exception inside the script does not escape appendChild; it is recorded in
 * `errors` instead. `csp: true` models the real refusal precisely: appendChild succeeds, nothing
 * throws, and the script's own statements never execute, so the attribute the script would have
 * set is absent.
 */
function fakeDoc(opts: { csp?: boolean } = {}): InjectDoc & { ran: string[]; errors: string[]; attrs: Map<string, string>; removed: number } {
  const attrs = new Map<string, string>();
  const ran: string[] = [];
  const errors: string[] = [];
  let removed = 0;
  const documentElement = {
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    hasAttribute: (n: string) => attrs.has(n),
    removeAttribute: (n: string) => void attrs.delete(n),
    appendChild: (node: unknown) => {
      const el = node as { textContent: string };
      if (!opts.csp) {
        ran.push(el.textContent);
        try {
          new Function('document', el.textContent)(doc);
        } catch (e) {
          errors.push(String((e as Error)?.message ?? e));
        }
      }
      return node;
    },
  };
  const doc = {
    documentElement,
    head: null,
    createElement: () => ({ textContent: '', remove: () => void removed++ }),
    get ran() {
      return ran;
    },
    errors,
    attrs,
    get removed() {
      return removed;
    },
  };
  return doc;
}

test('isolated evaluation gets the bridge and the reporter, and chrome by neither name', () => {
  const calls: string[] = [];
  const bridge = { send: (x: unknown) => calls.push(`bridge:${String(x)}`) };
  const out = evaluateIsolated(
    `__usermodsBridge.send('hi'); return [typeof chrome, typeof browser].join(',');`,
    { bridge, report: () => {} },
  );
  assert.equal(out, 'undefined,undefined');
  assert.deepEqual(calls, ['bridge:hi']);
});

test('the reporter is how a one-off run answers when chrome is out of reach', () => {
  const seen: unknown[] = [];
  evaluateIsolated(`__usermodsReport({ ok: true });`, { bridge: {}, report: (o) => seen.push(o) });
  assert.deepEqual(seen, [{ ok: true }]);
});

test('evalAllowed reports what the document actually permits', () => {
  assert.equal(evalAllowed(), true);
  const refusing = (() => {
    throw new Error('Refused to evaluate a string as JavaScript');
  }) as unknown as Parameters<typeof evalAllowed>[0];
  assert.equal(evalAllowed(refusing), false);
});

test('the sentinel is set before the mod, so a mod that throws still counts as having run', () => {
  const doc = fakeDoc();
  doc.documentElement.appendChild({ textContent: buildPageInjection('throw new Error("boom")', 'abc') });
  assert.deepEqual(doc.errors, ['boom'], 'the mod really ran and threw');
  assert.equal(doc.attrs.has(sentinelAttribute('abc')), true, 'the sentinel must come first');
  // Otherwise every mod with a bug would be reported as a CSP block, which is a different fix.
  assert.equal(injectIntoPage('throw new Error("boom")', 'n2', fakeDoc()), true);
});

test('a sentinel that cannot be set does not stop the mod from running', () => {
  // A document with no documentElement makes the sentinel line throw. It is guarded, so the mod's
  // own code still runs after it.
  let ran = false;
  new Function('document', 'mark', buildPageInjection('mark()', 'abc'))({}, () => (ran = true));
  assert.equal(ran, true);
});

test('a page that runs the script reports true, and the script does not stay in the DOM', () => {
  const doc = fakeDoc();
  assert.equal(injectIntoPage('let x = 1', 'n1', doc), true);
  assert.deepEqual(doc.errors, [], 'and the mod itself ran cleanly');
  assert.equal(doc.removed, 1);
  // The sentinel is cleaned up, so the next injection starts from a known state.
  assert.equal(doc.attrs.has(sentinelAttribute('n1')), false);
});

test('a page that refuses the script reports false rather than appearing to succeed', () => {
  const doc = fakeDoc({ csp: true });
  assert.equal(injectIntoPage('let x = 1', 'n1', doc), false);
  assert.deepEqual(doc.ran, []);
  // And the element is still removed, so a refused injection leaves no trace either.
  assert.equal(doc.removed, 1);
});

test('each injection gets its own attribute, so one refusal cannot read as another success', () => {
  assert.notEqual(sentinelAttribute('a'), sentinelAttribute('b'));
  assert.match(sentinelAttribute('a1b2'), /^data-usermods-ran-a1b2$/);
});
