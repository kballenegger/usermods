// The pure parts of the chat index: which chat the panel restores on open, how the switcher splits
// live from archived, and which chats the 200-chat cap evicts first.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { archivedChats, capChats, countTurns, isArchived, liveChats, pickChatToShow, sortChats, titleFromText, type Chat } from '../lib/chats.ts';
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
