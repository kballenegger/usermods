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

test('the chrome transport is what the generated code uses when no bridge is asked for', () => {
  const m = mod(HEADER + "GM_setValue('k', 1);");
  const chromeCode = buildRegisteredCode(m, {});
  const bridgeCode = buildRegisteredCode(m, {}, { transport: 'bridge', token: 't' });
  assert.match(chromeCode, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(chromeCode, /__usermodsBridge/);
  assert.match(bridgeCode, /__usermodsBridge/);
  // The one line that would undo the whole model: the bridge path must not send a modId.
  const sendBlock = bridgeCode.split('const __send')[1]?.split('\n\n')[0] ?? '';
  assert.ok(sendBlock, 'the generated bridge code should have a __send block to inspect');
  assert.doesNotMatch(sendBlock, /modId: __meta\.id/);
});

test('a mod with no bridge attached gets a clear error rather than a silent no-op', async () => {
  const m = mod(HEADER + "GM_setValue('k', 1);");
  const world = bridgeWorld();
  world.globals.__usermodsBridge = undefined;
  // GM_setValue is fire-and-forget and swallows its own rejection, so the proof is negative:
  // evaluating the code does not throw, and nothing leaves. A mod whose bridge went missing fails
  // where it stands rather than taking the runner down with it.
  run(buildRegisteredCode(m, {}, { transport: 'bridge', token: 't' }), world);
  await nextTick();
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
  world.emit({ type: 'gm.valueChanged', key: 'k', oldValue: 1, newValue: 9 });
  await nextTick();
  assert.deepEqual((world.globals.window as Record<string, any>).seen, [['k', 1, 9, true]]);
});

test('a deletion from another frame removes the value rather than storing undefined', async () => {
  const m = mod(HEADER + `window.after = () => GM_getValue('k', 'gone');`);
  const world = run(buildRegisteredCode(m, { k: 1 }, { transport: 'bridge', token: 't' }));
  world.emit({ type: 'gm.valueChanged', key: 'k', oldValue: 1, newValue: undefined });
  await nextTick();
  assert.equal((world.globals.window as Record<string, any>).after(), 'gone');
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
