// Tests for the code buildRegisteredCode() generates. Nothing here touches chrome or a real DOM:
// the generated source is evaluated in node with a hand-rolled fake `chrome`, a fake `document`
// and a fake `window`, which is enough to prove the shim's own behaviour (scoping, value change
// listeners, GM_openInTab's active flag, the GM_xmlhttpRequest response shape).
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegisteredCode } from '../lib/gm.ts';
import { modFromSource } from '../lib/mods.ts';
import type { Mod } from '../lib/types.ts';

function mod(source: string, over: Partial<Mod> = {}): Mod {
  return { ...modFromSource(source), ...over };
}

const HEADER = '// ==UserScript==\n// @name Test Script\n// @match https://a.example/*\n// ==/UserScript==\n';

/** A fake extension world: `chrome`, a minimal `document` and a `window` the code can assign to. */
function fakeWorld(opts: { onSend?: (msg: any) => unknown; withPort?: boolean } = {}) {
  const sent: any[] = [];
  const logs: any[] = [];
  const portListeners: Array<(m: unknown) => void> = [];
  let connectedName: string | null = null;
  const win: any = {};
  const elements: any[] = [];
  const makeEl = (tag: string) => {
    const el: any = { tagName: tag, textContent: '', attrs: {} as Record<string, string>, children: [] as any[] };
    el.setAttribute = (k: string, v: string) => void (el.attrs[k] = v);
    el.appendChild = (c: any) => void el.children.push(c);
    elements.push(el);
    return el;
  };
  const root = makeEl('html');
  const chrome: any = {
    runtime: {
      lastError: undefined as { message: string } | undefined,
      sendMessage(msg: any, cb: (r: unknown) => void) {
        sent.push(msg);
        let result: unknown = true;
        try {
          result = opts.onSend ? opts.onSend(msg) : true;
        } catch (e) {
          cb({ error: e instanceof Error ? e.message : String(e) });
          return;
        }
        cb({ result });
      },
    },
  };
  if (opts.withPort !== false) {
    chrome.runtime.connect = (info: { name: string }) => {
      connectedName = info.name;
      return {
        name: info.name,
        onMessage: { addListener: (fn: (m: unknown) => void) => void portListeners.push(fn) },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
      };
    };
  }
  const globals: Record<string, unknown> = {
    chrome,
    window: win,
    document: { head: root, documentElement: root, createElement: makeEl },
    console: { log: (...a: unknown[]) => void logs.push(a), info: (...a: unknown[]) => void logs.push(a), error: (...a: unknown[]) => void logs.push(a) },
    navigator: { clipboard: { writeText: () => {} } },
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    Blob: class FakeBlob {
      parts: unknown[];
      type: string;
      constructor(parts: unknown[], o: { type?: string } = {}) {
        this.parts = parts;
        this.type = o.type ?? '';
      }
    },
    DOMParser: class FakeDOMParser {
      parseFromString(text: string, mime: string) {
        return { __doc: true, text, mime };
      }
    },
  };
  return {
    win,
    sent,
    logs,
    globals,
    get connectedName() {
      return connectedName;
    },
    /** Deliver a port message the way the background would. */
    emit(m: unknown) {
      for (const fn of portListeners) fn(m);
    },
  };
}

/** Evaluate generated code inside the fake world, returning the world for assertions. */
function run(code: string, world = fakeWorld()) {
  const names = Object.keys(world.globals);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, code) as (...a: unknown[]) => void;
  fn(...names.map((n) => world.globals[n]));
  return world;
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

// ---------- syntax ----------

test('buildRegisteredCode produces parsable code for awkward script shapes', () => {
  const shapes: Array<[string, string]> = [
    ['no trailing newline', HEADER + "console.log('x')"],
    ['ends in a line comment', HEADER + "console.log('x');\n// trailing comment, no newline"],
    ['header only', HEADER],
    ['header only, no trailing newline', HEADER.trimEnd()],
    ['empty body after the header', HEADER + '\n\n'],
    ['body is one line comment', HEADER + '// nothing to do'],
  ];
  for (const [label, source] of shapes) {
    const code = buildRegisteredCode(mod(source), {});
    assert.doesNotThrow(() => new Function(code), `${label} should produce parsable code`);
  }
});

test('an @require ending in a line comment cannot swallow the script body', () => {
  const m = mod(HEADER + 'globalThis.__ran = true;\n', {
    requires: [
      { url: 'https://cdn.example/a.js', code: 'window.libA = 1; // no newline here' },
      { url: 'https://cdn.example/b.js', code: 'window.libB = 2;' },
    ],
  });
  const code = buildRegisteredCode(m, {});
  assert.doesNotThrow(() => new Function(code));
  const w = run(code.replace('globalThis.__ran = true;', 'window.ran = true;'));
  assert.equal(w.win.libA, 1);
  assert.equal(w.win.libB, 2);
  assert.equal(w.win.ran, true, 'the script body still ran');
});

// ---------- finding 2: no forced strict mode, one scope per unit ----------

test('the wrapper does not impose strict mode', () => {
  assert.ok(!/^\s*'use strict'/m.test(buildRegisteredCode(mod(HEADER), {})), 'no "use strict" directive is emitted');
  // Sloppy-mode behaviour a real script may rely on: assigning to an undeclared name.
  const w = run(buildRegisteredCode(mod(HEADER + 'implicitGlobal = 7;\nwindow.seen = implicitGlobal;\n'), {}));
  assert.equal(w.win.seen, 7);
});

test('a strict @require does not make the next unit or the body strict', () => {
  const m = mod(HEADER + 'sloppyInBody = 1;\nwindow.body = sloppyInBody;\n', {
    requires: [
      { url: 'https://cdn.example/strict.js', code: "'use strict';\nwindow.strictRan = true;" },
      { url: 'https://cdn.example/sloppy.js', code: 'sloppyInRequire = 2;\nwindow.req = sloppyInRequire;' },
    ],
  });
  const w = run(buildRegisteredCode(m, {}));
  assert.equal(w.win.strictRan, true);
  assert.equal(w.win.req, 2, 'the next @require is still sloppy');
  assert.equal(w.win.body, 1, 'the script body is still sloppy');
});

test('@require bodies run in order, in their own scope, and still see the GM bindings', () => {
  const m = mod(HEADER + 'window.order.push("body:" + typeof GM_setValue);\n', {
    requires: [
      { url: 'https://cdn.example/1.js', code: 'window.order = ["one:" + typeof GM_getValue]; var scoped = 1;' },
      { url: 'https://cdn.example/2.js', code: 'window.order.push("two:" + typeof scoped);' },
    ],
  });
  const w = run(buildRegisteredCode(m, {}));
  assert.deepEqual(w.win.order, ['one:function', 'two:undefined', 'body:function'], 'ordered, GM visible, var not shared');
});

// ---------- finding 7 / C3: live values ----------

test('GM_addValueChangeListener fires on local writes and returns a removable id', async () => {
  const m = mod(HEADER + `
window.events = [];
window.id = GM_addValueChangeListener('k', function (name, oldValue, newValue, remote) { window.events.push([name, oldValue, newValue, remote]); });
GM_setValue('k', 1);
GM_setValue('k', 2);
GM_removeValueChangeListener(window.id);
GM_setValue('k', 3);
GM_addValueChangeListener('gone', function (n, o, v, r) { window.events.push(['gone', o, v, r]); });
GM_deleteValue('gone');
`);
  const w = run(buildRegisteredCode(m, { gone: 'x' }));
  assert.ok(typeof w.win.id === 'number' && w.win.id > 0, 'a listener id is returned');
  assert.deepEqual(w.win.events, [
    ['k', undefined, 1, false],
    ['k', 1, 2, false],
    ['gone', 'x', undefined, false],
  ]);
});

test('the shim connects a gm:<modId> port and applies remote changes', async () => {
  const m = mod(HEADER + `
window.events = [];
GM_addValueChangeListener('k', function (name, oldValue, newValue, remote) { window.events.push([name, oldValue, newValue, remote, GM_getValue('k')]); });
`);
  const w = fakeWorld();
  run(buildRegisteredCode({ ...m, id: 'mod-123' }, { k: 'old' }), w);
  assert.equal(w.connectedName, 'gm:mod-123');
  w.emit({ type: 'gm.valueChanged', key: 'k', oldValue: 'old', newValue: 'new', remote: true });
  assert.deepEqual(w.win.events, [['k', 'old', 'new', true, 'new']], 'the snapshot is updated before the callback reads it');
  // A remote delete removes the key from the snapshot.
  w.emit({ type: 'gm.valueChanged', key: 'k', oldValue: 'new', newValue: undefined, remote: true });
  assert.deepEqual(w.win.events[1], ['k', 'new', undefined, true, undefined]);
});

test('the shim survives a world with no chrome.runtime.connect (MAIN world)', () => {
  const m = mod(HEADER + "window.events = [];\nGM_addValueChangeListener('k', function (n, o, v, r) { window.events.push(r); });\nGM_setValue('k', 1);\n");
  const w = fakeWorld({ withPort: false });
  assert.doesNotThrow(() => run(buildRegisteredCode(m, {}), w));
  assert.deepEqual(w.win.events, [false], 'local writes still fire listeners');
});

// ---------- finding 12: GM_openInTab ----------

test('GM_openInTab background/foreground follows Tampermonkey', () => {
  const m = mod(HEADER + `
GM_openInTab('https://x.example/1');
GM_openInTab('https://x.example/2', true);
GM_openInTab('https://x.example/3', false);
GM_openInTab('https://x.example/4', {});
GM_openInTab('https://x.example/5', { active: true });
GM_openInTab('https://x.example/6', { active: false });
`);
  const w = run(buildRegisteredCode(m, {}));
  const calls = w.sent.filter((s) => s.type === 'gm.openInTab').map((s) => [s.url.slice(-1), s.active]);
  assert.deepEqual(calls, [
    ['1', true], // no options: foreground
    ['2', false], // bare true: background
    ['3', true], // bare false: foreground
    ['4', false], // object without 'active': background
    ['5', true],
    ['6', false],
  ]);
});

// ---------- finding 13 / C2: xhr response shapes ----------

async function xhr(script: string, reply: Record<string, unknown>) {
  const w = fakeWorld({ onSend: (msg) => (msg.type === 'gm.xhr' ? reply : true) });
  run(buildRegisteredCode(mod(HEADER + script), {}), w);
  await nextTick();
  await nextTick();
  return w;
}

test('GM_xmlhttpRequest passes responseType through and echoes it back', async () => {
  const w = await xhr("GM_xmlhttpRequest({ url: 'https://api.example/x', responseType: 'json', onload: function (r) { window.r = r; } });", {
    status: 200,
    statusText: 'OK',
    responseHeaders: 'content-type: application/json',
    finalUrl: 'https://api.example/x',
    responseText: '{"a":1}',
    response: { a: 1 },
  });
  assert.equal(w.sent.find((s) => s.type === 'gm.xhr').details.responseType, 'json', 'the shim sends responseType unchanged');
  assert.deepEqual(w.win.r.response, { a: 1 });
  assert.equal(w.win.r.responseType, 'json', 'the response object echoes responseType');
  assert.equal(w.win.r.status, 200);
  assert.equal(w.win.r.finalUrl, 'https://api.example/x');
  assert.equal(w.win.r.responseXML, null);
});

test('an arraybuffer response is rebuilt from base64', async () => {
  const bytes = [0x00, 0x01, 0xfe, 0xff];
  const w = await xhr("GM_xmlhttpRequest({ url: 'https://api.example/b', responseType: 'arraybuffer', onload: function (r) { window.r = r; } });", {
    status: 200,
    statusText: 'OK',
    responseHeaders: 'content-type: application/octet-stream',
    finalUrl: 'https://api.example/b',
    base64: Buffer.from(bytes).toString('base64'),
  });
  assert.ok(w.win.r.response instanceof ArrayBuffer, 'response is an ArrayBuffer');
  assert.deepEqual([...new Uint8Array(w.win.r.response)], bytes);
  assert.equal(w.win.r.responseType, 'arraybuffer');
});

test('a blob response is rebuilt from base64 with the content type', async () => {
  const w = await xhr("GM_xmlhttpRequest({ url: 'https://api.example/p.png', responseType: 'blob', onload: function (r) { window.r = r; } });", {
    status: 200,
    statusText: 'OK',
    responseHeaders: 'content-length: 3\r\nContent-Type: image/png; charset=binary',
    finalUrl: 'https://api.example/p.png',
    base64: Buffer.from([1, 2, 3]).toString('base64'),
  });
  assert.equal(w.win.r.response.type, 'image/png', 'the blob type comes from the response headers');
  assert.deepEqual([...new Uint8Array(w.win.r.response.parts[0])], [1, 2, 3]);
});

test("a 'document' response is parsed into response and responseXML", async () => {
  const w = await xhr("GM_xmlhttpRequest({ url: 'https://api.example/h', responseType: 'document', onload: function (r) { window.r = r; } });", {
    status: 200,
    statusText: 'OK',
    responseHeaders: 'content-type: text/html',
    finalUrl: 'https://api.example/h',
    responseText: '<html><body>hi</body></html>',
  });
  assert.equal(w.win.r.response.__doc, true);
  assert.equal(w.win.r.response.mime, 'text/html');
  assert.equal(w.win.r.responseXML, w.win.r.response, 'responseXML is the same document');
  assert.equal(w.win.r.responseText, '<html><body>hi</body></html>', 'the text is still there');
});

test('a rejected xhr reaches onerror with a shaped response', async () => {
  const w = fakeWorld({
    onSend: (msg) => {
      if (msg.type === 'gm.xhr') throw new Error("GM_xmlhttpRequest to evil.example is not allowed: add '// @connect evil.example' to the script header");
      return true;
    },
  });
  run(
    buildRegisteredCode(
      mod(HEADER + "GM_xmlhttpRequest({ url: 'https://evil.example/', responseType: 'arraybuffer', onerror: function (r) { window.err = r; }, onloadend: function () { window.ended = true; } });"),
      {},
    ),
    w,
  );
  await nextTick();
  await nextTick();
  assert.equal(w.win.err.status, 0);
  assert.match(w.win.err.error, /@connect evil\.example/);
  assert.equal(w.win.err.responseType, 'arraybuffer');
  assert.equal(w.win.ended, true);
});

// ---------- GM_info ----------

test('GM_info carries the connect list', () => {
  const m = mod('// ==UserScript==\n// @name X\n// @match https://a.example/*\n// @connect api.example.com\n// ==/UserScript==\nwindow.info = GM_info;\n');
  const w = run(buildRegisteredCode(m, {}));
  assert.deepEqual(w.win.info.script.connects, ['api.example.com']);
  assert.equal(w.win.info.scriptHandler, 'usermods');
});
