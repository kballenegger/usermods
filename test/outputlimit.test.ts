// Reasoning visibility and the output limit on OpenAI-compatible connections.
//
// The bug: a thinking model on a server that caps an omitted max_tokens at 4096 spent every token
// reasoning, the adapter ignored the reasoning deltas, and the loop ended the turn on an empty
// reply with nothing on screen. These pin each part of the fix.
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { activityFor, activityFromEvent, IDLE_ACTIVITY, THINKING_TAIL_CHARS } from '../lib/activity.ts';
import { EMPTY_AT_LIMIT_MESSAGE, EMPTY_REPLY_MESSAGE, runAgent, type AgentEnv } from '../lib/agent/loop.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS, maxTokensFieldFor, outputLimitCeiling, outputLimitFor, outputLimitRejection, resolveMaxOutputTokens } from '../lib/outputlimit.ts';
import { createOpenAIProvider, reasoningDelta } from '../lib/providers/openai.ts';
import type { Provider, ProviderResponse } from '../lib/providers/types.ts';
import { reduceItems } from '../lib/transcript.ts';
import type { AgentEventBody, Msg, Settings } from '../lib/types.ts';

function stream(chunks: Array<Record<string, unknown>>, finish = 'stop'): Response {
  const lines = [
    ...chunks.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}`,
    'data: [DONE]',
    '',
  ];
  return new Response(lines.join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, statusText: 'Bad Request' });
}

async function withFetch<T>(handler: (body: any, n: number) => Response, fn: (sent: any[]) => Promise<T>): Promise<T> {
  const sent: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return handler(sent[sent.length - 1], sent.length);
  }) as typeof fetch;
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = original;
  }
}

function memory(initial: string[] = []) {
  const keys = new Set(initial);
  return { keys, isUnsupported: async (k: string) => keys.has(k), markUnsupported: async (k: string) => void keys.add(k) };
}

const settings = (patch: Partial<Settings> = {}): Settings =>
  ({ provider: 'openai-compatible', baseUrl: 'http://localhost:8888/v1', apiKey: '', model: 'qwen3-32b', ...patch }) as Settings;

async function chat(s: Settings, deps = {}) {
  const thoughts: string[] = [];
  const texts: string[] = [];
  const res = await createOpenAIProvider(s, deps).chat({
    system: 'SYS',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    callbacks: { onText: (d) => texts.push(d), onThinking: (d) => thoughts.push(d) },
  });
  return { res, thoughts, texts };
}

describe('reasoning deltas', () => {
  test('reasoning_content and reasoning are both read, and never become content', async () => {
    await withFetch(
      () => stream([{ reasoning_content: 'let me ' }, { reasoning: 'think' }, { content: 'Done.' }]),
      async () => {
        const { res, thoughts, texts } = await chat(settings());
        assert.deepEqual(thoughts, ['let me ', 'think']);
        assert.deepEqual(texts, ['Done.']);
        assert.deepEqual(res.content, [{ type: 'text', text: 'Done.' }], 'reasoning is display only');
      },
    );
  });

  test('a reply that is all reasoning and hits the limit reports max_tokens with no content', async () => {
    await withFetch(
      () => stream([{ reasoning_content: 'hmm '.repeat(10) }], 'length'),
      async () => {
        const { res, thoughts } = await chat(settings());
        assert.equal(res.stopReason, 'max_tokens');
        assert.deepEqual(res.content, []);
        assert.ok(thoughts.length > 0);
      },
    );
  });

  test('non-string reasoning shapes are ignored', () => {
    assert.equal(reasoningDelta({ reasoning: { text: 'x' } }), '');
    assert.equal(reasoningDelta({ reasoning_content: '' }), '');
    assert.equal(reasoningDelta(undefined), '');
  });
});

describe('the output limit', () => {
  test('stored values resolve, with the default for anything unusable', () => {
    assert.equal(resolveMaxOutputTokens(undefined), DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(resolveMaxOutputTokens(0), DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(resolveMaxOutputTokens(-5), DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(resolveMaxOutputTokens('abc'), DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(resolveMaxOutputTokens('8192'), 8192);
    assert.equal(resolveMaxOutputTokens(2048.7), 2048);
  });

  test("OpenAI's own API gets max_completion_tokens; everything else max_tokens", () => {
    assert.equal(maxTokensFieldFor('https://api.openai.com/v1'), 'max_completion_tokens');
    assert.equal(maxTokensFieldFor('http://localhost:8888/v1'), 'max_tokens');
    assert.equal(maxTokensFieldFor('https://openrouter.ai/api/v1'), 'max_tokens');
    assert.equal(maxTokensFieldFor('not a url'), 'max_tokens');
  });

  test('every request carries the limit, default 16384', async () => {
    await withFetch(
      () => stream([{ content: 'ok' }]),
      async (sent) => {
        await chat(settings());
        assert.equal(sent[0].max_tokens, 16384);
        await chat(settings({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', maxOutputTokens: 4000 }));
        assert.equal(sent[1].max_completion_tokens, 4000);
        assert.ok(!('max_tokens' in sent[1]));
      },
    );
  });

  test('a server that does not take the field gets the request again without it, and it is remembered', async () => {
    const mem = memory();
    await withFetch(
      (_b, n) => (n === 1 ? errorResponse(400, 'Unrecognized request argument supplied: max_tokens') : stream([{ content: 'ok' }])),
      async (sent) => {
        const { res } = await chat(settings(), { outputLimitMemory: mem });
        assert.equal(res.stopReason, 'end_turn');
        assert.equal(sent.length, 2);
        assert.ok(!('max_tokens' in sent[1]));
        assert.equal(mem.keys.size, 1);
        await chat(settings(), { outputLimitMemory: mem });
        assert.ok(!('max_tokens' in sent[2]), 'the next request skips the field without a 400');
      },
    );
  });

  test('a limit too large for the window is dropped for that request only', async () => {
    const mem = memory();
    const msg = "'max_tokens' or 'max_completion_tokens' is too large: 16384. This model's maximum context length is 32768 tokens and your request has 20000 input tokens";
    await withFetch(
      (_b, n) => (n === 1 ? errorResponse(400, msg) : stream([{ content: 'ok' }])),
      async (sent) => {
        await chat(settings(), { outputLimitMemory: mem });
        assert.equal(sent.length, 2);
        assert.ok(!('max_tokens' in sent[1]));
        assert.equal(mem.keys.size, 0, 'not remembered: the next turn may fit');
      },
    );
  });

  test('OpenAI and OpenRouter send no limit unless one is set; other hosts send the default', async () => {
    assert.equal(outputLimitFor('https://api.openai.com/v1', undefined), null);
    assert.equal(outputLimitFor('https://openrouter.ai/api/v1', 0), null);
    assert.equal(outputLimitFor('https://openrouter.ai/api/v1', 8000), 8000);
    assert.equal(outputLimitFor('http://localhost:8888/v1', undefined), DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(outputLimitFor('http://localhost:8888/v1', -3), DEFAULT_MAX_OUTPUT_TOKENS);
    await withFetch(
      () => stream([{ content: 'ok' }]),
      async (sent) => {
        await chat(settings({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }));
        assert.ok(!('max_completion_tokens' in sent[0]) && !('max_tokens' in sent[0]));
        await chat(settings({ baseUrl: 'https://openrouter.ai/api/v1', model: 'x/y' }));
        assert.ok(!('max_tokens' in sent[1]));
      },
    );
  });

  test('a value past a stated maximum is too-large, not unsupported, and retried at that maximum', async () => {
    const deepseek = 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]';
    const openai = "Invalid 'max_completion_tokens': integer above maximum value. Expected a value <= 8192, but got 16384 instead.";
    assert.equal(outputLimitRejection(400, deepseek), 'too-large');
    assert.equal(outputLimitRejection(400, openai), 'too-large');
    assert.equal(outputLimitCeiling(deepseek), 8192);
    assert.equal(outputLimitCeiling(openai), 8192);
    assert.equal(outputLimitCeiling("This model's maximum context length is 32768 tokens."), null);
    const mem = memory();
    await withFetch(
      (b) => (b.max_tokens > 8192 ? errorResponse(400, deepseek) : stream([{ content: 'ok' }])),
      async (sent) => {
        const { res } = await chat(settings(), { outputLimitMemory: mem });
        assert.equal(res.stopReason, 'end_turn');
        assert.equal(sent.length, 2);
        assert.equal(sent[1].max_tokens, 8192, 'the stated maximum, not no limit');
        assert.equal(mem.keys.size, 0, 'not remembered as unsupported');
        await chat(settings({ maxOutputTokens: 8192 }), { outputLimitMemory: mem });
        assert.equal(sent[2].max_tokens, 8192, 'a fitting setting goes through untouched');
      },
    );
  });

  test('the classifier leaves other 400s alone', () => {
    assert.equal(outputLimitRejection(400, 'Unsupported parameter: max_tokens is not supported with this model.'), 'unsupported');
    assert.equal(outputLimitRejection(400, "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (8000 in the messages, 1000 in the completion)."), 'too-large');
    assert.equal(outputLimitRejection(400, 'prompt is too long'), null, 'a plain overflow is left to compaction');
    assert.equal(outputLimitRejection(400, 'Unrecognized request argument supplied: reasoning_effort'), null);
    assert.equal(outputLimitRejection(500, 'max_tokens is not supported'), null);
    assert.equal(outputLimitRejection(429, 'max_tokens is too large'), null);
  });

  test('Qwen 3 at Thinking low sends reasoning_effort and enable_thinking together', async () => {
    await withFetch(
      () => stream([{ content: 'ok' }]),
      async (sent) => {
        await chat(settings({ thinking: 'low' }));
        assert.equal(sent[0].reasoning_effort, 'low');
        assert.deepEqual(sent[0].chat_template_kwargs, { enable_thinking: true });
        await chat(settings({ thinking: 'default' }));
        assert.ok(!('reasoning_effort' in sent[1]) && !('chat_template_kwargs' in sent[1]));
      },
    );
  });

  test('a server that refuses only reasoning_effort keeps the Qwen 3 on/off switch', async () => {
    const mem = memory();
    await withFetch(
      (b) => ('reasoning_effort' in b ? errorResponse(400, 'Unrecognized request argument supplied: reasoning_effort') : stream([{ content: 'ok' }])),
      async (sent) => {
        await chat(settings({ thinking: 'low' }), { thinkingMemory: mem });
        assert.equal(sent.length, 2);
        assert.deepEqual(sent[1].chat_template_kwargs, { enable_thinking: true }, 'the switch survives');
        assert.ok(!('reasoning_effort' in sent[1]));
        await chat(settings({ thinking: 'off' }), { thinkingMemory: mem });
        assert.deepEqual(sent[2].chat_template_kwargs, { enable_thinking: false }, 'Off still works');
        await chat(settings({ thinking: 'medium' }), { thinkingMemory: mem });
        assert.equal(sent.length, 4, 'the effort field is remembered, no second 400');
        assert.ok(!('reasoning_effort' in sent[3]));
      },
    );
  });
});

describe('the loop never ends silently on an empty reply', () => {
  const env: AgentEnv = {
    async sendToContent<T>(): Promise<T> {
      return { html: '<main/>', url: 'https://example.com/', title: 'Example' } as T;
    },
    async runScript() {
      return { outcome: { kind: 'ok', value: null }, logs: [] } as never;
    },
    async screenshot() {
      return { mediaType: 'image/png', data: 'AAAA' };
    },
    async pageInfo() {
      return { url: 'https://example.com/', title: 'Example' };
    },
    async wait() {
      return { met: true, elapsedMs: 1 } as never;
    },
  } as AgentEnv;

  async function run(reply: ProviderResponse, thinking = '') {
    const provider: Provider = {
      async chat({ callbacks }) {
        if (thinking) callbacks.onThinking?.(thinking);
        return reply;
      },
    };
    const events: AgentEventBody[] = [];
    const out = await runAgent({
      settings: settings(),
      history: [],
      turn: { id: 't1', text: 'hide the sidebar' },
      pullQueued: () => [],
      env,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      provider,
      retry: { deps: { sleep: async () => {}, random: () => 0.5, isOnline: () => true } },
    });
    return { events, messages: out.messages as Msg[] };
  }

  test('all thinking, no answer, at the limit: the limit error, and no empty assistant turn', async () => {
    const { events, messages } = await run({ content: [], stopReason: 'max_tokens' }, 'pondering');
    assert.ok(events.some((e) => e.type === 'thinking' && e.delta === 'pondering'));
    const err = events.find((e) => e.type === 'error');
    assert.equal(err && 'message' in err ? err.message : '', EMPTY_AT_LIMIT_MESSAGE);
    assert.ok(!messages.some((m) => m.role === 'assistant'), 'the empty reply is not history');
  });

  test('an empty end_turn says the reply was empty', async () => {
    const { events } = await run({ content: [{ type: 'text', text: '  ' }], stopReason: 'end_turn' });
    const err = events.find((e) => e.type === 'error');
    assert.equal(err && 'message' in err ? err.message : '', EMPTY_REPLY_MESSAGE);
  });

  test('an empty end_turn after a tool step ends the turn quietly', async () => {
    const replies: ProviderResponse[] = [
      { content: [{ type: 'tool_call', id: 'c1', name: 'get_page', input: {} }], stopReason: 'tool_use' },
      { content: [], stopReason: 'end_turn' },
    ];
    let n = 0;
    const provider: Provider = { async chat() { return replies[n++]!; } };
    const events: AgentEventBody[] = [];
    const out = await runAgent({
      settings: settings(),
      history: [],
      turn: { id: 't1', text: 'hide the sidebar' },
      pullQueued: () => [],
      env,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      provider,
      retry: { deps: { sleep: async () => {}, random: () => 0.5, isOnline: () => true } },
    });
    assert.equal(n, 2);
    assert.ok(!events.some((e) => e.type === 'error'), 'a finished turn is not an error');
    assert.ok(!(out.messages as Msg[]).some((m) => m.role === 'assistant' && !m.content.length), 'no empty assistant turn');
  });

  test('a real answer is unchanged', async () => {
    const { events, messages } = await run({ content: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn' });
    assert.ok(!events.some((e) => e.type === 'error'));
    assert.equal(messages[messages.length - 1]?.role, 'assistant');
  });
});

describe('the panel shows thinking without storing it', () => {
  test('a thinking event changes the line, not the transcript', () => {
    const items = [{ kind: 'user' as const, id: 'u', text: 'hi' }];
    assert.equal(reduceItems(items as never, { type: 'thinking', delta: 'x' }), items);

    let a = activityFromEvent(IDLE_ACTIVITY, { type: 'status', phase: 'model', detail: 'waiting for model', iteration: 1 }, 0);
    a = activityFromEvent(a, { type: 'thinking', delta: 'a'.repeat(1500) }, 10);
    assert.equal(a.thinkingChars, 1500);
    const line = activityFor({ phase: 'model', elapsed: 5000, sinceLastEvent: 0, thinkingChars: a.thinkingChars });
    assert.equal(line?.label, 'thinking');
    assert.ok(line?.segments.includes('1k chars'));

    a = activityFromEvent(a, { type: 'thinking', delta: 'b'.repeat(THINKING_TAIL_CHARS) }, 20);
    assert.equal(a.thinkingText?.length, THINKING_TAIL_CHARS, 'only the tail is kept');
    // The next phase starts from nothing.
    a = activityFromEvent(a, { type: 'status', phase: 'tool', tool: 'snapshot', iteration: 1 }, 30);
    assert.equal(a.thinkingChars, 0);
  });
});
