// The transcript reducer and the per-chat session map: the two pieces the chat-isolation fix rests
// on. Both are pure, so the whole "chat A's output must never reach chat B" rule is testable here
// without a browser; the browser half is scripts/screenshots.mjs --isolation.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { RECONNECT_NOTE, looksUnfinished, reduceItems, unqueuedItem } from '../lib/transcript.ts';
import { SessionMap } from '../lib/sessions.ts';
import type { AgentEventBody, ChatItem, ModProposal, UserTurn } from '../lib/types.ts';

const proposal: ModProposal = { name: 'Demo', description: 'd', matches: ['*://e.com/*'], code: 'x' };
const turn = (id: string, text = id): UserTurn => ({ id, text });

// ---------- reduceItems: every event type ----------

test('text starts an assistant row, and further deltas append to that same row', () => {
  let items: ChatItem[] = [];
  items = reduceItems(items, { type: 'text', delta: 'Hel' });
  items = reduceItems(items, { type: 'text', delta: 'lo' });
  assert.deepEqual(items, [{ kind: 'assistant', text: 'Hello' }]);
});

test('text after a tool row starts a NEW assistant row rather than reopening the old one', () => {
  let items: ChatItem[] = [{ kind: 'assistant', text: 'first' }];
  items = reduceItems(items, { type: 'tool_call', id: 't1', name: 'get_page', input: {} });
  items = reduceItems(items, { type: 'text', delta: 'second' });
  assert.deepEqual(items.map((i) => i.kind), ['assistant', 'tool', 'assistant']);
  assert.equal((items[0] as { text: string }).text, 'first');
  assert.equal((items[2] as { text: string }).text, 'second');
});

test('tool_call appends a pending row and tool_result fills in that row by id', () => {
  let items: ChatItem[] = [];
  items = reduceItems(items, { type: 'tool_call', id: 't1', name: 'get_page', input: { max_chars: 10 } });
  items = reduceItems(items, { type: 'tool_call', id: 't2', name: 'get_styles', input: {} });
  items = reduceItems(items, { type: 'tool_result', id: 't2', summary: 'ok', isError: false });
  const tools = items.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.summary, undefined, 't1 must still be pending');
  assert.equal(tools[1]?.summary, 'ok');
  assert.equal(tools[1]?.isError, false);
});

test('a tool_result for an id that is not in this transcript changes nothing at all', () => {
  // This is the safety net behind routing: an event that reached the wrong chat must be inert.
  const items: ChatItem[] = [{ kind: 'tool', id: 'mine', name: 'get_page', input: {} }];
  const next = reduceItems(items, { type: 'tool_result', id: 'someone-elses', summary: 'leak', isError: false });
  assert.equal(next, items, 'the very same array should come back, so no write is scheduled');
});

test('proposal appends a proposal card', () => {
  const items = reduceItems([], { type: 'proposal', proposal });
  assert.deepEqual(items, [{ kind: 'proposal', proposal }]);
});

test('a new proposal card carries no saved-ness of its own: that is read from the draft', () => {
  // The bug the owner hit was a `saved` flag on the row. Nothing here may write one — the card's
  // state comes from the artifact (lib/artifact.ts:proposalCardState), fresh on every render.
  const first = reduceItems([], { type: 'proposal', proposal });
  const stamped = reduceItems(first, { type: 'artifact', version: 1 });
  const second = reduceItems(stamped, { type: 'proposal', proposal: { ...proposal, code: 'revised' } });
  const card = second[second.length - 1] as Extract<ChatItem, { kind: 'proposal' }>;
  assert.equal(card.proposal.code, 'revised');
  assert.ok(!('saved' in card), 'the reducer must not put a saved flag on a proposal row');
});

test('a second proposal is stamped with its OWN version, leaving the first card on its own', () => {
  let items = reduceItems([], { type: 'proposal', proposal });
  items = reduceItems(items, { type: 'artifact', version: 1 });
  items = reduceItems(items, { type: 'proposal', proposal: { ...proposal, code: 'revised' } });
  items = reduceItems(items, { type: 'artifact', version: 2 });
  const versions = items.filter((it) => it.kind === 'proposal').map((it) => (it as Extract<ChatItem, { kind: 'proposal' }>).version);
  assert.deepEqual(versions, [1, 2], 'each card names the version it became');
});

test('a re-proposal the draft de-duped is stamped with the version it de-duped into', () => {
  // addVersion collapses an identical consecutive proposal, so the background reports the SAME
  // number twice. The new row still has to be stamped: an unversioned card cannot join to the panel.
  let items = reduceItems([], { type: 'proposal', proposal });
  items = reduceItems(items, { type: 'artifact', version: 1 });
  items = reduceItems(items, { type: 'proposal', proposal });
  items = reduceItems(items, { type: 'artifact', version: 1 });
  const versions = items.filter((it) => it.kind === 'proposal').map((it) => (it as Extract<ChatItem, { kind: 'proposal' }>).version);
  assert.deepEqual(versions, [1, 1]);
});

test('accepted clears the queued flag on its own message and leaves the others alone', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'a', text: 'first', queued: true },
    { kind: 'user', id: 'b', text: 'second', queued: true },
  ];
  const next = reduceItems(items, { type: 'accepted', id: 'b' });
  assert.equal((next[0] as { queued?: boolean }).queued, true);
  assert.equal((next[1] as { queued?: boolean }).queued, false);
});

test('accepted for a message this transcript does not hold is inert', () => {
  const items: ChatItem[] = [{ kind: 'user', id: 'a', text: 'mine', queued: true }];
  assert.equal(reduceItems(items, { type: 'accepted', id: 'elsewhere' }), items);
});

test('unqueued drops the message bubble, and unqueuedItem hands its text back first', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'a', text: 'kept' },
    { kind: 'user', id: 'b', text: 'dropped', refs: [{ token: 'x', selector: '#x', html: '<i>', label: 'x' }], queued: true },
  ];
  assert.equal(unqueuedItem(items, 'b')?.text, 'dropped');
  const next = reduceItems(items, { type: 'unqueued', id: 'b' });
  assert.deepEqual(next.map((i) => (i as { id?: string }).id), ['a']);
});

test('unqueued for a message belonging to another chat is inert', () => {
  const items: ChatItem[] = [{ kind: 'user', id: 'a', text: 'mine' }];
  assert.equal(unqueuedItem(items, 'b'), undefined);
  assert.equal(reduceItems(items, { type: 'unqueued', id: 'b' }), items);
});

test('error appends an error row, done changes nothing', () => {
  const withError = reduceItems([], { type: 'error', message: 'boom' });
  assert.deepEqual(withError, [{ kind: 'error', text: 'boom' }]);
  assert.equal(reduceItems(withError, { type: 'done' }), withError);
});

test("running out of steps is a note, not an error — it must not read as something that went wrong", () => {
  const items = reduceItems([{ kind: 'assistant', text: 'still looking' }], { type: 'stopped', reason: 'max_steps', steps: 30 });
  assert.deepEqual(items[items.length - 1], { kind: 'note', text: 'stopped after 30 steps \u00b7 send a message to continue' });
  // The panel renders 'error' rows red and 'note' rows muted, so the kind is the whole point here.
  assert.equal(items.some((it) => it.kind === 'error'), false);
});

test('reduceItems never mutates the array it is given', () => {
  const items: ChatItem[] = [{ kind: 'assistant', text: 'a' }];
  const snapshot = structuredClone(items);
  reduceItems(items, { type: 'text', delta: 'b' });
  reduceItems(items, { type: 'tool_call', id: 't', name: 'n', input: {} });
  assert.deepEqual(items, snapshot);
});

test('two chats reduced from the same events by id stay completely separate', () => {
  // The panel does exactly this: route by chatId, reduce into that chat's own items.
  const stream: Array<{ chatId: string; body: AgentEventBody }> = [
    { chatId: 'A', body: { type: 'text', delta: 'AAA' } },
    { chatId: 'B', body: { type: 'text', delta: 'BBB' } },
    { chatId: 'A', body: { type: 'tool_call', id: 'ta', name: 'get_page', input: {} } },
    { chatId: 'B', body: { type: 'text', delta: ' more B' } },
    { chatId: 'A', body: { type: 'tool_result', id: 'ta', summary: 'A page', isError: false } },
    { chatId: 'B', body: { type: 'done' } },
    { chatId: 'A', body: { type: 'text', delta: ' tail A' } },
  ];
  const chats = new Map<string, ChatItem[]>([['A', []], ['B', []]]);
  for (const { chatId, body } of stream) chats.set(chatId, reduceItems(chats.get(chatId)!, body));

  const textOf = (id: string) => JSON.stringify(chats.get(id));
  assert.match(textOf('A'), /AAA/);
  assert.match(textOf('A'), /tail A/);
  assert.match(textOf('A'), /A page/);
  assert.doesNotMatch(textOf('A'), /BBB|more B/, "B's output must never appear in A");
  assert.match(textOf('B'), /BBB/);
  assert.doesNotMatch(textOf('B'), /AAA|tail A|A page/, "A's output must never appear in B");
});

// ---------- looksUnfinished, which drives the reconnect note ----------

test('a transcript is unfinished while a tool row has no result or a message is still queued', () => {
  assert.equal(looksUnfinished([{ kind: 'tool', id: 't', name: 'n', input: {} }]), true);
  assert.equal(looksUnfinished([{ kind: 'user', id: 'u', text: 'x', queued: true }]), true);
  assert.equal(looksUnfinished([{ kind: 'tool', id: 't', name: 'n', input: {}, summary: 'ok' }]), false);
  assert.equal(looksUnfinished([{ kind: 'assistant', text: 'done' }]), false);
  assert.equal(looksUnfinished([]), false);
});

test('the reconnect note is a note row, so it never reads as model output', () => {
  const items = reduceItems([{ kind: 'note', text: RECONNECT_NOTE }], { type: 'text', delta: 'resumed' });
  assert.deepEqual(items.map((i) => i.kind), ['note', 'assistant']);
});

// ---------- SessionMap: one run per chat, not one per panel ----------

test('a first message starts a run; a second message in the SAME chat queues behind it', () => {
  const s = new SessionMap();
  assert.equal(s.accept('A', 1, turn('m1')).start, true);
  s.get('A')!.running = true;
  const second = s.accept('A', 1, turn('m2'));
  assert.equal(second.start, false, 'the same chat still serialises');
  assert.deepEqual(second.session.queue.map((q) => q.id), ['m2']);
});

test('a message in another chat starts its own run instead of being queued onto the busy one', () => {
  // The production bug: B's message was pushed onto A's queue and injected into A's conversation.
  const s = new SessionMap();
  s.accept('A', 1, turn('m1'));
  s.get('A')!.running = true;
  const b = s.accept('B', 2, turn('m2'));
  assert.equal(b.start, true, 'B must run concurrently; it is on a different tab');
  assert.deepEqual(s.get('A')!.queue, [], "B's message must never touch A's queue");
  assert.equal(b.session.tabId, 2);
});

test('abort stops only the named chat, and returns only that chat’s dropped messages', () => {
  const s = new SessionMap();
  s.accept('A', 1, turn('a1'));
  const a = s.get('A')!;
  a.running = true;
  a.controller = new AbortController();
  s.accept('A', 1, turn('a2'));

  s.accept('B', 2, turn('b1'));
  const b = s.get('B')!;
  b.running = true;
  b.controller = new AbortController();
  s.accept('B', 2, turn('b2'));

  const dropped = s.abort('B');
  assert.deepEqual(dropped, ['b2']);
  assert.equal(b.controller.signal.aborted, true);
  assert.equal(a.controller.signal.aborted, false, 'Stop in B must not abort A');
  assert.deepEqual(a.queue.map((q) => q.id), ['a2'], "A's queue must survive B's Stop");
});

test('aborting a chat with nothing running is harmless', () => {
  const s = new SessionMap();
  assert.deepEqual(s.abort('nobody'), []);
});

test('a session is released once its run is over and its queue is empty, but not before', () => {
  const s = new SessionMap();
  s.accept('A', 1, turn('m1'));
  const a = s.get('A')!;
  a.running = true;
  s.release('A');
  assert.ok(s.get('A'), 'a running chat keeps its session');
  a.running = false;
  a.queue.push(turn('m2'));
  s.release('A');
  assert.ok(s.get('A'), 'a chat with a queued message keeps its session');
  a.queue.length = 0;
  s.release('A');
  assert.equal(s.get('A'), undefined);
});

test('a chat may be re-targeted at a new tab between runs, but never during one', () => {
  const s = new SessionMap();
  s.accept('A', 1, turn('m1'));
  const a = s.get('A')!;
  a.running = true;
  s.ensure('A', 99);
  assert.equal(a.tabId, 1, 'a run keeps driving the tab it started on');
  a.running = false;
  s.ensure('A', 99);
  assert.equal(a.tabId, 99);
});

test('isRunning and ids report per chat', () => {
  const s = new SessionMap();
  s.accept('A', 1, turn('m1'));
  s.get('A')!.running = true;
  s.accept('B', 2, turn('m2'));
  assert.equal(s.isRunning('A'), true);
  assert.equal(s.isRunning('B'), false);
  assert.equal(s.isRunning('C'), false);
  assert.deepEqual(s.ids().sort(), ['A', 'B']);
});
