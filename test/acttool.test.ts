// The act, note and ask_user tools through the real loop, against a fake provider: what the model is
// offered, what it is told, and the note surviving what would otherwise lose it.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { ACT_TOOLS, NEUTRAL_TOOLS, READ_TOOLS } from '../lib/agent/budget.ts';
import { runAgent, type AgentEnv, type OperateEnv } from '../lib/agent/loop.ts';
import { SYSTEM_PROMPT } from '../lib/agent/prompt.ts';
import { pageCard, emptyRecord, recordStep, scriptEffect, stepDone, stepLabel, type StepRow } from '../lib/agent/questions.ts';
import { TOOLS, toolsFor } from '../lib/agent/tools.ts';
import { activityFor, activityFromEvent, activityText, IDLE_ACTIVITY } from '../lib/activity.ts';
import type { Described } from '../lib/interact/describe.ts';
import type { Provider, ProviderResponse } from '../lib/providers/types.ts';
import { reduceItems } from '../lib/transcript.ts';
import type { AgentEventBody, ChatItem, Msg, Part, Settings } from '../lib/types.ts';

const SETTINGS = { provider: 'openai-compatible', baseUrl: 'http://unused.invalid/v1', apiKey: '', model: 'fake' } as Settings;
const call = (id: string, name: string, input: Record<string, unknown> = {}): Part => ({ type: 'tool_call', id, name, input });
const reply = (text: string, calls: Part[] = []): ProviderResponse => ({ content: [...(text ? [{ type: 'text', text } as Part] : []), ...calls], stopReason: calls.length ? 'tool_use' : 'end_turn' });

function fakeProvider(steps: ProviderResponse[]) {
  const requests: Msg[][] = [];
  const provider: Provider = {
    async chat({ messages }) {
      requests.push(structuredClone(messages));
      const s = steps.shift();
      if (!s) throw new Error('out of steps');
      return s;
    },
  };
  return { provider, requests };
}

function operate(over: Partial<OperateEnv> = {}): OperateEnv & { guards: number; log: string[] } {
  const log: string[] = [];
  const o = {
    guards: 0,
    log,
    guard: async () => {
      o.guards++;
    },
    act: async () => ({ text: 'acted', isError: false }),
    handoff: async () => ({ by: 'user' as const }),
    beforeScript: async () => true,
    afterScript: async () => void log.push('after-script'),
    recordWait: async () => {},
    recordAsk: async () => {},
    recordLook: async () => {},
    changeNote: async () => ({ ok: true as const, text: 'Noted.' }),
    ...over,
  };
  return o;
}

function env(op?: OperateEnv): AgentEnv & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    async sendToContent<T>(req: unknown): Promise<T> {
      ran.push((req as { type: string }).type);
      return { text: 'result' } as T;
    },
    async runScript() {
      ran.push('run_script');
      return { outcome: { kind: 'ok', returnedValue: false, dom: { added: 0, removed: 2, attributes: 0 } }, logs: [] };
    },
    async screenshot() {
      return { mediaType: 'image/png', data: 'AA' };
    },
    async pageInfo() {
      return { url: 'https://example.com/', title: 'Example' };
    },
    async wait() {
      ran.push('wait');
      return { matched: true, elapsedMs: 1 };
    },
    ...(op ? { operate: op } : {}),
  };
}

const run = (steps: ProviderResponse[], e: AgentEnv, extra: Partial<Parameters<typeof runAgent>[0]> = {}) => {
  const fake = fakeProvider(steps);
  const events: AgentEventBody[] = [];
  const done = runAgent({ settings: SETTINGS, history: [], turn: { id: 't', text: 'do it' }, pullQueued: () => [], env: e, emit: (x) => void events.push(x), signal: new AbortController().signal, provider: fake.provider, ...extra });
  return { done, events, requests: fake.requests };
};

test('a build with the flag on offers act, note, ask_user and the inventory', () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('act') && names.includes('note'));
  const wait = TOOLS.find((t) => t.name === 'wait_for')!.inputSchema as { properties: Record<string, unknown> };
  assert.ok('ask_user' in wait.properties);
  const find = TOOLS.find((t) => t.name === 'find_elements')!.inputSchema as { properties: Record<string, unknown> };
  assert.ok('operable' in find.properties);
  assert.equal(toolsFor(false).length, TOOLS.length);
  assert.match(SYSTEM_PROMPT, /## Operating the page/);
  assert.match(SYSTEM_PROMPT, /call wait_for with ask_user/);
  assert.match(SYSTEM_PROMPT, /collect data\) with act and report/);
  assert.doesNotMatch(SYSTEM_PROMPT, /holds such a step/, 'the guard is not built, so the prompt does not promise it');
});

test('act is an act, note is neutral, neither is a read', () => {
  assert.ok(ACT_TOOLS.has('act'));
  assert.ok(NEUTRAL_TOOLS.has('note'));
  assert.ok(!READ_TOOLS.has('act') && !READ_TOOLS.has('note'));
});

test('a malformed act costs nothing: the driver is never reached', async () => {
  let reached = 0;
  const e = env(operate({ act: async () => (reached++, { text: '', isError: false }) }));
  const r = run([reply('', [call('c1', 'act', { steps: [{ do: 'click' }], description: 'x' })]), reply('ok')], e);
  await r.done;
  assert.equal(reached, 0);
  const result = r.requests[1]!.at(-1)!.content.find((p) => p.type === 'tool_result') as Extract<Part, { type: 'tool_result' }>;
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /needs a target/);
});

test('act reaches the driver, and tool ids reach the rows', async () => {
  const seen: string[] = [];
  const e = env(operate({ act: async (_c, ctx) => (seen.push(ctx.toolId), { text: 'Clicked.', isError: false }) }));
  const r = run([reply('', [call('c1', 'act', { steps: [{ do: 'hover', target: '#a' }], description: 'look' })]), reply('ok')], e);
  await r.done;
  assert.deepEqual(seen, ['c1']);
  const status = r.events.find((x) => x.type === 'status' && x.tool === 'act') as Extract<AgentEventBody, { type: 'status' }>;
  assert.equal(status.detail, 'look');
});

test('the pauses come before every tool, and a stop there runs nothing', async () => {
  const stop = new AbortController();
  const op = operate({ guard: async () => stop.abort() });
  const e = env(op);
  const r = run([reply('', [call('c1', 'run_script', { code: 'x', description: 'y' })]), reply('never')], e, { signal: stop.signal });
  const out = await r.done;
  assert.ok(!e.ran.includes('run_script'), 'the script did not run');
  // The history stays valid: the call has an answer.
  const result = out.messages.at(-1)!.content.find((p) => p.type === 'tool_result');
  assert.ok(result, 'it is answered');
});

test('a declined script does not run, and the model is told so', async () => {
  const op = operate({ beforeScript: async () => false });
  const e = env(op);
  const r = run([reply('', [call('c1', 'run_script', { code: 'x', description: 'y' })]), reply('fine')], e);
  await r.done;
  assert.ok(!e.ran.includes('run_script'));
  assert.ok(!op.log.includes('after-script'), 'no journal entry was opened, so none is closed');
  assert.match(JSON.stringify(r.requests[1]!.at(-1)), /declined this script/);
});

test('the journal around a script is closed even when it throws', async () => {
  const op = operate();
  const e = env(op);
  e.runScript = async () => {
    throw new Error('boom');
  };
  const r = run([reply('', [call('c1', 'run_script', { code: 'x', description: 'y' })]), reply('fine')], e);
  await r.done;
  assert.ok(op.log.includes('after-script'));
});

test('a script that changed the page says so on its row; one that only looked does not', async () => {
  const e = env(operate());
  const r = run([reply('', [call('c1', 'run_script', { code: 'x', description: 'hide the modal' })]), reply('fine')], e);
  await r.done;
  const row = r.events.find((x) => x.type === 'tool_result') as Extract<AgentEventBody, { type: 'tool_result' }>;
  assert.equal(row.effect?.text, 'ran a script: hide the modal → 2 removed');
  assert.equal(scriptEffect('looked', { added: 0, removed: 0, attributes: 3 }), null, 'an attribute alone is no change to report as touched');
  assert.equal(scriptEffect('nothing', undefined), null);
});

test('ask_user is a handoff: no waiting charge, no 20 s, and a condition is optional', async () => {
  const calls: unknown[][] = [];
  const e = env(operate({ handoff: async (...a) => (calls.push(a.slice(0, 2)), { by: 'user' }) }));
  const r = run([reply('', [call('c1', 'wait_for', { ask_user: 'Sign in' })]), reply('', [call('c2', 'wait_for', { ask_user: 'Sign in', text: 'Your orders' })]), reply('ok')], e);
  await r.done;
  assert.equal(calls[0]![1], null);
  assert.equal((calls[1]![1] as { condition: { kind: string } }).condition.kind, 'text');
  assert.ok(!e.ran.includes('wait'), 'the ordinary wait is not what runs');
  assert.match(JSON.stringify(r.requests[1]!.at(-1)), /Look at the page before you carry on/);
});

test('ask_user with a bad condition is told so before the user is bothered', async () => {
  let asked = 0;
  const e = env(operate({ handoff: async () => (asked++, { by: 'user' }) }));
  const r = run([reply('', [call('c1', 'wait_for', { ask_user: 'x', url: 'a', text: 'b' })]), reply('ok')], e);
  await r.done;
  assert.equal(asked, 0);
});

test('the note rides on the first turn and on a queued one, and is read fresh', async () => {
  let note = 'first';
  const queue = [{ id: 'q', text: 'and this' }];
  const e = env(operate({ changeNote: async () => ((note = 'second'), { ok: true, text: 'Noted.' }) }));
  const r = run([reply('', [call('c1', 'note', { set: 'second' })]), reply('ok')], e, { note: () => (note ? `[NOTE ${note}]` : ''), pullQueued: () => queue.splice(0) });
  await r.done;
  assert.match(JSON.stringify(r.requests[0]![0]), /\[NOTE first\]/);
  assert.match(JSON.stringify(r.requests[1]!.at(-1)), /\[NOTE second\]/);
});

test('a compaction that swallows the turn does not swallow the note', async () => {
  const big = 'x'.repeat(40_000);
  const history: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: `[NOTE keep me] ${big}` }] },
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    { role: 'user', content: [{ type: 'text', text: big }] },
    { role: 'assistant', content: [{ type: 'text', text: big }] },
    { role: 'user', content: [{ type: 'text', text: big }] },
    { role: 'assistant', content: [{ type: 'text', text: big }] },
  ];
  const e = env(operate());
  const r = run([reply('ok')], e, {
    history,
    settings: { ...SETTINGS, contextBudget: 10_000 },
    note: () => '[NOTE keep me]',
    complete: async () => 'a summary',
    turn: { id: 't', text: 'go on' },
  });
  await r.done;
  assert.ok(r.events.some((x) => x.type === 'compacted'), 'this test is about a compaction, so one has to have happened');
  assert.match(JSON.stringify(r.requests[0]!.at(-1)), /\[NOTE keep me\]/);
});

test('a resume is told about a cut-off step, on the end of the conversation, and no tool runs for it', async () => {
  const e = env(operate());
  const history: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'buy it' }] },
    { role: 'assistant', content: [call('c1', 'act', { steps: [{ do: 'click', target: '#buy' }], description: 'buy' })] },
  ];
  let acts = 0;
  e.operate!.act = async () => (acts++, { text: '', isError: false });
  const r = run([reply('I will look first.')], e, { history, turn: null, resumeNote: '[cut off: click button "Buy"]' });
  const out = await r.done;
  assert.equal(acts, 0, 'nothing replays it');
  const last = r.requests[0]!.at(-1)!;
  assert.equal(last.role, 'user');
  assert.match(JSON.stringify(last), /cut off: click button/);
  assert.ok(!JSON.stringify(out.messages).includes('tool_call'), 'the unanswered call is gone from the history');
});

// ---------------------------------------------------------------------------
// The rows, the card, the line
// ---------------------------------------------------------------------------

const D = (name: string): Described => ({ role: 'button', name, tag: 'button', pageUrl: 'https://a.test/', fingerprint: { role: 'button', name, tag: 'button' } }) as Described;
const delta = (added = 0, removed = 0, urlAfter = 'https://a.test/') => ({ dom: { added, removed, attributes: 0 }, urlBefore: 'https://a.test/', urlAfter, newOperable: [] });

test('a step in the past tense says what happened and what was observed', () => {
  const ok = (over = {}) => ({ ok: true as const, text: '', described: D('x'), delta: delta(), ...over });
  assert.equal(stepDone({ do: 'click' }, D('Show more'), ok({ clicks: 12, delta: delta(120) })), 'clicked "Show more" ×12 → 120 added');
  assert.equal(stepDone({ do: 'fill', text: 'SECRET' }, D('Email'), ok()), 'filled "Email"');
  assert.equal(stepDone({ do: 'check', text: 'off' }, D('Remember'), ok()), 'unticked "Remember"');
  assert.equal(stepDone({ do: 'press', text: 'Enter' }, D('Search'), ok({ delta: delta(0, 0, 'https://a.test/r') })), 'pressed Enter in "Search" → the page moved on');
  assert.equal(stepLabel({ do: 'fill', text: 'SECRET' }, D('Email')), 'fill button "Email"');
});

test('steps land in the row of their call, one per index, and survive a reload as data', () => {
  let items: ChatItem[] = [{ kind: 'tool', id: 'c1', name: 'act', input: {} }, { kind: 'assistant', text: 'hi' }];
  const running: StepRow = { state: 'running', text: 'clicking "A"' };
  items = reduceItems(items, { type: 'act_step', id: 'c1', index: 0, step: running });
  items = reduceItems(items, { type: 'act_step', id: 'c1', index: 0, step: { state: 'done', text: 'clicked "A"' } });
  items = reduceItems(items, { type: 'act_step', id: 'c1', index: 1, step: running });
  const row = items[0] as Extract<ChatItem, { kind: 'tool' }>;
  assert.deepEqual(row.steps!.map((s) => s.state), ['done', 'running']);
  assert.equal(reduceItems(items, { type: 'act_step', id: 'nope', index: 0, step: running }), items);
  assert.equal(reduceItems(items, { type: 'question', question: { kind: 'bar-removed', id: 'x' } }), items, 'a question is not a transcript row');
  assert.equal(reduceItems(items, { type: 'question_done', id: 'x' }), items);
  const card = pageCard(recordStep(emptyRecord(0), { do: 'click' }, 'clicked "A"', 1), 'model', 1000)!;
  assert.equal(reduceItems(items, { type: 'page_card', card }).at(-1)!.kind, 'page_card');
  assert.equal(JSON.parse(JSON.stringify(items)).length, 2);
});

test('the card is labelled by how the run ended, and says nothing of whether it worked', () => {
  const rec = recordStep(emptyRecord(0), { do: 'click' }, 'clicked "A"', 9);
  assert.equal(pageCard(rec, 'model', 1000)!.label, 'on the page · 9 actions');
  assert.equal(pageCard(rec, 'stopped', 1000)!.label, 'stopped by you · 9 actions');
  assert.equal(pageCard(rec, 'ceiling', 1000)!.label, 'paused at 30 steps · 9 actions');
  assert.equal(pageCard(emptyRecord(0), 'model', 1000), null);
  assert.doesNotMatch(JSON.stringify(pageCard(rec, 'model', 1000)), /\bdone\b/);
});

test('a line waiting on the user holds still, in the warn tone, however long it takes', () => {
  const a = activityFor({ phase: 'waiting-user', detail: 'your turn · sign in', elapsed: 500_000, sinceLastEvent: 500_000 })!;
  assert.equal(a.tone, 'warn');
  assert.equal(a.pulse, false);
  assert.equal(activityText(a), 'your turn · sign in');
  assert.doesNotMatch(activityText(a), /stuck/);
});

test('a step on the page has the pointer and the driving words, and driving sticks across phases', () => {
  let s = IDLE_ACTIVITY;
  s = activityFromEvent(s, { type: 'status', phase: 'tool', tool: 'act', detail: 'driving · clicking "Unsubscribe"', iteration: 11, driving: true }, 1000);
  const line = activityFor({ phase: 'tool', tool: s.tool!, detail: s.detail!, iteration: s.iteration!, driving: true, elapsed: 41_000, sinceLastEvent: 0 })!;
  assert.equal(line.pointer, true);
  assert.equal(activityText(line), 'driving · clicking "Unsubscribe" · 41s · step 11');
  s = activityFromEvent(s, { type: 'status', phase: 'model', detail: 'continuing', iteration: 12 }, 2000);
  assert.equal(s.driving, true);
  assert.equal(activityFor({ phase: 'model', driving: true, detail: s.detail!, elapsed: 1, sinceLastEvent: 0 })!.pointer, undefined);
  assert.equal(activityFromEvent(s, { type: 'status', phase: 'idle' }, 3000).driving, undefined);
});
