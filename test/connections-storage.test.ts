// The storage half of lib/connections.ts and the per-chat selection in lib/chats.ts, over an
// in-memory chrome.storage.local: that a legacy profile is migrated in ONE write (the key never
// exists in neither place, or in both), that a fresh install is left alone, that a connection edit
// cannot undo a write that landed meanwhile, and that a chat keeps the model it was given.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChat, getChat, setChatModel } from '../lib/chats.ts';
import {
  CONNECTIONS_KEY,
  LEGACY_CONNECTION_ID,
  MODEL_CHOICE_KEY,
  loadConnections,
  loadModelChoice,
  loadSignedIn,
  mutateConnections,
  saveModelChoice,
  touchesConnections,
  updateConnection,
  type ConnectionsState,
} from '../lib/connections.ts';

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  const writes: Array<Record<string, unknown>> = [];
  const local = {
    async get(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      writes.push(structuredClone(items));
      Object.assign(data, structuredClone(items));
    },
    async remove(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
  };
  return { data, writes, local };
}

async function withStorage<T>(initial: Record<string, unknown>, fn: (s: ReturnType<typeof fakeStorage>) => Promise<T>): Promise<T> {
  const s = fakeStorage(initial);
  const g = globalThis as { chrome?: unknown };
  const before = g.chrome;
  g.chrome = { storage: { local: s.local } };
  try {
    return await fn(s);
  } finally {
    if (before === undefined) delete g.chrome;
    else g.chrome = before;
  }
}

const LEGACY = { provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', apiKey: 'sk-local', model: 'qwen', theme: 'light' };

test('a legacy profile is migrated in one write: connections in, provider fields out, last choice set', async () => {
  await withStorage({ settings: LEGACY }, async (s) => {
    const state = await loadConnections();
    assert.equal(state.list.length, 1);
    assert.equal(s.writes.length, 1, 'the migration must be a single storage write');
    assert.deepEqual(Object.keys(s.writes[0] ?? {}).sort(), [CONNECTIONS_KEY, MODEL_CHOICE_KEY, 'settings'].sort());
    assert.deepEqual(s.data.settings, { theme: 'light' });
    assert.equal((s.data[CONNECTIONS_KEY] as ConnectionsState).list[0]?.apiKey, 'sk-local');
    assert.deepEqual(await loadModelChoice(), { connectionId: LEGACY_CONNECTION_ID, model: 'qwen', label: 'LM Studio' });
    // The key now exists exactly once in the whole profile.
    assert.equal(JSON.stringify(s.data).split('sk-local').length - 1, 1);
  });
});

test('loading again migrates nothing and writes nothing', async () => {
  await withStorage({ settings: LEGACY }, async (s) => {
    const first = await loadConnections();
    const second = await loadConnections();
    assert.deepEqual(second, first);
    assert.equal(s.writes.length, 1);
  });
});

test('a fresh install, or a profile with only preferences, is read as empty and left untouched', async () => {
  await withStorage({}, async (s) => {
    assert.deepEqual(await loadConnections(), { v: 1, list: [] });
    assert.equal(s.writes.length, 0);
    assert.equal(await loadModelChoice(), null);
  });
  await withStorage({ settings: { theme: 'dark' } }, async (s) => {
    assert.deepEqual(await loadConnections(), { v: 1, list: [] });
    assert.equal(s.writes.length, 0);
  });
});

test('a legacy profile seeded AFTER a first empty read is still migrated (nothing was written to block it)', async () => {
  // What the browser harness does: the panel loads once on an empty profile, then the old-shape
  // settings are written, then it reloads.
  await withStorage({}, async (s) => {
    await loadConnections();
    s.data.settings = structuredClone(LEGACY);
    assert.equal((await loadConnections()).list[0]?.id, LEGACY_CONNECTION_ID);
  });
});

test('an edit is applied to the list as it is NOW, not as the editor last saw it', async () => {
  await withStorage({ settings: LEGACY }, async (s) => {
    await loadConnections();
    // Meanwhile the background caches a model listing on the same connection.
    const stored = s.data[CONNECTIONS_KEY] as ConnectionsState;
    s.data[CONNECTIONS_KEY] = updateConnection(stored, LEGACY_CONNECTION_ID, { models: { ids: ['a', 'b'], fetchedAt: 5 } });
    // …and Settings saves a key it was typing, from its older copy of the world.
    await mutateConnections((state) => updateConnection(state, LEGACY_CONNECTION_ID, { apiKey: 'sk-new' }));
    const after = (s.data[CONNECTIONS_KEY] as ConnectionsState).list[0];
    assert.equal(after?.apiKey, 'sk-new');
    assert.deepEqual(after?.models, { ids: ['a', 'b'], fetchedAt: 5 }, 'the cached listing was overwritten by a stale write');
  });
});

test('a mutation that changes nothing writes nothing, and concurrent mutations all land', async () => {
  await withStorage({ settings: LEGACY }, async (s) => {
    await loadConnections();
    const before = s.writes.length;
    await mutateConnections((state) => state);
    assert.equal(s.writes.length, before);
    await Promise.all([
      mutateConnections((state) => updateConnection(state, LEGACY_CONNECTION_ID, { label: 'Renamed' })),
      mutateConnections((state) => updateConnection(state, LEGACY_CONNECTION_ID, { apiKey: 'k2' })),
      mutateConnections((state) => updateConnection(state, LEGACY_CONNECTION_ID, { images: 'never' })),
    ]);
    const c = (s.data[CONNECTIONS_KEY] as ConnectionsState).list[0];
    assert.deepEqual([c?.label, c?.apiKey, c?.images], ['Renamed', 'k2', 'never']);
  });
});

test('the last choice round-trips, and garbage reads as none', async () => {
  await withStorage({}, async (s) => {
    await saveModelChoice({ connectionId: 'a', model: 'm', label: 'A' });
    assert.deepEqual(await loadModelChoice(), { connectionId: 'a', model: 'm', label: 'A' });
    s.data[MODEL_CHOICE_KEY] = { connectionId: 5 };
    assert.equal(await loadModelChoice(), null);
  });
});

test('signed in means a token record exists for that vendor', async () => {
  await withStorage({ 'oauth:xai': { access: 'x' } }, async () => {
    assert.deepEqual(await loadSignedIn(), { chatgpt: false, xai: true });
  });
});

test('which storage changes the picker has to follow', () => {
  assert.ok(touchesConnections({ connections: {} }));
  assert.ok(touchesConnections({ modelChoice: {} }));
  assert.ok(touchesConnections({ 'oauth:chatgpt': {} }));
  assert.ok(!touchesConnections({ chats: {}, mods: {} }));
});

// ---------- the chat's own selection ----------

test('a chat is created on the model the composer showed, and keeps it', async () => {
  await withStorage({}, async () => {
    const chat = await createChat('example.com', { connectionId: 'a', model: 'm1', label: 'A' });
    assert.deepEqual(chat.model, { connectionId: 'a', model: 'm1', label: 'A' });
    assert.deepEqual((await getChat(chat.id))?.model, { connectionId: 'a', model: 'm1', label: 'A' });
    const bare = await createChat('example.com');
    assert.equal(bare.model, undefined);
    assert.equal((await createChat('example.com', { connectionId: '', model: 'm' })).model, undefined);
  });
});

test('changing a chat\'s model is not activity: it does not reorder or unarchive', async () => {
  await withStorage({}, async (s) => {
    const chat = await createChat('example.com', { connectionId: 'a', model: 'm1' });
    const stored = s.data.chats as Array<{ id: string; updatedAt: number; archivedAt?: number }>;
    stored[0]!.updatedAt = 111;
    stored[0]!.archivedAt = 222;
    await setChatModel(chat.id, { connectionId: 'b', model: 'm2', label: 'B' });
    const after = await getChat(chat.id);
    assert.deepEqual(after?.model, { connectionId: 'b', model: 'm2', label: 'B' });
    assert.equal(after?.updatedAt, 111);
    assert.equal(after?.archivedAt, 222);
  });
});

test('setting the same model again, or on a chat that is gone, writes nothing', async () => {
  await withStorage({}, async (s) => {
    const chat = await createChat('example.com', { connectionId: 'a', model: 'm1', label: 'A' });
    const before = s.writes.length;
    await setChatModel(chat.id, { connectionId: 'a', model: 'm1', label: 'A' });
    await setChatModel('no-such-chat', { connectionId: 'a', model: 'm1' });
    assert.equal(s.writes.length, before);
  });
});
