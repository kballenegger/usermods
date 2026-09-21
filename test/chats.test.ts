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
  setChatThinking,
  sortChats,
  titleFromText,
  createChat,
  getChat,
  type Chat,
} from '../lib/chats.ts';
import type { Msg } from '../lib/types.ts';

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

/** Install the fake for one test and take it back down, so tests do not leak into each other. */
async function withStorage<T>(initial: Record<string, unknown>, fn: (s: ReturnType<typeof fakeStorage>) => Promise<T>): Promise<T> {
  const s = fakeStorage(initial);
  const g = globalThis as { chrome?: unknown };
  const had = 'chrome' in g;
  const before = g.chrome;
  g.chrome = { storage: { local: s.local } };
  try {
    return await fn(s);
  } finally {
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

// ---------- the per-chat Thinking level ----------

test('a chat stores the Thinking level it was created with, and default writes no field', async () => {
  await withStorage({}, async () => {
    const plain = await createChat('example.com', null);
    assert.equal('thinking' in plain, false, 'a chat created with no level must not carry the field');

    const explicit = await createChat('example.com', null, 'high');
    assert.equal(explicit.thinking, 'high');

    const defaulted = await createChat('example.com', null, 'default');
    assert.equal('thinking' in defaulted, false, "'default' is the absence of the field, not a stored value");
  });
});

test('setChatThinking writes the level, and setting it back to default removes it', async () => {
  await withStorage({}, async () => {
    const chat = await createChat('example.com', null);
    await setChatThinking(chat.id, 'low');
    assert.equal((await getChat(chat.id))?.thinking, 'low');

    // Back to default: the record becomes indistinguishable from one never touched, so the stored
    // shape does not grow a field for every chat that was merely looked at.
    await setChatThinking(chat.id, 'default');
    const back = await getChat(chat.id);
    assert.equal(back?.thinking, undefined);
    assert.equal('thinking' in back!, false);
  });
});

test('setting the Thinking level is not activity: it does not reorder or unarchive', async () => {
  await withStorage({}, async () => {
    const chat = await createChat('example.com', null);
    const before = (await getChat(chat.id))!;
    await setChatThinking(chat.id, 'max');
    const after = (await getChat(chat.id))!;
    assert.equal(after.updatedAt, before.updatedAt, 'choosing a level must not bump updatedAt');
  });
});

test('an unknown Thinking level on a stored chat is simply carried, not crashed on', async () => {
  // Storage is shared with other builds and can hold a level this one does not know. It reads back
  // as-is here; applyThinking is what refuses to put it on the wire (test/thinking.test.ts).
  await withStorage({ chats: [{ id: 'x', host: 'example.com', title: 't', createdAt: 1, updatedAt: 1, thinking: 'xhigh' }] }, async () => {
    assert.equal((await getChat('x'))?.thinking, 'xhigh');
  });
});
