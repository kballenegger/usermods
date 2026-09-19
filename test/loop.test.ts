// The agent loop, end to end, against a provider that fails on cue.
//
// The owner's report was "lost connections lead to retrying the prompt entirely". These tests pin
// the three things that fix it: a blip is retried around the MODEL REQUEST only (every tool runs
// exactly once), a failure for good hands back everything the run completed as a history every
// adapter accepts, and a resume continues from that history without a second copy of the prompt.
//
// No browser and no clock: the provider, the page and the retry timer are all fakes.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { RESUME_NUDGE, runAgent, trimUnanswered, type AgentEnv, type AgentInput } from '../lib/agent/loop.ts';
import { ProviderError, streamIncomplete } from '../lib/providers/errors.ts';
import { toAnthropicMessages } from '../lib/providers/anthropic.ts';
import { toOpenAIMessages } from '../lib/providers/openai.ts';
import { toInput } from '../lib/providers/responses.ts';
import type { Provider, ProviderResponse } from '../lib/providers/types.ts';
import { reduceItems } from '../lib/transcript.ts';
import type { AgentEventBody, ChatItem, Msg, Part, Settings } from '../lib/types.ts';

// The mock backend's own validator: the rules a real chat-completions endpoint enforces. Imported
// dynamically through a string so tsc does not go looking for types an .mjs script does not have;
// importing it does not start the server (it only listens when run as a program).
const MOCK = '../scripts/mock-llm.mjs';
const { validateChatRequest } = (await import(MOCK)) as { validateChatRequest: (body: unknown) => Array<{ kind: string; detail: string }> };

const SETTINGS = { provider: 'openai-compatible', baseUrl: 'http://unused.invalid/v1', apiKey: '', model: 'fake' } as Settings;
const PROMPT = 'hide the sidebar PROMPT-MARKER';

/** One scripted provider step: a reply, or something to throw (optionally after streaming text). */
type Step = { reply: ProviderResponse } | { fail: unknown; partial?: string };

const call = (id: string, name: string, input: Record<string, unknown> = {}): Part => ({ type: 'tool_call', id, name, input });
const reply = (text: string, calls: Part[] = []): Step => ({
  reply: { content: [...(text ? [{ type: 'text', text } as Part] : []), ...calls], stopReason: calls.length ? 'tool_use' : 'end_turn' },
});

/** A provider that plays `steps` in order, records every request it was sent, and streams text. */
function fakeProvider(steps: Step[]) {
  const requests: Msg[][] = [];
  const provider: Provider = {
    async chat({ messages, callbacks }) {
      requests.push(structuredClone(messages));
      const step = steps.shift();
      if (!step) throw new Error('the fake provider ran out of steps');
      if ('fail' in step) {
        if (step.partial) callbacks.onText(step.partial);
        throw step.fail;
      }
      for (const p of step.reply.content) if (p.type === 'text') callbacks.onText(p.text);
      return step.reply;
    },
  };
  return { provider, requests };
}

/** A page that counts how many times each tool actually ran. */
function fakeEnv() {
  const ran: string[] = [];
  const env: AgentEnv = {
    async sendToContent<T>(req: unknown): Promise<T> {
      const type = (req as { type: string }).type;
      ran.push(type);
      if (type === 'snapshot') return { html: '<main>page</main>', url: 'https://example.com/', title: 'Example' } as T;
      return { text: `${type} result` } as T;
    },
    async runScript() {
      ran.push('run_script');
      return { outcome: { kind: 'ok', value: 'done' }, logs: [] } as never;
    },
    async screenshot() {
      ran.push('screenshot');
      return { mediaType: 'image/png', data: 'AAAA' };
    },
    async pageInfo() {
      return { url: 'https://example.com/', title: 'Example' };
    },
    async wait() {
      ran.push('wait');
      return { met: true, elapsedMs: 1 } as never;
    },
  };
  return { env, ran };
}

function input(provider: Provider, env: AgentEnv, over: Partial<AgentInput> = {}) {
  const events: AgentEventBody[] = [];
  const checkpoints: Msg[][] = [];
  const slept: number[] = [];
  const args: AgentInput = {
    settings: SETTINGS,
    history: [],
    turn: { id: 't1', text: PROMPT },
    pullQueued: () => [],
    env,
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    provider,
    onCheckpoint: (m) => void checkpoints.push(structuredClone(m)),
    retry: { deps: { sleep: async (ms) => void slept.push(ms), random: () => 0.5, isOnline: () => true } },
    ...over,
  };
  return { args, events, checkpoints, slept };
}

/** The pairing rules of all three wire formats, asserted on one neutral history. */
function assertValid(messages: Msg[], label: string) {
  const problems = validateChatRequest({ messages: toOpenAIMessages('sys', messages), tools: [{ type: 'function' }] });
  assert.deepEqual(problems, [], `${label}: chat-completions violations`);

  const uses = new Set<string>();
  const answered = new Set<string>();
  for (const m of toAnthropicMessages(messages)) {
    for (const b of m.content as unknown as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') uses.add(String(b.id));
      if (b.type === 'tool_result') {
        assert.ok(uses.has(String(b.tool_use_id)), `${label}/anthropic: orphan tool_result`);
        answered.add(String(b.tool_use_id));
      }
    }
  }
  assert.equal(answered.size, uses.size, `${label}/anthropic: unanswered tool_use`);

  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const item of toInput(messages, 'chatgpt')) {
    if (item.type === 'function_call') calls.add(String(item.call_id));
    if (item.type === 'function_call_output') outputs.add(String(item.call_id));
  }
  assert.deepEqual([...outputs].sort(), [...calls].sort(), `${label}/responses: unanswered function_call`);
}

const textOf = (m: Msg) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
const promptCount = (messages: Msg[]) => messages.filter((m) => m.role === 'user' && textOf(m).includes('PROMPT-MARKER')).length;
const resultsIn = (messages: Msg[]) => messages.flatMap((m) => m.content).filter((p) => p.type === 'tool_result');

// ---------- a blip costs nothing ----------

test('the provider fails three times then succeeds: every tool still runs exactly once', async () => {
  const { provider, requests } = fakeProvider([
    reply('Looking.', [call('c1', 'get_page')]),
    { fail: new ProviderError('503 Service Unavailable', { kind: 'http', status: 503 }) },
    { fail: streamIncomplete(), partial: 'Checking the he' },
    { fail: new ProviderError('Could not reach the model provider (Failed to fetch).', { kind: 'network' }) },
    reply('Checking the heading.', [call('c2', 'find_elements', { selector: 'h1' })]),
    reply('All done.'),
  ]);
  const { env, ran } = fakeEnv();
  const { args, events, slept } = input(provider, env);
  const out = await runAgent(args);

  assert.equal(out.failure, undefined);
  assert.deepEqual(ran, ['snapshot', 'query'], 'get_page once, find_elements once');
  assert.equal(requests.length, 6);
  assert.deepEqual(slept, [1000, 2000, 4000], 'three backoff waits, all around the model request');
  assertValid(out.messages, 'after retries');
  assert.equal(promptCount(out.messages), 1);

  // The three failed attempts all sent the SAME conversation: nothing was appended between them.
  assert.deepEqual(requests[1], requests[2]);
  assert.deepEqual(requests[2], requests[4]);

  // The activity line was told about each wait, then put back to normal.
  const retries = events.filter((e) => e.type === 'status' && e.retry);
  assert.deepEqual(retries.map((e) => (e.type === 'status' ? [e.retry!.reason, e.retry!.attempt, e.retry!.max] : null)), [
    ['server', 1, 5],
    ['stream', 2, 5],
    ['network', 3, 5],
  ]);
  const lastRetryAt = events.lastIndexOf(retries[2]!);
  const after = events[lastRetryAt + 1]!;
  assert.ok(after.type === 'status' && !after.retry && after.detail === 'continuing', 'the ordinary label returns after the wait');
});

test('a reply that died mid-stream is taken back, so the transcript never says it twice', async () => {
  const { provider } = fakeProvider([
    { fail: streamIncomplete(), partial: 'Let me look at the pa' },
    reply('Let me look at the page.'),
  ]);
  const { env } = fakeEnv();
  const { args, events } = input(provider, env);
  await runAgent(args);

  assert.deepEqual(events.filter((e) => e.type === 'text_discard'), [{ type: 'text_discard', chars: 'Let me look at the pa'.length }]);
  // What the panel ends up showing, by the same reduction it uses.
  let items: ChatItem[] = [{ kind: 'user', id: 't1', text: PROMPT }];
  for (const e of events) items = reduceItems(items, e);
  assert.deepEqual(items.filter((i) => i.kind === 'assistant'), [{ kind: 'assistant', text: 'Let me look at the page.' }]);
});

// ---------- a long outage keeps the progress ----------

test('a permanent failure hands back a valid history holding the completed tool results', async () => {
  const dead = () => ({ fail: new ProviderError('Could not reach the model provider (Failed to fetch).', { kind: 'network' }) });
  const { provider, requests } = fakeProvider([
    reply('Looking.', [call('c1', 'get_page')]),
    reply('Two things to check.', [call('c2', 'find_elements', { selector: 'h1' }), call('c3', 'get_styles', { selector: 'h1' })]),
    dead(), dead(), dead(), dead(), dead(), dead(),
  ]);
  const { env, ran } = fakeEnv();
  const { args, events, checkpoints, slept } = input(provider, env);
  const out = await runAgent(args);

  assert.match(out.failure?.message ?? '', /Could not reach the model provider/);
  assert.equal(requests.length, 8, 'two good steps, then one attempt and five retries');
  assert.deepEqual(slept, [1000, 2000, 4000, 8000, 16_000]);
  assertValid(out.messages, 'after a permanent failure');
  assert.deepEqual(resultsIn(out.messages).map((p) => (p.type === 'tool_result' ? p.toolCallId : '')), ['c1', 'c2', 'c3']);
  assert.equal(out.messages[out.messages.length - 1]!.role, 'user', 'it ends on the tool results, ready to be sent again');
  assert.deepEqual(ran, ['snapshot', 'query', 'styles']);
  // The loop itself does not announce the failure: the caller does, once it has saved the history.
  assert.equal(events.some((e) => e.type === 'error'), false);

  // Every checkpoint along the way was itself a valid, resumable history.
  assert.equal(checkpoints.length, 3, 'the turn, then each completed step');
  checkpoints.forEach((c, i) => assertValid(c, `checkpoint ${i}`));
  assert.equal(resultsIn(checkpoints[0]!).length, 0);
  assert.equal(resultsIn(checkpoints[2]!).length, 3);
  assert.deepEqual(checkpoints[2], out.messages, 'what was checkpointed last is what came back');
});

test('a failure that is not retryable keeps the turn and spends no retries', async () => {
  const { provider, requests } = fakeProvider([{ fail: new ProviderError('401 Unauthorized: bad key', { kind: 'http', status: 401 }) }]);
  const { env } = fakeEnv();
  const { args, slept } = input(provider, env);
  const out = await runAgent(args);
  assert.match(out.failure?.message ?? '', /401/);
  assert.equal(requests.length, 1);
  assert.deepEqual(slept, []);
  assert.equal(promptCount(out.messages), 1, 'the prompt is in the saved history, so fixing the key and resuming needs no retyping');
  assertValid(out.messages, 'after a 401');
});

test('resume continues from the saved history: no second prompt, no tool run again', async () => {
  // Run 1 dies after one completed step.
  const first = fakeProvider([
    reply('Looking.', [call('c1', 'get_page')]),
    { fail: new ProviderError('400 Bad Request: nope', { kind: 'http', status: 400 }) },
  ]);
  const page1 = fakeEnv();
  const run1 = await runAgent(input(first.provider, page1.env).args);
  assert.ok(run1.failure);

  // Run 2 resumes it: turn is null, history is what run 1 handed back.
  const second = fakeProvider([reply('Checking.', [call('c2', 'find_elements', { selector: 'h1' })]), reply('Done: the heading is fine.')]);
  const page2 = fakeEnv();
  const { args, events } = input(second.provider, page2.env, { turn: null, history: run1.messages });
  const run2 = await runAgent(args);

  assert.equal(run2.failure, undefined);
  assert.deepEqual(second.requests[0], run1.messages, 'the model gets the same conversation again, exactly');
  assert.equal(promptCount(run2.messages), 1, 'the prompt appears once in the whole conversation');
  assert.deepEqual(page2.ran, ['query'], 'get_page was not run again');
  assert.equal(events.some((e) => e.type === 'accepted'), false, 'no user turn entered the conversation');
  assert.equal(run2.messages.some((m) => textOf(m).includes(RESUME_NUDGE)), false, 'no synthetic line was needed');
  assertValid(run2.messages, 'after resume');
  assert.equal(textOf(run2.messages[run2.messages.length - 1]!), 'Done: the heading is fine.');
});

test('a resumed run that fails again is resumable again', async () => {
  const down = () => ({ fail: new ProviderError('400 no', { kind: 'http', status: 400 }) });
  const run1 = await runAgent(input(fakeProvider([reply('', [call('c1', 'get_page')]), down()]).provider, fakeEnv().env).args);
  const run2 = await runAgent(input(fakeProvider([down()]).provider, fakeEnv().env, { turn: null, history: run1.messages }).args);
  assert.ok(run2.failure);
  assert.deepEqual(run2.messages, run1.messages, 'nothing was added by the failed resume');
  const third = fakeProvider([reply('Finished.')]);
  const run3 = await runAgent(input(third.provider, fakeEnv().env, { turn: null, history: run2.messages }).args);
  assert.equal(run3.failure, undefined);
  assert.equal(promptCount(run3.messages), 1);
});

test('resuming a history that ends on an assistant message adds the one synthetic line, and only then', async () => {
  const history: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: PROMPT }] },
    { role: 'assistant', content: [{ type: 'text', text: 'I was about to' }] },
  ];
  const { provider, requests } = fakeProvider([reply('Carrying on.')]);
  const out = await runAgent(input(provider, fakeEnv().env, { turn: null, history }).args);
  const sent = requests[0]!;
  assert.equal(sent[sent.length - 1]!.role, 'user');
  assert.equal(textOf(sent[sent.length - 1]!), RESUME_NUDGE);
  assertValid(out.messages, 'after a nudged resume');
});

test('resuming drops a dangling tool call rather than sending an invalid history', async () => {
  const history: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: PROMPT }] },
    { role: 'assistant', content: [call('c9', 'get_page')] },
  ];
  assert.equal(trimUnanswered(history).length, 1);
  const { provider, requests } = fakeProvider([reply('Starting over from the prompt.')]);
  const out = await runAgent(input(provider, fakeEnv().env, { turn: null, history }).args);
  assertValid(requests[0]!, 'the resumed request');
  assertValid(out.messages, 'after');
});

// ---------- Stop ----------

test('Stop during a backoff wait ends the run at once, with a valid history and no failure', async () => {
  const ac = new AbortController();
  const { provider, requests } = fakeProvider([
    reply('Looking.', [call('c1', 'get_page')]),
    { fail: new ProviderError('503', { kind: 'http', status: 503 }) },
    reply('never reached'),
  ]);
  const { env } = fakeEnv();
  const { args } = input(provider, env, {
    signal: ac.signal,
    // A real abortable sleep of thirty seconds: if Stop did not cut it short this test would hang.
    retry: { policy: { maxRetries: 5, baseDelayMs: 30_000, maxDelayMs: 30_000, retryAfterCapMs: 60_000, jitter: 0, offlineCapMs: 1000 }, deps: { isOnline: () => true } },
    emit: (e) => {
      if (e.type === 'status' && e.retry) setTimeout(() => ac.abort(), 5);
    },
  });
  const started = Date.now();
  const out = await runAgent(args);
  assert.ok(Date.now() - started < 2000);
  assert.equal(out.failure, undefined, 'Stop is not a failure, so no Resume is offered for it');
  assert.equal(requests.length, 2);
  assertValid(out.messages, 'after Stop');
  assert.equal(resultsIn(out.messages).length, 1);
});

test('a message queued during the run still joins the conversation after a retry', async () => {
  const queue = [{ id: 'q1', text: 'also make it blue QUEUED-MARKER' }];
  const { provider, requests } = fakeProvider([
    { fail: streamIncomplete() },
    reply('Looking.', [call('c1', 'get_page')]),
    reply('Done.'),
  ]);
  const { args, events } = input(provider, fakeEnv().env, { pullQueued: () => queue.splice(0) });
  const out = await runAgent(args);
  assert.equal(out.failure, undefined);
  assert.ok(textOf(requests[2]![requests[2]!.length - 1]!).includes('QUEUED-MARKER'));
  assert.deepEqual(events.filter((e) => e.type === 'accepted').map((e) => (e.type === 'accepted' ? e.id : '')), ['t1', 'q1']);
  assertValid(out.messages, 'with a queued message');
});
