// The pure parts of the chat index: which chat the panel restores on open, how the switcher splits
// live from archived, and which chats the 200-chat cap evicts first.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBulkArchive,
  archivedChats,
  bulkChats,
  capChats,
  countTurns,
  isArchived,
  itemsKey,
  liveChats,
  MAX_CHATS,
  messagesKey,
  pickChatToShow,
  sortChats,
  titleFromText,
  type Chat,
} from '../lib/chats.ts';
import {
  blobsKey,
  createChat,
  deleteChat,
  listChats,
  saveItems,
  saveMessages,
  setChatArtifact,
  touchChat,
} from '../lib/chats.ts';
import { artifactKey } from '../lib/artifact.ts';
import { clearTombstones, dropTombstoned, isTombstoned, TOMBSTONE_TTL_MS, tombstone, withKey } from '../lib/storagequeue.ts';
import type { ChatItem, Msg } from '../lib/types.ts';

/** A chat record with only the fields these functions read. */
function chat(id: string, updatedAt: number, archivedAt?: number): Chat {
  return { id, host: 'example.com', title: id, createdAt: updatedAt, updatedAt, ...(archivedAt === undefined ? {} : { archivedAt }) };
}

// ---------- the chat the panel shows on open ----------

test('the panel restores the most recently updated chat, not the most recently created', () => {
  const chats = [chat('old', 100), chat('newest', 300), chat('middle', 200)];
  assert.equal(pickChatToShow(chats)?.id, 'newest');
});

test('an archived chat is never the one restored, even when it is the most recent', () => {
  // The owner's rule: the last chat comes back until the user makes a new one or archives this one.
  const chats = [chat('live', 100), chat('archived-but-newer', 500, 600)];
  assert.equal(pickChatToShow(chats)?.id, 'live');
});

test('with every chat archived the panel opens empty rather than reopening an archived one', () => {
  assert.equal(pickChatToShow([chat('a', 100, 150), chat('b', 200, 250)]), null);
});

test('no chats on this host means an empty composer', () => {
  assert.equal(pickChatToShow([]), null);
});

// ---------- the switcher's two groups ----------

test('the switcher lists live chats newest first and archived ones separately', () => {
  const chats = [chat('a', 100), chat('b', 300, 400), chat('c', 200)];
  assert.deepEqual(liveChats(chats).map((c) => c.id), ['c', 'a']);
  assert.deepEqual(archivedChats(chats).map((c) => c.id), ['b']);
});

test('the Archived group is ordered by when each chat was archived, most recent first', () => {
  const chats = [chat('first', 10, 1000), chat('second', 20, 3000), chat('third', 30, 2000)];
  assert.deepEqual(archivedChats(chats).map((c) => c.id), ['second', 'third', 'first']);
});

test('archivedAt of 0 still counts as archived', () => {
  // Number(0) is falsy; the check has to be on the type, not the truthiness.
  assert.equal(isArchived(chat('a', 100, 0)), true);
  assert.equal(isArchived(chat('b', 100)), false);
  assert.equal(pickChatToShow([chat('a', 100, 0)]), null);
});

// ---------- the cap ----------

test('the cap keeps everything when the index is not over the limit', () => {
  const chats = [chat('a', 100), chat('b', 200)];
  const { kept, dropped } = capChats(chats, 3);
  assert.deepEqual(dropped, []);
  assert.deepEqual(kept.map((c) => c.id), ['b', 'a'], 'survivors come back newest first');
});

test('the cap evicts archived chats before live ones, oldest archived first', () => {
  const chats = [
    chat('live-old', 100),
    chat('live-new', 400),
    chat('arch-old', 200, 210),
    chat('arch-new', 300, 310),
  ];
  const { kept, dropped } = capChats(chats, 3);
  assert.deepEqual(dropped, ['arch-old'], 'the oldest archived chat goes first, though a live chat is older');
  assert.deepEqual(kept.map((c) => c.id), ['live-new', 'arch-new', 'live-old']);
});

test('once the archived chats are gone the cap falls back to the oldest live chats', () => {
  const chats = [chat('live-a', 100), chat('live-b', 200), chat('live-c', 300), chat('arch', 400, 500)];
  const { dropped } = capChats(chats, 2);
  assert.deepEqual(new Set(dropped), new Set(['arch', 'live-a']), 'the archived one, then the oldest live one');
});

test('with only live chats the cap is still oldest-first', () => {
  const chats = [chat('a', 100), chat('b', 200), chat('c', 300)];
  const { kept, dropped } = capChats(chats, 2);
  assert.deepEqual(dropped, ['a']);
  assert.deepEqual(kept.map((c) => c.id), ['c', 'b']);
});

test('with only archived chats the cap is oldest-first among them', () => {
  const chats = [chat('a', 100, 110), chat('b', 200, 210), chat('c', 300, 310)];
  const { dropped } = capChats(chats, 1);
  assert.deepEqual(new Set(dropped), new Set(['a', 'b']));
});

test('the cap drops exactly the overflow, no more', () => {
  const chats = Array.from({ length: 10 }, (_, i) => chat(`c${i}`, i * 10, i < 3 ? i * 10 + 1 : undefined));
  const { kept, dropped } = capChats(chats, 6);
  assert.equal(kept.length, 6);
  assert.equal(dropped.length, 4);
  assert.deepEqual(new Set(dropped), new Set(['c0', 'c1', 'c2', 'c3']), 'three archived, then the oldest live one');
});

// ---------- titles ----------

test('the switcher title comes from the first message, collapsed and truncated', () => {
  assert.equal(titleFromText('  hide   the\nsidebar  '), 'hide the sidebar');
  assert.equal(titleFromText(''), 'New chat');
  assert.equal(titleFromText('x'.repeat(100)).length, 60);
  assert.ok(titleFromText('x'.repeat(100)).endsWith('…'));
});

test('sortChats does not mutate its input', () => {
  const chats = [chat('a', 100), chat('b', 200)];
  sortChats(chats);
  assert.deepEqual(chats.map((c) => c.id), ['a', 'b']);
});

// ---------- turn counts, shown on the dashboard ----------

test('a chat\'s turn count is its user messages, not every message in the history', () => {
  const history: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'hide the sidebar' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'get_page', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: [] }] },
    { role: 'user', content: [{ type: 'text', text: 'and dim the images' }] },
  ];
  // The tool-result message is role 'user' too (that is how lib/agent/loop.ts feeds results back),
  // so counting user-role messages would say 3. Only the two the person actually typed are turns.
  assert.equal(countTurns(history), 2);
  assert.equal(countTurns([]), 0);
});

// ---------------------------------------------------------------------------
// Finding 10: every index writer goes through the cap
// ---------------------------------------------------------------------------
//
// createChat caps the index and deletes the evicted chats' transcript keys. bulkChats wrote the
// index raw, so it was the one writer that could leave the index over MAX_CHATS and leave orphaned
// chat:<id>:messages / chat:<id>:items keys behind it. These run the real function against an
// in-memory chrome.storage.local — the cap has to be exercised through the writer, because a test
// of capChats alone is exactly what passed while bulkChats was not calling it.

/** The smallest chrome.storage.local that lib/chats needs: get/set/remove over a plain object. */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const removed: string[] = [];
  const local = {
    async get(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, items);
    },
    async remove(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) {
        removed.push(k);
        delete data[k];
      }
    },
  };
  return { data, removed, local };
}

/**
 * Install the fake for one test and take it back down, so tests do not leak into each other.
 *
 * Tombstones are cleared at both ends. They are process-global by design (lib/storagequeue.ts), so
 * a chat evicted or deleted in one test would otherwise still be tombstoned in the next — and
 * since every test here reuses ids like 'c2', that silently changes what the next test's writers
 * are allowed to store. Clearing on the way IN as well as out means a test cannot be made to pass
 * or fail by whatever ran before it.
 */
async function withStorage<T>(initial: Record<string, unknown>, fn: (s: ReturnType<typeof fakeStorage>) => Promise<T>): Promise<T> {
  clearTombstones();
  const s = fakeStorage(initial);
  const g = globalThis as { chrome?: unknown };
  const had = 'chrome' in g;
  const before = g.chrome;
  g.chrome = { storage: { local: s.local } };
  try {
    return await fn(s);
  } finally {
    clearTombstones();
    if (had) g.chrome = before;
    else delete g.chrome;
  }
}

/** MAX_CHATS chats plus `extra` more, all live, newest last. */
function overCap(extra: number): Chat[] {
  return Array.from({ length: MAX_CHATS + extra }, (_, i) => chat(`c${i}`, 1000 + i));
}

test('finding 10: a bulk unarchive writes the index through the cap, like every other writer', async () => {
  // An index that is over MAX_CHATS by two — it can get here through an older build, a synced
  // profile, or simply a cap that ran when fewer chats were archived. Whatever put it there, the
  // writer that touches it next has to bring it back, and bulkChats was the one that did not.
  const chats = overCap(2).map((c, i) => (i < 5 ? { ...c, archivedAt: 500 + i } : c));
  await withStorage({ chats }, async (s) => {
    await bulkChats(['c0', 'c1'], 'unarchive');
    const stored = (s.data.chats as Chat[]) ?? [];
    assert.equal(stored.length, MAX_CHATS, `the index was left at ${stored.length}, over the ${MAX_CHATS} cap`);
    assert.equal(stored.some((c) => c.id === 'c0'), true, 'the chats the user just unarchived survive');
    assert.equal(stored.some((c) => c.id === 'c1'), true);
  });
});

test('finding 10: the chats a bulk write evicts lose their transcript keys too', async () => {
  // An orphaned chat:<id>:items is invisible and permanent: nothing lists it, nothing reads it, and
  // it counts against the storage quota forever.
  const chats = overCap(3);
  await withStorage({ chats }, async (s) => {
    await bulkChats(['c50'], 'archive');
    const stored = (s.data.chats as Chat[]) ?? [];
    assert.equal(stored.length, MAX_CHATS);
    const kept = new Set(stored.map((c) => c.id));
    const gone = chats.filter((c) => !kept.has(c.id)).map((c) => c.id);
    assert.equal(gone.length, 3, 'three chats over the cap, three evicted');
    for (const id of gone) {
      assert.ok(s.removed.includes(messagesKey(id)), `${id} kept an orphaned messages key`);
      assert.ok(s.removed.includes(itemsKey(id)), `${id} kept an orphaned items key`);
    }
  });
});

test('finding 10: a bulk action on an index inside the cap drops nothing', async () => {
  const chats = [chat('a', 100), chat('b', 200, 250), chat('c', 300)];
  await withStorage({ chats }, async (s) => {
    await bulkChats(['b'], 'unarchive');
    const stored = (s.data.chats as Chat[]) ?? [];
    assert.deepEqual(stored.map((c) => c.id).sort(), ['a', 'b', 'c']);
    assert.equal(stored.find((c) => c.id === 'b')?.archivedAt, undefined, 'unarchived');
    assert.deepEqual(s.removed, [], 'nothing was evicted, so no transcript key was removed');
  });
});

test('finding 10: bulk archive and unarchive touch only the named chats', () => {
  const chats = [chat('a', 100), chat('b', 200, 900), chat('c', 300)];
  const archived = applyBulkArchive(chats, new Set(['a']), 'archive', 4242);
  assert.equal(archived.find((c) => c.id === 'a')?.archivedAt, 4242);
  assert.equal(archived.find((c) => c.id === 'b')?.archivedAt, 900, 'an untouched chat keeps its own timestamp');
  assert.equal(archived.find((c) => c.id === 'c')?.archivedAt, undefined);
  const unarchived = applyBulkArchive(chats, new Set(['b']), 'unarchive', 4242);
  assert.equal(unarchived.find((c) => c.id === 'b')?.archivedAt, undefined);
  assert.equal('archivedAt' in unarchived.find((c) => c.id === 'b')!, false, 'the field is deleted, not set to undefined');
});

// ---------------------------------------------------------------------------
// User report: "deleting it does nothing. It shows up again if I reopen the window later"
// ---------------------------------------------------------------------------
//
// The chat index was written by nine functions, each doing its own unserialised read-modify-write
// of the 'chats' key. Any two overlapping lost an edit; when one of them was the DELETE, the lost
// edit was the deletion itself and the chat came back. These tests interleave a delete with the
// writers that run alongside it in real use — a background turn's touchChat, a proposal's
// setChatArtifact — by holding a read open across the delete, which is exactly what a storage
// round trip does.

/**
 * A fake storage whose reads can be held open, so a writer can be parked mid-cycle — between its
 * read and its write — while something else runs. That window is the bug; without a way to open it
 * deliberately, the race reproduces only by luck.
 */
function racyStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  /** Reads parked by key, each released by calling its resolver. */
  const gates = new Map<string, Array<() => void>>();
  let stall: ((key: string) => boolean) | null = null;
  const local = {
    async get(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      if (stall) {
        for (const k of keys) {
          if (!stall(k)) continue;
          await new Promise<void>((resolve) => {
            const waiting = gates.get(k) ?? [];
            waiting.push(resolve);
            gates.set(k, waiting);
          });
        }
      }
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    async remove(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
  };
  return {
    data,
    local,
    /** Stall every read of a key matching `pred` until release() is called. */
    stallReads(pred: (key: string) => boolean) {
      stall = pred;
    },
    /** Let every parked read through, and stop stalling. */
    release() {
      stall = null;
      for (const waiting of gates.values()) for (const resolve of waiting) resolve();
      gates.clear();
    },
    /** How many reads are parked right now. */
    parked() {
      return [...gates.values()].reduce((n, w) => n + w.length, 0);
    },
  };
}

async function withRacyStorage<T>(initial: Record<string, unknown>, fn: (s: ReturnType<typeof racyStorage>) => Promise<T>): Promise<T> {
  clearTombstones();
  const s = racyStorage(initial);
  const g = globalThis as { chrome?: unknown };
  const had = 'chrome' in g;
  const before = g.chrome;
  g.chrome = { storage: { local: s.local } };
  try {
    return await fn(s);
  } finally {
    clearTombstones();
    if (had) g.chrome = before;
    else delete g.chrome;
  }
}

/** Let queued microtasks and the awaits inside them run, without waiting on a real clock. */
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

test('a background turn that started before a delete cannot put the chat back on the index', async () => {
  // The exact report: a run is in flight (or a turn has just ended) and the user deletes the chat.
  // touchChat has already read the index — the chat is alive in its snapshot — and is about to
  // write it back. Before the fix, that write landed after the delete and the row reappeared, so
  // the next panel open on that site found the chat and restored it.
  const chats = [chat('doomed', 100), chat('other', 200)];
  await withRacyStorage({ chats }, async (s) => {
    // Park touchChat between its read and its write.
    s.stallReads((k) => k === 'chats');
    const inFlight = touchChat('doomed', { title: 'still working', url: 'https://example.com/x', turns: 4 });
    await settle();
    assert.equal(s.parked(), 1, 'touchChat should be parked mid-cycle, holding a pre-delete snapshot');

    // The user deletes it while that is parked.
    const deletion = deleteChat('doomed');
    await settle();

    // Everything lands, in whatever order the queue chooses.
    s.release();
    await Promise.all([inFlight, deletion]);

    const stored = (s.data.chats as Chat[]) ?? [];
    assert.equal(
      stored.some((c) => c.id === 'doomed'),
      false,
      'the deleted chat was written back to the index by the in-flight touchChat',
    );
    assert.deepEqual(stored.map((c) => c.id), ['other'], 'the other chat is untouched');
  });
});

test('a proposal landing after a delete cannot resurrect the chat either', async () => {
  // setChatArtifact is the other writer that runs on its own schedule: the model proposes a mod,
  // the background stores the artifact and notes it on the index. It deliberately does NOT go
  // through touchChat, so it was a second, independent way back onto the index.
  const chats = [chat('doomed', 100)];
  await withRacyStorage({ chats }, async (s) => {
    s.stallReads((k) => k === 'chats');
    const proposal = setChatArtifact('doomed', 'art-1', 2);
    await settle();
    const deletion = deleteChat('doomed');
    await settle();
    s.release();
    await Promise.all([proposal, deletion]);

    assert.deepEqual((s.data.chats as Chat[]) ?? [], [], 'the index is empty; nothing put the chat back');
  });
});

test('deleting a chat removes every key it owns, and a late transcript write does not recreate one', async () => {
  // The second half of the report ("it shows up again if I… visit the site"). Even with the index
  // clean, a debounced saveItems flushing after the delete recreates 'chat:<id>:items'. That key is
  // then orphaned forever — and while it existed, a panel that still held the chat in memory had
  // something to render.
  const items = [{ kind: 'user', id: 'u1', text: 'hello' }] as unknown as ChatItem[];
  const history: Msg[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
  await withRacyStorage(
    {
      chats: [chat('doomed', 100)],
      [messagesKey('doomed')]: history,
      [itemsKey('doomed')]: items,
      [blobsKey('doomed')]: { abc: { mediaType: 'image/png', data: 'x', width: 1, height: 1, bytes: 1 } },
      [artifactKey('doomed')]: { id: 'art-1', versions: [] },
    },
    async (s) => {
      await deleteChat('doomed');
      for (const key of [messagesKey('doomed'), itemsKey('doomed'), blobsKey('doomed'), artifactKey('doomed')]) {
        assert.equal(key in s.data, false, `${key} survived the delete`);
      }

      // The panel's pagehide flush, and the background's detached writer, arriving late.
      await saveItems('doomed', items);
      await saveMessages('doomed', history);
      assert.equal(itemsKey('doomed') in s.data, false, 'a late saveItems recreated the deleted transcript');
      assert.equal(messagesKey('doomed') in s.data, false, 'a late saveMessages recreated the deleted history');
    },
  );
});

test('a chat deleted on one host stays deleted when the panel next lists that host', async () => {
  // End to end through the public API, the way the panel sees it: create, use, delete, list again.
  await withRacyStorage({}, async (s) => {
    const made = await createChat('example.com');
    await touchChat(made.id, { title: 'customise the header', url: 'https://example.com/' });
    assert.equal((await listChats('example.com')).length, 1);

    s.stallReads((k) => k === 'chats');
    const late = touchChat(made.id, { turns: 2 });
    await settle();
    const deletion = deleteChat(made.id);
    await settle();
    s.release();
    await Promise.all([late, deletion]);

    assert.deepEqual(await listChats('example.com'), [], 'the site still lists the chat the user deleted');
    assert.equal(pickChatToShow(await listChats('example.com')), null, 'reopening the panel on that site restores it');
  });
});

test('a bulk delete survives the same race', async () => {
  const chats = [chat('a', 100), chat('b', 200), chat('c', 300)];
  await withRacyStorage({ chats }, async (s) => {
    s.stallReads((k) => k === 'chats');
    const late = touchChat('b', { turns: 9 });
    await settle();
    const deletion = bulkChats(['a', 'b'], 'delete');
    await settle();
    s.release();
    await Promise.all([late, deletion]);
    assert.deepEqual(((s.data.chats as Chat[]) ?? []).map((c) => c.id), ['c']);
  });
});

test('only the deleted chat is dropped: other chats written by an in-flight writer still land', async () => {
  // The tombstone must be surgical. A writer parked across a delete is writing the WHOLE index, so
  // a filter that threw the write away entirely would lose the edit it carried for every other
  // chat — trading a resurrection bug for a lost-update one.
  const chats = [chat('doomed', 100), chat('keeper', 200)];
  await withRacyStorage({ chats }, async (s) => {
    s.stallReads((k) => k === 'chats');
    const late = touchChat('keeper', { turns: 7, url: 'https://example.com/keeper' });
    await settle();
    const deletion = deleteChat('doomed');
    await settle();
    s.release();
    await Promise.all([late, deletion]);

    const stored = (s.data.chats as Chat[]) ?? [];
    assert.deepEqual(stored.map((c) => c.id), ['keeper']);
    assert.equal(stored[0]?.turns, 7, "the in-flight writer's edit to a surviving chat was thrown away");
    assert.equal(stored[0]?.url, 'https://example.com/keeper');
  });
});

// ---------------------------------------------------------------------------
// The queue and the tombstones themselves (lib/storagequeue.ts)
// ---------------------------------------------------------------------------

test('withKey runs same-key work one at a time and different keys concurrently', async () => {
  const order: string[] = [];
  const slow = (tag: string, ms: number) => async () => {
    order.push(`${tag}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${tag}:end`);
  };
  await Promise.all([withKey('k', slow('a', 20)), withKey('k', slow('b', 1))]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'], 'same key must not interleave');

  order.length = 0;
  await Promise.all([withKey('one', slow('a', 20)), withKey('two', slow('b', 1))]);
  assert.equal(order[0], 'a:start');
  assert.equal(order[1], 'b:start', 'a different key is not made to wait');
});

test('a failing write does not wedge the queue for that key', async () => {
  // One storage failure must not stop every later write to the same key. It would be a very quiet
  // way to lose a whole session's worth of edits.
  await assert.rejects(withKey('k', async () => { throw new Error('quota'); }), /quota/);
  assert.equal(await withKey('k', async () => 'ok'), 'ok');
});

test('a tombstone expires, so an id is not filtered forever', () => {
  clearTombstones();
  const t0 = 1_000_000;
  tombstone('x', t0);
  assert.equal(isTombstoned('x', t0 + 1000), true);
  assert.equal(isTombstoned('x', t0 + TOMBSTONE_TTL_MS + 1), false, 'the tombstone outlived its purpose');
  clearTombstones();
});

test('dropTombstoned returns its input untouched when nothing is tombstoned', () => {
  clearTombstones();
  const rows = [{ id: 'a' }, { id: 'b' }];
  assert.equal(dropTombstoned(rows), rows, 'the common case must not allocate a new array');
  tombstone('b');
  assert.deepEqual(dropTombstoned(rows).map((r) => r.id), ['a']);
  clearTombstones();
});
