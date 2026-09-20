// The Safari adapter is the security boundary around the shared runtime.onMessage channel.
// Drive it with browser-shaped events rather than trusting the pure helpers alone.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecAdapter } from '../lib/exec/adapter.ts';
import type { Mod } from '../lib/types.ts';

interface Event<T extends (...args: any[]) => unknown = (...args: any[]) => unknown> {
  listeners: T[];
  addListener(fn: T): void;
  removeListener(fn: T): void;
}

function event<T extends (...args: any[]) => unknown>(): Event<T> {
  const listeners: T[] = [];
  return {
    listeners,
    addListener(fn) {
      listeners.push(fn);
    },
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

function mod(overrides: Partial<Mod> = {}): Mod {
  return {
    id: 'mod-a',
    name: 'A mod',
    description: '',
    version: '1',
    matches: ['https://allowed.example/*'],
    excludeMatches: [],
    includeGlobs: [],
    excludeGlobs: [],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
    allFrames: false,
    grants: ['GM_setValue'],
    connect: [],
    requires: [],
    resources: [],
    source: '// ==UserScript==\n// @name A mod\n// ==/UserScript==\nGM_setValue("seen", true);',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function chromeMock() {
  const onMessage = event();
  const onConnect = event();
  const onUpdated = event();
  const onRemoved = event();
  const sends: Array<{ tabId: number; message: unknown; frameId?: number }> = [];
  const injected: Array<{ tabId: number; files: string[] }> = [];
  let sendCount = 0;
  const chrome = {
    runtime: {
      onMessage,
      onConnect,
      lastError: undefined,
    },
    tabs: {
      onUpdated,
      onRemoved,
      sendMessage: async (tabId: number, message: unknown, options?: { frameId?: number }) => {
        sends.push({ tabId, message, frameId: options?.frameId });
        sendCount += 1;
        if (sendCount === 1) throw new Error('runner not present');
      },
    },
    scripting: {
      executeScript: async (args: { target: { tabId: number; frameIds: number[] }; files: string[] }) => {
        injected.push({ tabId: args.target.tabId, files: args.files });
      },
    },
  };
  return { chrome, onMessage, onConnect, onUpdated, onRemoved, sends, injected };
}

function listener<T extends (...args: any[]) => unknown>(e: Event<T>): T {
  assert.equal(e.listeners.length, 1);
  return e.listeners[0]!;
}

async function askClaim(
  handler: (...args: any[]) => unknown,
  request: unknown,
  sender: { tab?: { id?: number }; frameId?: number; url?: string },
) {
  return new Promise<any>((resolve) => {
    const returned = handler(request, sender, resolve);
    assert.equal(returned, true);
  });
}

test('Safari claims use the browser sender and replay without minting a second run', async () => {
  const { chrome, onMessage } = chromeMock();
  (globalThis as any).chrome = chrome;
  const handled: unknown[] = [];
  const adapter = createExecAdapter({
    handleGm: async (message) => {
      handled.push(message);
      return 'ok';
    },
    loadMods: async () => [mod()],
    loadGmValues: async () => ({ seen: false }),
  });
  assert.equal(adapter.engine, 'content-script');
  adapter.install();
  const handler = listener(onMessage);
  const request = { __usermodsExec: 'claim', docKey: 'doc-1', url: 'https://allowed.example/', topFrame: true };

  const spoofed = await askClaim(handler, { ...request, docKey: 'spoofed' }, { tab: { id: 7 }, frameId: 0, url: 'https://evil.example/' });
  assert.deepEqual(spoofed.scripts, [], 'a page cannot choose its own matching URL');

  const first = await askClaim(handler, request, { tab: { id: 7 }, frameId: 0, url: 'https://allowed.example/' });
  assert.equal(first.scripts.length, 1);
  assert.ok(first.scripts[0].token);
  assert.match(first.scripts[0].code, /__usermodsBridge/);

  const replay = await askClaim(handler, request, { tab: { id: 7 }, frameId: 0, url: 'https://allowed.example/' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.scripts[0].token, first.scripts[0].token);

  const forged = await askClaim(
    handler,
    { __usermodsExec: 'gm', call: 'gm.setValue', token: first.scripts[0].token, modId: 'other-mod', key: 'x', value: 1 },
    { tab: { id: 7 }, frameId: 2, url: 'https://allowed.example/' },
  );
  assert.match(forged.error, /not allowed/);
  assert.equal(handled.length, 0, 'a token from another frame never reaches privileged handling');

  const accepted = await askClaim(
    handler,
    { __usermodsExec: 'gm', call: 'gm.setValue', token: first.scripts[0].token, modId: 'other-mod', key: 'x', value: 1 },
    { tab: { id: 7 }, frameId: 0, url: 'https://allowed.example/' },
  );
  assert.deepEqual(accepted, { result: 'ok' });
  assert.equal((handled[0] as { modId: string }).modId, 'mod-a');
});

test('sync revokes a disabled mod and Try injects the runner by file path only', async () => {
  const { chrome, onMessage, sends, injected } = chromeMock();
  (globalThis as any).chrome = chrome;
  const adapter = createExecAdapter({
    handleGm: async () => 'ok',
    loadMods: async () => [mod()],
    loadGmValues: async () => ({}),
  });
  adapter.install();
  const handler = listener(onMessage);
  const claim = await askClaim(
    handler,
    { __usermodsExec: 'claim', docKey: 'doc-2', url: 'https://allowed.example/', topFrame: true },
    { tab: { id: 8 }, frameId: 0, url: 'https://allowed.example/' },
  );
  const gm = await askClaim(
    handler,
    { __usermodsExec: 'gm', call: 'gm.log', token: claim.scripts[0].token },
    { tab: { id: 8 }, frameId: 0, url: 'https://allowed.example/' },
  );
  assert.deepEqual(gm, { result: 'ok' });

  await adapter.sync([], async () => ({}));
  const revoked = await askClaim(
    handler,
    { __usermodsExec: 'gm', call: 'gm.log', token: claim.scripts[0].token },
    { tab: { id: 8 }, frameId: 0, url: 'https://allowed.example/' },
  );
  assert.match(revoked.error, /not allowed/);

  await adapter.injectOnce(8, 'alert(1)', 'USER_SCRIPT');
  assert.equal(sends.length, 2);
  assert.deepEqual(injected, [{ tabId: 8, files: ['content-scripts/modrunner.js'] }]);
  assert.match(String((sends[0]!.message as { code: string }).code), /alert\(1\)/);
  assert.equal((sends[0]!.message as { world: string }).world, 'USER_SCRIPT');
});
