// The transcript reducer and the per-chat session map: the two pieces the chat-isolation fix rests
// on. Both are pure, so the whole "chat A's output must never reach chat B" rule is testable here
// without a browser; the browser half is scripts/screenshots.mjs --isolation.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { GAP_TOOL_SUMMARY, RECONNECT_NOTE, hasRowGap, lastModel, looksUnfinished, modelRowText, reduceItems, repairRowGap, unqueuedItem } from '../lib/transcript.ts';
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

// ---------- looksUnfinished: the evidence both settleInterrupted and the row-gap rule read ----------

test('a transcript is unfinished while a tool row has no result or a message is still queued', () => {
  assert.equal(looksUnfinished([{ kind: 'tool', id: 't', name: 'n', input: {} }]), true);
  assert.equal(looksUnfinished([{ kind: 'user', id: 'u', text: 'x', queued: true }]), true);
  assert.equal(looksUnfinished([{ kind: 'tool', id: 't', name: 'n', input: {}, summary: 'ok' }]), false);
  assert.equal(looksUnfinished([{ kind: 'assistant', text: 'done' }]), false);
  assert.equal(looksUnfinished([]), false);
});

test('text after a note row starts a new assistant row', () => {
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

// ---------- which model produced which turns ----------

test('a run records its model once, and a later run on the same model adds nothing', () => {
  let items: ChatItem[] = [{ kind: 'user', id: 'u1', text: 'hi' }];
  const demo: AgentEventBody = { type: 'model', connectionId: 'a', label: 'Local', model: 'demo' };
  items = reduceItems(items, demo);
  assert.deepEqual(items[1], { kind: 'model', connectionId: 'a', label: 'Local', model: 'demo' });
  items = reduceItems(items, { type: 'text', delta: 'hello' });
  const again = reduceItems(items, demo);
  assert.equal(again, items, 'the same array comes back, so an offscreen chat schedules no write');
  assert.deepEqual(lastModel(items), { kind: 'model', connectionId: 'a', label: 'Local', model: 'demo' });
  assert.equal(lastModel([]), null);
});

test('a swap adds a row where the model changed: a different model, or the same id on another provider', () => {
  let items: ChatItem[] = [];
  items = reduceItems(items, { type: 'model', connectionId: 'a', label: 'Local', model: 'demo' });
  items = reduceItems(items, { type: 'model', connectionId: 'a', label: 'Local', model: 'demo-mini' });
  items = reduceItems(items, { type: 'model', connectionId: 'b', label: 'Other', model: 'demo-mini' });
  items = reduceItems(items, { type: 'model', connectionId: 'b', label: 'Other renamed', model: 'demo-mini' });
  assert.deepEqual(items.map((i) => (i.kind === 'model' ? `${i.connectionId}/${i.model}` : i.kind)), ['a/demo', 'a/demo-mini', 'b/demo-mini']);
});

test('the panel says nothing for the model a chat started on, and "switched to" for every change', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'hi' },
    { kind: 'model', connectionId: 'a', label: 'Local', model: 'demo' },
    { kind: 'assistant', text: 'hello' },
    { kind: 'model', connectionId: 'b', label: 'Anthropic', model: 'claude-opus-5' },
    { kind: 'model', connectionId: 'c', label: '', model: 'bare' },
  ];
  assert.equal(modelRowText(items, 1), null);
  assert.equal(modelRowText(items, 1, { showFirst: true }), 'model: demo · Local');
  assert.equal(modelRowText(items, 3), 'switched to claude-opus-5 · Anthropic');
  assert.equal(modelRowText(items, 4), 'switched to bare');
  assert.equal(modelRowText(items, 0), null, 'not a model row');
});

test('a model row does not break the streaming of the reply that follows it', () => {
  let items: ChatItem[] = [];
  items = reduceItems(items, { type: 'model', connectionId: 'a', label: 'L', model: 'm' });
  items = reduceItems(items, { type: 'text', delta: 'one ' });
  items = reduceItems(items, { type: 'text', delta: 'two' });
  items = reduceItems(items, { type: 'text_discard', chars: 3 });
  assert.deepEqual(items, [{ kind: 'model', connectionId: 'a', label: 'L', model: 'm' }, { kind: 'assistant', text: 'one ' }]);
});

// ---------- the "rows are missing" note: only when rows really are, and only what is true ----------

const DANGLING: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'hide the banner' },
  { kind: 'assistant', text: 'Reading the page.' },
  { kind: 'tool', id: 't1', name: 'get_page', input: {} },
];
const IDLE = { running: false, interrupted: false };

test('a complete transcript has no gap, whatever the chat is doing', () => {
  const done: ChatItem[] = [{ kind: 'user', id: 'u', text: 'x' }, { kind: 'tool', id: 't', name: 'get_page', input: {}, summary: 'ok' }, { kind: 'assistant', text: 'done' }];
  for (const state of [IDLE, { running: true, interrupted: false }, { running: false, interrupted: true }]) {
    assert.equal(hasRowGap(done, state), false);
    assert.equal(repairRowGap(done, state), done, 'the same array: nothing to write back');
  }
  assert.equal(hasRowGap([], IDLE), false);
});

test('a tool row with no result is NOT a gap while the chat is running: that tool is running now', () => {
  // The path the old check got wrong: a chat that started after the panel attached, switched away
  // from and back to. It was told its output "was not captured" while it was being captured.
  assert.equal(hasRowGap(DANGLING, { running: true, interrupted: false }), false);
  assert.equal(repairRowGap(DANGLING, { running: true, interrupted: false }), DANGLING);
});

test('…and not after an interruption either: that case has its own, truer account', () => {
  // settleInterrupted closes those rows and the chat says "This run was interrupted." with Resume.
  assert.equal(hasRowGap(DANGLING, { running: false, interrupted: true }), false);
  assert.equal(repairRowGap(DANGLING, { running: false, interrupted: true }), DANGLING);
});

test('a row still claiming to be in progress when nothing is running IS a gap, and is repaired once', () => {
  assert.equal(hasRowGap(DANGLING, IDLE), true);
  const repaired = repairRowGap(DANGLING, IDLE);
  assert.deepEqual(repaired, [
    DANGLING[0],
    DANGLING[1],
    // Closed, and not as an error: the tool ran and the model got its result. Only this row missed it.
    { kind: 'tool', id: 't1', name: 'get_page', input: {}, summary: GAP_TOOL_SUMMARY },
    { kind: 'note', text: RECONNECT_NOTE },
  ]);
  assert.equal(looksUnfinished(repaired), false);
  // Once: the repaired transcript is what gets stored, and loading it again adds nothing.
  assert.equal(repairRowGap(repaired, IDLE), repaired);
  assert.equal(repaired.filter((i) => i.kind === 'note').length, 1);
});

test('a bubble left marked queued with nothing running is the same gap, and stops saying queued', () => {
  const items: ChatItem[] = [{ kind: 'assistant', text: 'done' }, { kind: 'user', id: 'u2', text: 'also the footer', queued: true }];
  const repaired = repairRowGap(items, IDLE);
  assert.deepEqual(repaired[1], { kind: 'user', id: 'u2', text: 'also the footer' });
  assert.deepEqual(repaired[2], { kind: 'note', text: RECONNECT_NOTE });
  assert.equal(items[1]?.kind === 'user' && items[1].queued, true, 'the input is not mutated');
});

test('the note does not repeat the old false claim that the run output was lost', () => {
  // The old wording said the run's OUTPUT was lost, which has not been true since the background
  // began keeping the transcript itself.
  assert.doesNotMatch(RECONNECT_NOTE, /not captured|earlier output/);
});

// ---------- how much the model was asked to think ----------

test('a change of Thinking level records a row, even on the same model', () => {
  let items = reduceItems([], { type: 'model', connectionId: 'a', label: 'Local', model: 'demo' });
  // The same model at the same level again: nothing new to say.
  items = reduceItems(items, { type: 'model', connectionId: 'a', label: 'Local', model: 'demo' });
  assert.equal(items.length, 1);
  // The level changed, which is the other half of "what answered this".
  items = reduceItems(items, { type: 'model', connectionId: 'a', label: 'Local', model: 'demo', thinking: 'high' });
  assert.equal(items.length, 2);
  assert.equal(items[1] && items[1].kind === 'model' ? items[1].thinking : null, 'high');
  // And once it is recorded, the same level again adds nothing.
  items = reduceItems(items, { type: 'model', connectionId: 'a', label: 'Local', model: 'demo', thinking: 'high' });
  assert.equal(items.length, 2);
});

test("'default' is the absence of a level, not a value that produces rows", () => {
  let items = reduceItems([], { type: 'model', connectionId: 'a', label: 'Local', model: 'demo' });
  items = reduceItems(items, { type: 'model', connectionId: 'a', label: 'Local', model: 'demo', thinking: 'default' });
  assert.equal(items.length, 1, "'default' must read as the same state as no level at all");
});

test('a level-only change reads as the level, not as a swap to the model it is already on', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'go' },
    { kind: 'model', connectionId: 'a', label: 'Local', model: 'demo' },
    { kind: 'user', id: 'u2', text: 'again' },
    { kind: 'model', connectionId: 'a', label: 'Local', model: 'demo', thinking: 'high' },
    { kind: 'user', id: 'u3', text: 'more' },
    { kind: 'model', connectionId: 'b', label: 'Other', model: 'alt', thinking: 'low' },
  ];
  // Same model, new level: saying "switched to demo" would name a swap that never happened.
  assert.equal(modelRowText(items, 3), 'thinking: high');
  // A real swap that also carries a level says both.
  assert.equal(modelRowText(items, 5), 'switched to alt · Other · thinking: low');
  // The first row still says nothing in the panel, and names both in the dashboard's preview.
  assert.equal(modelRowText(items, 1), null);
  assert.equal(modelRowText(items, 1, { showFirst: true }), 'model: demo · Local');
});
