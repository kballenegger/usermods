/**
 * The wrapper around a one-off run (the Try button, and the agent's run_script tool).
 *
 * How the result gets back depends on the engine. On Chrome the wrapped code calls
 * `chrome.runtime.sendMessage` from inside the USER_SCRIPT world, which `configureWorld({messaging:
 * true})` made possible. Under the content-script engine there is no such world, and the runner
 * evaluates the code with `chrome` shadowed, so the result comes back through a `__usermodsReport`
 * function the runner passes in.
 *
 * What the wrapper reports is what the model sees of its own script, and every lossy step in it
 * used to force a follow-up script. So:
 *
 *  - the returned value is serialised by `__ser` (PAGE_HELPERS below) rather than JSON.stringify,
 *    which turned an Element into `{}`, a NodeList into `{"0":{},...}` and a Map, Set or Error into
 *    `{}`. Plain JSON comes out exactly as JSON.stringify wrote it, so a small result is unchanged;
 *  - anything cut says so, with the length it was cut from and what to do instead;
 *  - the DOM observer names what it saw change, not just how much (lib/runscript.ts renders it);
 *  - errors thrown later by the script's own callbacks are caught and reported. See `__catchLate`.
 */

export type ReportTransport = 'chrome' | 'bridge';

export interface Wrapped {
  wrapped: string;
  /** Lines the preamble added, so a thrown error is reported at the line the model wrote. */
  lineOffset: number;
  /**
   * The `//# sourceURL` this run's code is compiled under. Stack frames and error events from the
   * run name it, which is how an error thrown in one of its callbacks minutes later is told apart
   * from one thrown by a registered mod sharing the same world. The background swaps it back to
   * `<anonymous>` before mapStack, so a thrown error reads exactly as it did before.
   */
  sourceName: string;
}

/** Longest returned value, and longest thrown stack, the model is shown. */
export const RESULT_CAP = 4000;
/** Longest single console line. A logged 50 KB JSON blob is not worth 12k tokens. */
export const LOG_LINE_CAP = 500;
/** Console lines kept, newest last. The count of all of them rides along so a drop is named. */
export const LOG_KEEP = 50;

/**
 * The page-side helpers, as source text, declared as functions at the end of the wrapper's outer
 * function so they hoist above the preamble that uses them and add nothing to the line offset.
 *
 * Text rather than `fn.toString()` of TypeScript functions, because the bundler minifies the
 * background, and a minifier is free to rewrite a function in ways that only work inside its own
 * module. The wrapper has always been source text for the same reason. Every helper here is
 * exercised under node by test/exec-wrap-runtime.test.ts, which evaluates this exact string.
 *
 * Everything is defensive: a getter that throws, a cyclic object, a 100 MB string or a window must
 * produce a string, never a throw or a hang, because a throw here loses the whole result.
 *
 * Naming (`__name`): tag, then `#id` if it has one, then up to two classes. The DOM summary uses the
 * short form, where an id replaces the classes, since an id already names the node; a returned
 * element uses the long form, because the classes are what a selector is built from.
 */
export const PAGE_HELPERS = `
function __clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
function __num(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }
function __cap(s, max, hint) {
  s = String(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + '… [truncated: ' + __num(max) + ' of ' + __num(s.length) + ' chars' + (hint ? '; ' + hint : '') + ']';
}
function __capLine(s) {
  s = String(s);
  return s.length > ${LOG_LINE_CAP} ? s.slice(0, ${LOG_LINE_CAP}) + '… [+' + __num(s.length - ${LOG_LINE_CAP}) + ' chars]' : s;
}
function __isNode(v) { return !!v && typeof v === 'object' && typeof v.nodeType === 'number' && typeof v.nodeName === 'string'; }
function __isError(v) {
  try { return v instanceof Error || Object.prototype.toString.call(v) === '[object Error]'; } catch (e) { return false; }
}
function __isWindow(v) { try { return v === globalThis || (typeof v.window === 'object' && v.window === v); } catch (e) { return true; } }
function __listLike(v) {
  if (Array.isArray(v)) return true;
  try { return (typeof v.length === 'number' && typeof v.item === 'function') || ArrayBuffer.isView(v); } catch (e) { return false; }
}
function __errLine(e) {
  try { const name = e.name || 'Error'; return e.message ? name + ': ' + e.message : String(name); } catch (x) { return 'Error'; }
}
function __name(n, long) {
  try {
    if (n.nodeType !== 1) return String(n.nodeName || '?').toLowerCase();
    let s = String(n.localName || n.nodeName || '?').toLowerCase();
    const id = typeof n.id === 'string' ? n.id : '';
    if (id) s += '#' + __clip(id, 40);
    if (!id || long) {
      const raw = typeof n.className === 'string' ? n.className : (n.getAttribute && n.getAttribute('class')) || '';
      for (const c of String(raw).trim().split(/\\s+/).filter(Boolean).slice(0, 2)) s += '.' + __clip(c, 30);
    }
    return s;
  } catch (e) { return '?'; }
}
function __describe(n) {
  try {
    const t = n.nodeType;
    const text = (x, max) => __clip(String(x || '').replace(/\\s+/g, ' ').trim(), max);
    if (t === 1) {
      let s = '<' + __name(n, true);
      for (const a of ['href', 'src']) {
        const v = n.getAttribute ? n.getAttribute(a) : null;
        if (v) s += ' ' + a + '="' + __clip(v, 80) + '"';
      }
      const tag = String(n.localName || '').toLowerCase();
      if ((tag === 'input' || tag === 'textarea' || tag === 'select') && n.value) s += ' value="' + __clip(n.value, 40) + '"';
      const body = text(n.textContent, 60);
      return s + '>' + (body ? ' "' + body + '"' : '');
    }
    if (t === 3) return '#text "' + text(n.textContent, 60) + '"';
    if (t === 8) return '#comment';
    if (t === 9) return '#document';
    if (t === 11) return '#fragment';
    return String(n.nodeName);
  } catch (e) { return '[node]'; }
}
function __plain(v, depth, stack, st) {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v === undefined) return undefined;
  if (typeof v === 'bigint') return String(v) + 'n';
  if (typeof v === 'symbol') return String(v);
  if (typeof v === 'function') return '[function' + (v.name ? ' ' + v.name : '') + ']';
  if (--st.budget < 0) return '…';
  if (__isNode(v)) return __describe(v);
  if (__isError(v)) return __errLine(v);
  if (__isWindow(v)) return '[Window]';
  if (stack.indexOf(v) !== -1) return '[Circular]';
  if (depth >= 8) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]';
  stack.push(v);
  try {
    if (typeof v.toJSON === 'function') {
      let j; try { j = v.toJSON(); } catch (e) { return '[threw]'; }
      return j === v ? '[Object]' : __plain(j, depth + 1, stack, st);
    }
    let items = null, total = 0;
    if (v instanceof Map) {
      total = v.size; items = [];
      for (const [k, x] of v) { if (items.length >= 100) break; items.push([k, x]); }
    } else if (v instanceof Set) {
      total = v.size; items = [];
      for (const x of v) { if (items.length >= 100) break; items.push(x); }
    } else if (__listLike(v)) {
      total = v.length; items = [];
      for (let i = 0; i < Math.min(total, 100); i++) items.push(v[i]);
    }
    if (items) {
      const out = [];
      for (const x of items) { const p = __plain(x, depth + 1, stack, st); out.push(p === undefined ? null : p); }
      if (total > items.length) out.push('… ' + __num(total - items.length) + ' more');
      return out;
    }
    const out = {};
    let keys; try { keys = Object.keys(v); } catch (e) { return '[Object]'; }
    for (const k of keys.slice(0, 100)) {
      let x; try { x = v[k]; } catch (e) { x = '[threw]'; }
      const p = __plain(x, depth + 1, stack, st);
      if (p !== undefined) out[k] = p;
    }
    if (keys.length > 100) out['…'] = __num(keys.length - 100) + ' more keys';
    return out;
  } finally { stack.pop(); }
}
function __ser(v) {
  try {
    if (typeof v === 'string') return v;
    if (v === undefined) return 'undefined';
    if (__isNode(v)) return __describe(v);
    if (__isError(v)) return __errLine(v);
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return String(__plain(v, 0, [], { budget: 1 }));
    // A list of nodes, the commonest non-JSON thing a script returns, reads best one per line.
    if (v && typeof v === 'object' && !__isWindow(v) && __listLike(v) && v.length > 0) {
      let all = true;
      for (let i = 0; i < v.length && all; i++) all = __isNode(v[i]);
      if (all) {
        const n = v.length, show = Math.min(n, 50), lines = [];
        for (let i = 0; i < show; i++) lines.push(__describe(v[i]));
        const kind = Object.prototype.toString.call(v).slice(8, -1);
        return kind + '(' + __num(n) + ')' + (n > show ? ', first ' + show : '') + ':\\n' + lines.join('\\n') +
          (n > show ? '\\n… ' + __num(n - show) + ' more; return a slice, or map to the fields you need' : '');
      }
    }
    const s = JSON.stringify(__plain(v, 0, [], { budget: 5000 }));
    return s === undefined ? 'undefined' : s;
  } catch (e) {
    try { return String(v); } catch (x) { return '[unserialisable]'; }
  }
}
function __fmt(a) { return a.map((x) => typeof x === 'string' ? x : __ser(x)).join(' '); }
function __watchDom() {
  const counts = { added: 0, removed: 0, attributes: 0 };
  const tally = { added: new Map(), removed: new Map(), attributes: new Map() };
  // Twenty distinct names per kind is plenty to pick the top five from, and bounds the cost of a
  // script that rebuilds the whole page.
  const bump = (kind, node, attr) => {
    const m = tally[kind], k = __name(node, false);
    let e = m.get(k);
    if (!e) { if (m.size >= 20) return; e = { n: 0, attrs: [] }; m.set(k, e); }
    e.n++;
    if (attr && e.attrs.length < 4 && e.attrs.indexOf(attr) === -1) e.attrs.push(attr);
  };
  const take = (records) => {
    for (const r of records) {
      if (r.type === 'attributes') { counts.attributes++; bump('attributes', r.target, r.attributeName); }
      else {
        counts.added += r.addedNodes.length; counts.removed += r.removedNodes.length;
        for (const n of r.addedNodes) bump('added', n);
        for (const n of r.removedNodes) bump('removed', n);
      }
    }
  };
  let obs = null;
  try {
    obs = new MutationObserver(take);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  } catch (e) {}
  return {
    flush() { try { if (obs) take(obs.takeRecords()); } catch (e) {} },
    stop() { try { if (obs) obs.disconnect(); } catch (e) {} },
    summary() {
      const dom = { added: counts.added, removed: counts.removed, attributes: counts.attributes };
      if (counts.added || counts.removed || counts.attributes) {
        dom.targets = {
          added: [...tally.added].map(([k, e]) => [k, e.n]),
          removed: [...tally.removed].map(([k, e]) => [k, e.n]),
          attributes: [...tally.attributes].map(([k, e]) => [k, e.attrs, e.n]),
        };
      }
      return dom;
    },
  };
}
function __catchLate(src, send) {
  // Uncaught errors and rejections in this world, kept only when their stack or file names this
  // run's sourceURL: registered mods share the world and must not be blamed on the model's script.
  // A rejection with a non-Error reason carries no stack, so it cannot be attributed and is skipped.
  const seen = new Map();
  let settled = false, timer = 0, flushes = 0;
  const flush = () => {
    timer = 0;
    if (flushes >= 20) return;
    const errors = [];
    for (const e of seen.values()) if (e.dirty) { e.dirty = false; errors.push({ message: e.message, stack: e.stack, count: e.count }); }
    if (!errors.length) return;
    flushes++;
    send({ late: true, errors });
  };
  const note = (err, filename, fallback) => {
    try {
      const stack = err && typeof err.stack === 'string' ? err.stack : '';
      if (filename !== src && stack.indexOf(src) === -1) return;
      const message = __clip(__isError(err) ? __errLine(err) : err !== undefined && err !== null ? 'Uncaught ' + __ser(err) : fallback || 'Uncaught error', 300);
      const at = stack.slice(stack.indexOf(src)).split('\\n')[0];
      const key = message + '|' + at;
      let e = seen.get(key), fresh = false;
      if (!e) {
        if (seen.size >= 5) return;
        e = { message, stack: stack.slice(0, 1500), count: 0, dirty: false };
        seen.set(key, e); fresh = true;
      }
      e.count++; e.dirty = true;
      if (!settled) return;
      // A new error goes out at once; a repeat (an observer throwing on every mutation) only
      // updates the count, at most once a second.
      if (fresh) { if (timer) clearTimeout(timer); flush(); }
      else if (!timer) timer = setTimeout(flush, 1000);
    } catch (x) {}
  };
  try {
    globalThis.addEventListener('error', (ev) => note(ev.error, ev.filename, ev.message));
    globalThis.addEventListener('unhandledrejection', (ev) => note(ev.reason, '', ''));
  } catch (x) {}
  return {
    // The errors thrown while the run was still being measured belong in its own result; after
    // this, they go out on their own as late reports.
    settle() {
      settled = true;
      const out = [];
      // Counted from zero again, so a late report's count is what happened after the result.
      for (const e of seen.values()) { out.push({ message: e.message, stack: e.stack, count: e.count }); e.dirty = false; e.count = 0; }
      return out;
    },
  };
}
`;

/** A runId reduced to what is safe in a file name, so the sourceURL comment cannot be broken. */
function sourceNameFor(runId: string): string {
  return `usermods-run-${runId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || 'x'}.js`;
}

/**
 * Everything the injected wrapper puts around the model's code, split so the line offset of the
 * user's first line is a computable constant rather than a guess. mapStack() needs that offset to
 * report a thrown error at the line the model wrote, not the line the wrapper landed on.
 *
 * The observer is the answer to "the script reported nothing, did it do anything?": a script whose
 * only effect is `forEach((e) => e.remove())` has no return value, and without a count of what it
 * moved the model has no evidence it worked and goes back to inspecting the page.
 */
export function wrapForExecution(code: string, runId: string, transport: ReportTransport = 'chrome'): Wrapped {
  const sourceName = sourceNameFor(runId);
  const send =
    transport === 'bridge'
      ? `(m) => { try { __usermodsReport({ type: 'usermods:run-result', runId: ${JSON.stringify(runId)}, ...m }); } catch {} }`
      : `(m) => { try { chrome.runtime.sendMessage({ type: 'usermods:run-result', runId: ${JSON.stringify(runId)}, ...m }); } catch {} }`;
  const preamble = `(async () => {
    const __send = ${send};
    const __logs = [];
    let __logCount = 0;
    const __log = (s) => { __logCount++; __logs.push(__capLine(s)); if (__logs.length > ${LOG_KEEP}) __logs.shift(); };
    const __console = globalThis.console;
    const console = { ...__console, log: (...a) => { __log(__fmt(a)); __console.log(...a); }, info: (...a) => { __log(__fmt(a)); __console.info(...a); }, warn: (...a) => { __log('warn: ' + __fmt(a)); __console.warn(...a); }, error: (...a) => { __log('error: ' + __fmt(a)); __console.error(...a); } };
    const __late = __catchLate(${JSON.stringify(sourceName)}, __send);
    const __dom = __watchDom();
    let __out;
    try {
      const __r = await (async () => {`;
  const epilogue = `
      })();
      // One microtask turn and one frame, so a removal the page does in a rAF callback is counted.
      await new Promise((r) => { try { requestAnimationFrame(() => r()); setTimeout(r, 50); } catch { r(); } });
      __dom.flush();
      __out = { ok: true, returnedValue: __r !== undefined, result: __cap(__ser(__r), ${RESULT_CAP}, 'return less, or slice'), dom: __dom.summary() };
    } catch (e) {
      const __e = (e && e.stack) ? String(e.stack) : __ser(e);
      __out = { ok: false, error: __cap(__e, ${RESULT_CAP}, ''), dom: __dom.summary() };
    }
    __dom.stop();
    __out.logs = __logs;
    __out.logCount = __logCount;
    __out.callbackErrors = __late.settle();
    __send(__out);
    return __out;
    ${PAGE_HELPERS}
  })()
//# sourceURL=${sourceName}`;
  // The user's first line begins on the line after the preamble's last newline.
  return { wrapped: `${preamble} ${code}${epilogue}`, lineOffset: preamble.split('\n').length - 1, sourceName };
}
