// The GM shim under the content-script engine (Safari), where there is no chrome in scope.
//
// The chrome transport is covered in test/gm.test.ts. What is new here is that every privileged call
// leaves through a closure the runner passes in, carries a capability token, and carries no modId,
// so a mod cannot name a mod. The generated source is evaluated in node against a fake bridge, the
// same way the chrome transport is.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegisteredCode } from '../lib/gm.ts';
import { modFromSource } from '../lib/mods.ts';
import type { Mod } from '../lib/types.ts';

const HEADER = '// ==UserScript==\n// @name Bridge Script\n// @match https://a.example/*\n// ==/UserScript==\n';

function mod(source: string, over: Partial<Mod> = {}): Mod {
  return { ...modFromSource(source), ...over };
}

/**
 * The runner's side of the bridge: the two capabilities the generated code is given, and nothing
 * else. Note what is absent from `globals`: there is no `chrome`, because on Safari the mod is
 * evaluated with it shadowed.
 */
function bridgeWorld(opts: { onSend?: (msg: any) => unknown } = {}) {
  const sent: any[] = [];
  const subscribers: Array<(m: unknown) => void> = [];
  const logs: any[] = [];
  const makeEl = (tag: string) => {
    const el: any = { tagName: tag, textContent: '', attrs: {} as Record<string, string>, children: [] as any[] };
    el.setAttribute = (k: string, v: string) => void (el.attrs[k] = v);
    el.appendChild = (c: any) => void el.children.push(c);
    return el;
  };
  const root = makeEl('html');
  const bridge = {
    send(msg: any) {
      sent.push(msg);
      try {
        return Promise.resolve(opts.onSend ? opts.onSend(msg) : true);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    subscribe(fn: (m: unknown) => void) {
      subscribers.push(fn);
    },
  };
  const globals: Record<string, unknown> = {
    __usermodsBridge: bridge,
    __usermodsReport: () => {},
    // Shadowed, exactly as lib/exec/evaluate.ts shadows them.
    chrome: undefined,
    browser: undefined,
    window: {},
    document: { head: root, documentElement: root, createElement: makeEl },
    console: { log: (...a: unknown[]) => void logs.push(a), info: (...a: unknown[]) => void logs.push(a), error: (...a: unknown[]) => void logs.push(a) },
    navigator: { clipboard: { writeText: () => {} } },
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
  };
  return {
    sent,
    logs,
    globals,
    emit(m: unknown) {
      for (const fn of subscribers) fn(m);
    },
    get subscribed() {
      return subscribers.length;
    },
  };
}

function run(code: string, world = bridgeWorld()) {
  const names = Object.keys(world.globals);
  const fn = new Function(...names, code) as (...a: unknown[]) => void;
  fn(...names.map((n) => world.globals[n]));
  return world;
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

test('a bridge call carries the token and never a modId', async () => {
  const m = mod(HEADER + "GM_setValue('k', 1);");
  const world = run(buildRegisteredCode(m, {}, { transport: 'bridge', token: 'tok-abc' }));
  await nextTick();
  assert.equal(world.sent.length, 1);
  const msg = world.sent[0];
  assert.equal(msg.type, 'gm.setValue');
  assert.equal(msg.token, 'tok-abc');
  // The identity the background uses comes from its own grant table, so there is nothing on the wire
  // for a mod to set. See lib/exec/grants.ts and test/exec-protocol.test.ts.
  assert.equal('modId' in msg, false);
});

test('the shim works with no chrome in scope at all', async () => {
  const m = mod(HEADER + "GM_setValue('k', 2); GM_deleteValue('k'); GM_log('hello');");
  const world = run(buildRegisteredCode(m, {}, { transport: 'bridge', token: 't' }));
  await nextTick();
  assert.deepEqual(
    world.sent.map((s) => s.type),
    ['gm.setValue', 'gm.deleteValue'],
  );
  // GM_log is local, so it proves the other half: the mod's own console still works with the
  // extension API out of scope.
  assert.equal(world.logs.length, 1);
});

test('the chrome transport is what the generated code uses when no bridge is asked for', async () => {
  const m = mod(HEADER + "GM_setValue('k', 1);");
  const world = bridgeWorld();
  const viaChrome: any[] = [];
  world.globals.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg: any, cb: (r: unknown) => void) {
        viaChrome.push(msg);
        cb({ result: true });
      },
    },
  };
  run(buildRegisteredCode(m, {}), world);
  await nextTick();
  assert.deepEqual(
    viaChrome.map((s) => s.type),
    ['gm.setValue'],
  );
  assert.deepEqual(world.sent, [], 'nothing goes through the bridge when no bridge was asked for');
});

test('a mod with no bridge attached gets a clear error rather than a silent no-op', async () => {
  const m = mod(
    HEADER +
      `GM_xmlhttpRequest({ url: 'https://api.example/x', onerror: (r) => { window.failed = r; } });`,
  );
  const world = bridgeWorld();
  world.globals.__usermodsBridge = undefined;
  // Evaluating the code does not throw, so a missing bridge fails the mod where it stands rather
  // than taking the runner down. The mod still hears why through its own error callback.
  run(buildRegisteredCode(m, {}, { transport: 'bridge', token: 't' }), world);
  await nextTick();
  await nextTick();
  const failed = (world.globals.window as Record<string, any>).failed;
  assert.ok(failed, 'onerror must be called');
  assert.match(String(failed.error), /did not attach its bridge/);
  assert.deepEqual(world.sent, []);
});

test('an awaited GM call surfaces the bridge failure as an Error', async () => {
  const m = mod(
    HEADER +
      `GM_xmlhttpRequest({ url: 'https://api.example/x', onerror: (r) => { window.failed = r; } });`,
  );
  const world = bridgeWorld({
    onSend: () => {
      throw new Error('usermods: this script is not allowed to make that call.');
    },
  });
  run(buildRegisteredCode(m, {}, { transport: 'bridge', token: 'stale' }), world);
  await nextTick();
  await nextTick();
  const failed = (world.globals.window as Record<string, any>).failed;
  assert.ok(failed, 'onerror must be called');
  // The refusal the background sends for a malformed, unknown or wrong-frame token reaches the mod
  // verbatim: the mod learns it was refused and nothing about why.
  assert.match(String(failed.error ?? failed.responseText ?? ''), /not allowed to make that call/);
});

test('a value change from another frame arrives through the bridge subscription', async () => {
  const m = mod(
    HEADER +
      `window.seen = []; GM_addValueChangeListener('k', (key, oldV, newV, remote) => { window.seen.push([key, oldV, newV, remote]); });`,
  );
  const world = run(buildRegisteredCode(m, { k: 1 }, { transport: 'bridge', token: 't' }));
  // The mod holds no port of its own: the runner owns one connection per document and fans out.
  assert.equal(world.subscribed, 1);
  world.emit({ type: 'gm.valueChanged', modId: m.id, key: 'k', oldValue: 1, newValue: 9 });
  await nextTick();
  assert.deepEqual((world.globals.window as Record<string, any>).seen, [['k', 1, 9, true]]);
});

test('a deletion from another frame removes the value rather than storing undefined', async () => {
  const m = mod(HEADER + `window.after = () => GM_getValue('k', 'gone');`);
  const world = run(buildRegisteredCode(m, { k: 1 }, { transport: 'bridge', token: 't' }));
  world.emit({ type: 'gm.valueChanged', modId: m.id, key: 'k', oldValue: 1, newValue: undefined });
  await nextTick();
  assert.equal((world.globals.window as Record<string, any>).after(), 'gone');
});

test('a value change for another mod is not delivered to this mod', async () => {
  const m = mod(
    HEADER +
      `window.seen = []; window.read = () => GM_getValue('k'); GM_addValueChangeListener('k', (...a) => window.seen.push(a));`,
  );
  const other = mod(HEADER + `GM_setValue('k', 9);`);
  const world = run(buildRegisteredCode(m, { k: 1 }, { transport: 'bridge', token: 't' }));
  world.emit({ type: 'gm.valueChanged', modId: other.id, key: 'k', oldValue: 1, newValue: 9 });
  await nextTick();
  assert.deepEqual((world.globals.window as Record<string, any>).seen, []);
  assert.equal((world.globals.window as Record<string, any>).read(), 1);
});

test('the bridge ignores traffic that is not a value change', async () => {
  const m = mod(HEADER + `window.seen = []; GM_addValueChangeListener('k', (...a) => window.seen.push(a));`);
  const world = run(buildRegisteredCode(m, {}, { transport: 'bridge', token: 't' }));
  world.emit({ type: 'usermods:run-result', runId: 'r1', ok: true });
  world.emit(null);
  world.emit({ key: 'k', newValue: 3 });
  await nextTick();
  assert.deepEqual((world.globals.window as Record<string, any>).seen, []);
});
