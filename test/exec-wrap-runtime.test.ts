// What the run_script wrapper reports, evaluated for real: the generated source runs under node
// against a minimal fake DOM, so the serialiser, the caps, the DOM names and the late-error catcher
// are tested as the page will run them, not as a TypeScript copy of them.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { LOG_KEEP, PAGE_HELPERS, RESULT_CAP, wrapForExecution } from '../lib/exec/wrap.ts';

// ---------- a fake DOM, just enough of one ----------

interface FakeNode {
  nodeType: number;
  nodeName: string;
  localName?: string;
  id?: string;
  className?: string;
  textContent?: string;
  value?: string;
  getAttribute?(name: string): string | null;
}

function el(tag: string, opts: { id?: string; cls?: string; text?: string; attrs?: Record<string, string>; value?: string } = {}): FakeNode {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    localName: tag,
    id: opts.id ?? '',
    className: opts.cls ?? '',
    textContent: opts.text ?? '',
    ...(opts.value !== undefined ? { value: opts.value } : {}),
    getAttribute: (n) => opts.attrs?.[n] ?? (n === 'class' ? opts.cls ?? null : null),
  };
}
const textNode = (t: string): FakeNode => ({ nodeType: 3, nodeName: '#text', textContent: t });

/** A NodeList-alike: indexed, with item() and the tag Object.prototype.toString reads. */
function nodeList(items: FakeNode[]): unknown {
  const list: Record<string | symbol, unknown> = { length: items.length, item: (i: number) => items[i] ?? null, [Symbol.toStringTag]: 'NodeList' };
  items.forEach((n, i) => (list[i] = n));
  return list;
}

const HELPER_NAMES = ['__ser', '__cap', '__capLine', '__describe', '__name', '__fmt', '__num'] as const;
type Helpers = Record<(typeof HELPER_NAMES)[number], (...a: any[]) => any>;

/** PAGE_HELPERS evaluated alone, as a bag of functions. `MutationObserver` etc. are not needed here. */
function helpers(): Helpers {
  const names = HELPER_NAMES;
  return new Function(`${PAGE_HELPERS}\nreturn { ${names.join(', ')} };`)() as Helpers;
}

// ---------- the returned value ----------

test('plain JSON comes out exactly as JSON.stringify wrote it, so a small result is no longer', () => {
  const h = helpers();
  for (const v of [3, 0, -1.5, true, false, null, [1, 2, 3], { removed: 3, kept: 1 }, ['a', 'b'], { a: { b: [1, { c: 'd' }] } }, [], {}]) {
    assert.equal(h.__ser(v), JSON.stringify(v), JSON.stringify(v));
  }
  // Strings were never quoted, and undefined was always the word.
  assert.equal(h.__ser('hello'), 'hello');
  assert.equal(h.__ser(undefined), 'undefined');
});

test('an element reads as a selector-ish tag with its first text, not {}', () => {
  const h = helpers();
  const app = el('div', { id: 'app', cls: 'shell main-wrap extra', text: '  Hello\n   fixture  ' });
  assert.equal(h.__ser(app), '<div#app.shell.main-wrap> "Hello fixture"');
  const long = el('p', { text: 'x'.repeat(200) });
  assert.equal(h.__ser(long), `<p> "${'x'.repeat(60)}…"`);
  const link = el('a', { cls: 'dl', text: 'Photo 1', attrs: { href: '/photo/1.jpg' } });
  assert.equal(h.__ser(link), '<a.dl href="/photo/1.jpg"> "Photo 1"');
  assert.equal(h.__ser(el('input', { value: 'typed' })), '<input value="typed">');
  assert.equal(h.__ser(textNode(' hi ')), '#text "hi"');
});

test('a NodeList of 300 links is listed one per line, capped, with the total and what to do', () => {
  const h = helpers();
  const links = Array.from({ length: 300 }, (_, i) => el('a', { cls: 'dl', text: `Photo ${i}`, attrs: { href: `/photo/${i}.jpg` } }));
  const out = h.__ser(nodeList(links)) as string;
  const lines = out.split('\n');
  assert.equal(lines[0], 'NodeList(300), first 50:');
  assert.equal(lines[1], '<a.dl href="/photo/0.jpg"> "Photo 0"');
  assert.equal(lines[50], '<a.dl href="/photo/49.jpg"> "Photo 49"');
  assert.equal(lines[51], '… 250 more; return a slice, or map to the fields you need');
  assert.equal(lines.length, 52);
  // A short list shows everything and claims nothing is missing.
  assert.equal(h.__ser([el('b'), el('i')]), 'Array(2):\n<b>\n<i>');
});

test('Map, Set and Error are readable instead of {}', () => {
  const h = helpers();
  assert.equal(h.__ser(new Map<unknown, unknown>([['a', 1], ['b', { c: 2 }]])), '[["a",1],["b",{"c":2}]]');
  assert.equal(h.__ser(new Set([1, 'two'])), '[1,"two"]');
  assert.equal(h.__ser(new TypeError('x is null')), 'TypeError: x is null');
  assert.equal(h.__ser({ err: new RangeError('bad') }), '{"err":"RangeError: bad"}');
  const big = new Set(Array.from({ length: 250 }, (_, i) => i));
  const parsed = JSON.parse(h.__ser(big));
  assert.equal(parsed.length, 101);
  assert.equal(parsed[100], '… 150 more');
});

test('elements nested in a returned object are described the same way', () => {
  const h = helpers();
  const out = h.__ser({ count: 2, first: el('li', { cls: 'item', text: 'One' }), all: [el('li', { text: 'One' }), 'x'] });
  assert.equal(out, '{"count":2,"first":"<li.item> \\"One\\"","all":["<li> \\"One\\"","x"]}');
});

test('cycles, throwing getters, windows, functions and bigints do not throw', () => {
  const h = helpers();
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  assert.equal(h.__ser(a), '{"name":"a","self":"[Circular]"}');
  const trap = { ok: 1, get bad() { throw new Error('no'); } };
  assert.equal(h.__ser(trap), '{"ok":1,"bad":"[threw]"}');
  assert.equal(h.__ser({ w: globalThis }), '{"w":"[Window]"}');
  assert.equal(h.__ser(function named() {}), '[function named]');
  assert.equal(h.__ser(10n), '10n');
  assert.equal(h.__ser({ d: new Date(0) }), '{"d":"1970-01-01T00:00:00.000Z"}');
});

test('a huge value is bounded rather than hanging', () => {
  const h = helpers();
  // A wide, deep structure: 100 keys at each of 8 levels would be 10^16 nodes without the budget.
  let built = 0;
  const lazy = (d: number): unknown => new Proxy({}, {
    ownKeys: () => Array.from({ length: 100 }, (_, i) => `k${i}`),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: () => (built++, d === 0 ? 1 : lazy(d - 1)),
  });
  const started = Date.now();
  const out = h.__ser(lazy(8)) as string;
  assert.ok(Date.now() - started < 2000, 'serialising took too long');
  // Each visit reads a handful of properties (nodeType, length, toJSON...), so this is ~5,000 visits.
  assert.ok(built < 100_000, `read ${built} properties`);
  assert.match(out, /…/);
  const arr = Array.from({ length: 10_000 }, (_, i) => i);
  assert.equal(JSON.parse(h.__ser(arr)).length, 101);
});

test('a cut says so, with both lengths and what to do', () => {
  const h = helpers();
  const s = 'y'.repeat(18230);
  const out = h.__cap(s, RESULT_CAP, 'return less, or slice') as string;
  assert.ok(out.startsWith('y'.repeat(RESULT_CAP) + '…'));
  assert.ok(out.endsWith('… [truncated: 4,000 of 18,230 chars; return less, or slice]'));
  assert.equal(h.__cap('short', RESULT_CAP, 'x'), 'short');
});

test('a long console line is capped with a marker', () => {
  const h = helpers();
  assert.equal(h.__capLine('z'.repeat(500)), 'z'.repeat(500));
  assert.equal(h.__capLine('z'.repeat(1700)), 'z'.repeat(500) + '… [+1,200 chars]');
  // Logged objects go through the same serialiser as results.
  assert.equal(h.__fmt(['found', el('div', { id: 'x' }), { n: 1 }]), 'found <div#x> {"n":1}');
});

// ---------- the whole wrapper, run ----------

interface Harness {
  sent: Record<string, any>[];
  /** Fire a window error / unhandledrejection the way the browser would. */
  fireError(error: unknown, filename?: string): void;
  fireRejection(reason: unknown): void;
  /** Deliver mutation records to the wrapper's observer. */
  mutate(records: unknown[]): void;
  /** Run every pending timer (the throttle), once. */
  tick(): void;
  done: Promise<Record<string, any>>;
}

/**
 * Run wrapped code with fake globals. The code under test is written as a function of those fakes
 * so the helpers reach them the way they would reach the page's.
 */
function run(code: string, runId = 'run-1234abcd', transport: 'chrome' | 'bridge' = 'chrome'): Harness & { sourceName: string; lineOffset: number } {
  const { wrapped, sourceName, lineOffset } = wrapForExecution(code, runId, transport);
  const sent: Record<string, any>[] = [];
  const listeners: Record<string, ((ev: any) => void)[]> = {};
  let observerCb: ((records: unknown[]) => void) | null = null;
  const pending: Array<() => void> = [];
  const fakeGlobal = {
    addEventListener: (type: string, fn: (ev: any) => void) => (listeners[type] ??= []).push(fn),
    console: { log() {}, info() {}, warn() {}, error() {} },
  };
  class FakeObserver {
    constructor(cb: (records: unknown[]) => void) {
      observerCb = cb;
    }
    observe() {}
    takeRecords() {
      return [];
    }
    disconnect() {}
  }
  const report = (m: Record<string, any>) => sent.push(m);
  const chrome = { runtime: { sendMessage: report } };
  const fakeSetTimeout = (fn: () => void, ms: number) => {
    // The wrapper's settle wait races a 50ms timer against a frame; the frame wins here.
    if (ms === 50) return 0;
    pending.push(fn);
    return pending.length;
  };
  const fn = new Function(
    'chrome', '__usermodsReport', 'document', 'MutationObserver', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'globalThis',
    `return ${wrapped}`,
  );
  const done = fn(chrome, report, { documentElement: {} }, FakeObserver, (cb: () => void) => cb(), fakeSetTimeout, () => {}, fakeGlobal) as Promise<Record<string, any>>;
  return {
    sent,
    sourceName,
    lineOffset,
    done,
    fireError: (error, filename = '') => listeners.error?.forEach((f) => f({ error, filename, message: 'Uncaught ' + String(error) })),
    fireRejection: (reason) => listeners.unhandledrejection?.forEach((f) => f({ reason })),
    mutate: (records) => observerCb?.(records),
    tick: () => pending.splice(0).forEach((f) => f()),
  };
}

test('the wrapper reports plain values and a capped string end to end', async () => {
  const one = run('return 21 * 2');
  assert.equal((await one.done).result, '42');
  const long = run(`return 'q'.repeat(20000)`);
  const out = await long.done;
  assert.equal(out.result.length, RESULT_CAP + '… [truncated: 4,000 of 20,000 chars; return less, or slice]'.length);
  assert.equal(long.sent.length, 1);
  assert.equal(long.sent[0]!.type, 'usermods:run-result');
  assert.equal(long.sent[0]!.runId, 'run-1234abcd');
});

test('the bridge transport reports the same shape through the runner', async () => {
  const h = run('return new Map([[1, 2]])', 'r2', 'bridge');
  await h.done;
  assert.equal(h.sent[0]!.result, '[[1,2]]');
});

test('a thrown stack is capped with a marker, and a thrown non-Error is serialised', async () => {
  const big = run(`const e = new Error('big'); e.stack = 'Error: big\\n' + 'at x\\n'.repeat(3000); throw e;`);
  const out = await big.done;
  assert.equal(out.ok, false);
  assert.match(out.error, /… \[truncated: 4,000 of 15,011 chars\]$/);
  const obj = run(`throw { code: 7 }`);
  assert.equal((await obj.done).error, '{"code":7}');
});

test('console lines are capped, the last 50 kept, and the total counted', async () => {
  const h = run(`for (let i = 0; i < 120; i++) console.log('line ' + i); console.log('w'.repeat(900));`);
  const out = await h.done;
  assert.equal(out.logs.length, LOG_KEEP);
  assert.equal(out.logCount, 121);
  assert.equal(out.logs[out.logs.length - 1], 'w'.repeat(500) + '… [+400 chars]');
  assert.equal(out.logs[0], 'line 71');
});

test('the DOM summary names what changed, collapsing repeats', async () => {
  // The script's own body cannot reach the harness, so the records are fed in from a timer the
  // wrapper's settle wait gives a turn to: requestAnimationFrame runs synchronously here, so feed first.
  const h = run(`await Promise.resolve(); return undefined;`);
  h.mutate([
    { type: 'childList', addedNodes: [], removedNodes: [el('div', { cls: 'modal-backdrop' }), el('div', { id: 'newsletter', cls: 'popup' })] },
    { type: 'childList', addedNodes: [el('div', { cls: 'modal' }), textNode('x')], removedNodes: [] },
    { type: 'attributes', target: el('body'), attributeName: 'class', addedNodes: [], removedNodes: [] },
    { type: 'attributes', target: el('body'), attributeName: 'style', addedNodes: [], removedNodes: [] },
    { type: 'attributes', target: el('body'), attributeName: 'style', addedNodes: [], removedNodes: [] },
  ]);
  const out = await h.done;
  assert.deepEqual(out.dom, {
    added: 2,
    removed: 2,
    attributes: 3,
    targets: {
      added: [['div.modal', 1], ['#text', 1]],
      removed: [['div.modal-backdrop', 1], ['div#newsletter', 1]],
      attributes: [['body', ['class', 'style'], 3]],
    },
  });
});

test('nothing changed means no targets at all', async () => {
  const out = await run('return 1').done;
  assert.deepEqual(out.dom, { added: 0, removed: 0, attributes: 0 });
});

test('an error from the run\'s own callback during the run is in its result', async () => {
  const h = run(`await Promise.resolve(); return 'armed';`);
  const err = new TypeError('x is null');
  err.stack = `TypeError: x is null\n    at MutationObserver.<anonymous> (${h.sourceName}:${h.lineOffset + 2}:9)`;
  h.fireError(err, h.sourceName);
  const out = await h.done;
  assert.deepEqual(out.callbackErrors, [{ message: 'TypeError: x is null', stack: err.stack, count: 1 }]);
});

test('after the result, a new callback error is sent at once, a repeat only updates the count, and others are ignored', async () => {
  const h = run('return 1');
  await h.done;
  assert.equal(h.sent.length, 1);
  const mine = new Error('late boom');
  mine.stack = `Error: late boom\n    at ${h.sourceName}:${h.lineOffset + 1}:20`;
  h.fireError(mine, h.sourceName);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1], { type: 'usermods:run-result', runId: 'run-1234abcd', late: true, errors: [{ message: 'Error: late boom', stack: mine.stack, count: 1 }] });
  // The same error again is throttled: nothing is sent until the timer runs, then the running count.
  h.fireError(mine, h.sourceName);
  h.fireError(mine, h.sourceName);
  assert.equal(h.sent.length, 2);
  h.tick();
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2]!.errors[0].count, 3);
  // A registered mod sharing the world throws: its file is not this run's, so it is not reported.
  const other = new Error('someone else');
  other.stack = 'Error: someone else\n    at <anonymous>:1:26';
  h.fireError(other, '');
  // A rejection whose stack names this run is; one with no stack cannot be attributed and is not.
  const rejected = new Error('rejected');
  rejected.stack = `Error: rejected\n    at ${h.sourceName}:${h.lineOffset + 1}:3`;
  h.fireRejection(rejected);
  h.fireRejection('a bare string');
  h.tick();
  assert.equal(h.sent.length, 4);
  assert.deepEqual(h.sent[3]!.errors.map((e: { message: string }) => e.message), ['Error: rejected']);
});

test('late reports are capped: five distinct errors, twenty sends', async () => {
  const h = run('return 1');
  await h.done;
  for (let i = 0; i < 8; i++) {
    const e = new Error(`e${i}`);
    e.stack = `Error: e${i}\n    at ${h.sourceName}:${h.lineOffset + 1}:1`;
    h.fireError(e, h.sourceName);
  }
  assert.equal(h.sent.length - 1, 5);
  const e0 = new Error('e0');
  e0.stack = `Error: e0\n    at ${h.sourceName}:${h.lineOffset + 1}:1`;
  for (let i = 0; i < 40; i++) {
    h.fireError(e0, h.sourceName);
    h.tick();
  }
  assert.equal(h.sent.length - 1, 20);
});

test('the sourceURL names this run and cannot be broken out of', () => {
  const { wrapped, sourceName } = wrapForExecution('return 1', `ab'"\n*/cd`);
  assert.equal(sourceName, 'usermods-run-abcd.js');
  assert.ok(wrapped.endsWith(`\n//# sourceURL=${sourceName}`));
});
