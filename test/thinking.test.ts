// The Thinking level: the capability table, the per-provider mapping, and the two things that must
// never break — the Anthropic prompt cache, and a server that refuses the field.
//
// Every expectation here is a documented request shape, not an invented one. The doc URLs are in
// lib/thinking.ts beside the rule each one justifies; where a test asserts a REJECTION (a field a
// model must never receive) the reason is restated in place, because that is the assertion whose
// point is easiest to lose later.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  applyThinking,
  guessReasoningField,
  isReasoningRejection,
  lowestThinkingLevel,
  parseCustomFields,
  resolveReasoningField,
  resolveThinkingLevel,
  supportsThinking,
  thinkingCapability,
  thinkingKey,
  THINKING_LEVELS,
  xaiSupportsReasoning,
  type ThinkingLevel,
} from '../lib/thinking.ts';
import { createOpenAIProvider } from '../lib/providers/openai.ts';
import { createAnthropicProvider } from '../lib/providers/anthropic.ts';
import { isVisionRejection } from '../lib/providers/vision.ts';
import { isContextLengthError } from '../lib/agent/retry.ts';
import { ProviderError } from '../lib/providers/errors.ts';
import { DEFAULT_SETTINGS, type Msg, type Settings } from '../lib/types.ts';

/** The capability for one model, at the call site's convenience. */
const cap = (kind: Parameters<typeof thinkingCapability>[0]['kind'], model: string, reasoningField?: Parameters<typeof thinkingCapability>[0]['reasoningField']) =>
  thinkingCapability({ kind, model, reasoningField });

/** The request body one level produces on one model. */
const bodyFor = (level: ThinkingLevel, kind: Parameters<typeof cap>[0], model: string, field?: Parameters<typeof cap>[2]) =>
  applyThinking(level, cap(kind, model, field));

describe('the neutral scale', () => {
  test('an unknown or missing stored value reads as the default', () => {
    assert.equal(resolveThinkingLevel(undefined), 'default');
    assert.equal(resolveThinkingLevel(null), 'default');
    assert.equal(resolveThinkingLevel('xhigh'), 'default', 'a level we do not expose is not adopted from storage');
    assert.equal(resolveThinkingLevel(7), 'default');
    for (const level of THINKING_LEVELS) assert.equal(resolveThinkingLevel(level), level);
  });

  test("'default' never puts a field on the wire, on any provider", () => {
    // This is the property that makes the whole feature additive: an untouched chat sends exactly
    // the request it sent before this module existed.
    const models: Array<[Parameters<typeof cap>[0], string]> = [
      ['anthropic', 'claude-opus-5'],
      ['anthropic', 'claude-sonnet-4-5'],
      ['chatgpt', 'gpt-5'],
      ['xai', 'grok-4.6'],
      ['openai-compatible', 'gpt-5'],
      ['openai-compatible', 'qwen3-32b'],
      ['openai-compatible', 'llama-3-8b'],
    ];
    for (const [kind, model] of models) {
      const out = bodyFor('default', kind, model);
      assert.deepEqual(out.body, {}, `${kind}/${model} sent a body field for 'default'`);
      assert.equal(out.thinking, undefined, `${kind}/${model} sent a thinking field for 'default'`);
    }
  });

  test('a level the model does not support produces nothing', () => {
    // Belt to the picker's braces: a stale stored level cannot put a rejected field on the wire.
    const fable = cap('anthropic', 'claude-fable-5');
    assert.ok(!fable.levels.includes('off'), 'Fable 5 must not offer Off');
    assert.deepEqual(applyThinking('off', fable), { body: {} }, 'a level outside the capability sends nothing');
  });
});

describe('Anthropic: adaptive thinking and output_config.effort', () => {
  // https://platform.claude.com/docs/en/build-with-claude/effort — the effort parameter is
  // TOP-LEVEL `output_config.effort`, a sibling of `thinking`, not a field inside it.
  test('effort is sent as top-level output_config.effort, not inside thinking', () => {
    const out = bodyFor('medium', 'anthropic', 'claude-opus-5');
    assert.deepEqual(out.body, { output_config: { effort: 'medium' } });
    assert.equal(out.thinking, undefined, 'an effort level does not restate the thinking mode');
  });

  test('the ladder maps onto the documented effort values', () => {
    assert.deepEqual(bodyFor('low', 'anthropic', 'claude-opus-5').body, { output_config: { effort: 'low' } });
    assert.deepEqual(bodyFor('high', 'anthropic', 'claude-opus-5').body, { output_config: { effort: 'high' } });
    // 'max' is a real documented level, above xhigh, for "absolute maximum capability".
    assert.deepEqual(bodyFor('max', 'anthropic', 'claude-opus-5').body, { output_config: { effort: 'max' } });
  });

  test('Off disables thinking on models that accept it, and sends no effort with it', () => {
    const out = bodyFor('off', 'anthropic', 'claude-opus-5');
    assert.deepEqual(out.thinking, { type: 'disabled' });
    // Opus 5 rejects thinking "disabled" combined with effort xhigh or max, so Off must never ride
    // along with an effort value at all.
    assert.deepEqual(out.body, {}, 'Off must not send an effort level beside a disabled thinking block');
  });

  test('the always-thinking models are not offered Off at all', () => {
    // The support table marks Fable 5/5.1, Mythos 5/5.1 and Mythos Preview "Always on":
    // thinking: {type: "disabled"} is a 400 on every one of them.
    for (const model of ['claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-preview']) {
      const c = cap('anthropic', model);
      assert.ok(!c.levels.includes('off'), `${model} must not offer Off`);
      assert.deepEqual(applyThinking('off', c).thinking, undefined, `${model} must never be sent thinking.disabled`);
      // It still takes effort, which is the whole point of the row for these models.
      assert.deepEqual(applyThinking('low', c).body, { output_config: { effort: 'low' } });
    }
  });

  test('Opus 5 and Sonnet 5 do offer Off', () => {
    // The table marks these "On": they default to thinking but accept "disabled".
    for (const model of ['claude-opus-5', 'claude-sonnet-5']) {
      assert.ok(cap('anthropic', model).levels.includes('off'), `${model} should offer Off`);
    }
  });

  test('the legacy models get budget_tokens and never an effort field', () => {
    // Claude Sonnet 4.5 / Haiku 4.5 / Opus 4.5 are extended-thinking-only: "adaptive" is a 400, and
    // thinking depth is budget_tokens. Sending output_config.effort in their shape would be wrong.
    for (const model of ['claude-sonnet-4-5', 'claude-haiku-4-5']) {
      const c = cap('anthropic', model);
      assert.equal(c.style, 'anthropic-budget');
      const out = applyThinking('medium', c);
      assert.deepEqual(out.thinking, { type: 'enabled', budget_tokens: 4000 });
      assert.deepEqual(out.body, {}, `${model} must not be sent output_config.effort`);
    }
  });

  test('every budget respects the documented 1024 floor and stays under max_tokens', () => {
    const c = cap('anthropic', 'claude-sonnet-4-5');
    for (const level of ['low', 'medium', 'high'] as ThinkingLevel[]) {
      const budget = (applyThinking(level, c).thinking as { budget_tokens: number }).budget_tokens;
      assert.ok(budget >= 1024, `${level} budget ${budget} is below the API's 1024 minimum`);
      // The adapter sends max_tokens: 16000, and the budget must leave room for the answer.
      assert.ok(budget < 16000, `${level} budget ${budget} does not leave room under max_tokens`);
    }
  });

  test('the adaptive and budget families are split on the right models', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-fable-5']) {
      assert.equal(cap('anthropic', model).style, 'anthropic-effort', `${model} should use adaptive + effort`);
    }
    for (const model of ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet']) {
      assert.equal(cap('anthropic', model).style, 'anthropic-budget', `${model} should use budget_tokens`);
    }
  });
});

describe('Anthropic: the prompt cache survives a level change', () => {
  /**
   * The request createAnthropicProvider really sends at one level, captured off the wire.
   *
   * The fake server answers 400 so the call rejects straight after the body is sent; only the body
   * matters here. The system block carries the cache_control marker, and the point of these tests is
   * that no level can reach inside `system`, `tools` or `messages`.
   */
  const sentAt = async (level: ThinkingLevel, model = 'claude-opus-5'): Promise<Record<string, unknown>> =>
    withFetch(
      () => errorResponse(400, 'captured'),
      async (sent) => {
        const provider = createAnthropicProvider({ ...DEFAULT_SETTINGS, provider: 'anthropic', apiKey: 'k', model, thinking: level });
        await assert.rejects(
          provider.chat({
            system: 'SYSTEM PROMPT',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            tools: [{ name: 'get_page', description: 'read', inputSchema: { type: 'object', properties: {} } }],
            callbacks: { onText: () => {} },
          }),
        );
        assert.equal(sent.length, 1, 'exactly one request, with the SDK retries turned off');
        return sent[0];
      },
    );

  /** The top-level keys whose values differ between two requests. */
  const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();

  test('the system block, tools and messages are byte-identical across every level', async () => {
    // Tool and system-prompt breakpoints can miss depending on where the model renders the
    // configuration; what WE control is that we do not rewrite them ourselves.
    const base = await sentAt('default');
    assert.deepEqual((base.system as Array<{ cache_control?: unknown }>)[0]?.cache_control, { type: 'ephemeral' });
    for (const level of THINKING_LEVELS) {
      const req = await sentAt(level);
      assert.equal(JSON.stringify(req.system), JSON.stringify(base.system), `level ${level} changed the cached system block`);
      assert.equal(JSON.stringify(req.tools), JSON.stringify(base.tools), `level ${level} rewrote the tools array`);
      assert.equal(JSON.stringify(req.messages), JSON.stringify(base.messages), `level ${level} rewrote the messages`);
    }
  });

  test('a level only ever changes top-level siblings of system', async () => {
    // Whatever a level changes, it changes OUTSIDE the cached prefix's own fields.
    const base = await sentAt('default');
    assert.deepEqual(base.thinking, { type: 'adaptive' }, "'default' keeps the adapter's own adaptive mode");
    for (const level of ['low', 'medium', 'high', 'max'] as ThinkingLevel[]) {
      const req = await sentAt(level);
      assert.deepEqual(changedKeys(base, req), ['output_config'], `level ${level} changed more than output_config`);
      assert.deepEqual(req.output_config, { effort: level });
    }
    // Off overrides the adapter's adaptive default. If the default were spread last it would win,
    // and Off would quietly send adaptive thinking.
    const off = await sentAt('off');
    assert.deepEqual(changedKeys(base, off), ['thinking']);
    assert.deepEqual(off.thinking, { type: 'disabled' });
  });

  test('the same level twice produces the identical request, so consecutive turns cache', async () => {
    assert.equal(JSON.stringify(await sentAt('medium')), JSON.stringify(await sentAt('medium')));
  });
});

describe('Responses API: ChatGPT and xAI', () => {
  test('ChatGPT maps onto reasoning.effort', () => {
    assert.deepEqual(bodyFor('low', 'chatgpt', 'gpt-5').body, { reasoning: { effort: 'low' } });
    assert.deepEqual(bodyFor('high', 'chatgpt', 'gpt-5').body, { reasoning: { effort: 'high' } });
  });

  test("ChatGPT's Off is the documented 'none' effort", () => {
    assert.deepEqual(bodyFor('off', 'chatgpt', 'gpt-5').body, { reasoning: { effort: 'none' } });
  });

  test('xAI is never offered Off, because its reasoning cannot be disabled', () => {
    // docs.x.ai: "reasoning cannot be disabled" on the models that take the parameter. Offering Off
    // would be offering a request the API refuses.
    const c = cap('xai', 'grok-4.6');
    assert.ok(!c.levels.includes('off'), 'xAI must not offer Off');
    assert.deepEqual(applyThinking('off', c).body, {}, 'xAI must never be sent effort: none');
    assert.deepEqual(applyThinking('medium', c).body, { reasoning: { effort: 'medium' } });
  });

  test('the xAI -fast and non-reasoning variants are offered nothing at all', () => {
    // lib/providers/index.ts already omits the field for these; the row must agree, or the picker
    // would offer a level that silently does nothing.
    for (const model of ['grok-4-fast', 'grok-3-non-reasoning']) {
      const c = cap('xai', model);
      assert.equal(supportsThinking(c), false, `${model} should show no Thinking row`);
      assert.deepEqual(applyThinking('high', c).body, {}, `${model} must never receive a reasoning field`);
      assert.equal(xaiSupportsReasoning(model), false);
    }
    assert.equal(xaiSupportsReasoning('grok-4.6'), true);
  });
});

describe('OpenAI-compatible chat/completions', () => {
  test("OpenAI's own reasoning models take reasoning_effort", () => {
    for (const model of ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini']) {
      const c = cap('openai-compatible', model);
      assert.equal(c.style, 'chat-effort', `${model} should use reasoning_effort`);
      assert.deepEqual(applyThinking('low', c).body, { reasoning_effort: 'low' });
    }
    assert.deepEqual(bodyFor('off', 'openai-compatible', 'gpt-5').body, { reasoning_effort: 'none' });
  });

  test('a non-reasoning chat/completions model is sent no field and shows no row', () => {
    // This is the rejection that matters most: a plain gpt-4o or a local llama answers 400 to
    // reasoning_effort, and Auto must not guess one onto it.
    for (const model of ['gpt-4o', 'llama-3-8b-instruct', 'mistral-small', 'gemma-2-9b']) {
      const c = cap('openai-compatible', model);
      assert.equal(supportsThinking(c), false, `${model} should show no Thinking row`);
      for (const level of THINKING_LEVELS) {
        assert.deepEqual(applyThinking(level, c).body, {}, `${model} must never receive a reasoning field (level ${level})`);
      }
    }
  });

  test('Qwen 3 goes through chat_template_kwargs, as a boolean', () => {
    const c = cap('openai-compatible', 'qwen3-32b');
    assert.equal(c.style, 'chat-template');
    assert.deepEqual(applyThinking('off', c).body, { chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(applyThinking('high', c).body, { chat_template_kwargs: { enable_thinking: true } });
    // A boolean has no ladder: the middle levels are not offered rather than silently rounded.
    assert.deepEqual(c.levels, ['default', 'off', 'high']);
  });

  test('the guess is conservative and the explicit setting overrides it', () => {
    assert.equal(guessReasoningField('gpt-5'), 'reasoning_effort');
    assert.equal(guessReasoningField('o3-mini'), 'reasoning_effort');
    assert.equal(guessReasoningField('Qwen3-8B'), 'enable_thinking');
    assert.equal(guessReasoningField('some-local-finetune'), 'none', 'an unknown id must be guessed as nothing');
    assert.equal(guessReasoningField(''), 'none');
    // An endpoint the guess gets wrong is corrected by the connection's own setting.
    assert.equal(cap('openai-compatible', 'my-finetune', 'reasoning_effort').style, 'chat-effort');
    assert.equal(cap('openai-compatible', 'gpt-5', 'none').style, 'none');
    assert.equal(cap('openai-compatible', 'gpt-5', 'enable_thinking').style, 'chat-template');
  });

  test('a stored reasoning field that is unknown reads as auto', () => {
    assert.equal(resolveReasoningField(undefined), 'auto');
    assert.equal(resolveReasoningField('nonsense'), 'auto');
    assert.equal(resolveReasoningField('reasoning_effort'), 'reasoning_effort');
  });
});

describe('titles and summaries run at the floor', () => {
  test('the lowest level is Off wherever a model can stop thinking', () => {
    assert.equal(lowestThinkingLevel(cap('anthropic', 'claude-opus-5')), 'off');
    assert.equal(lowestThinkingLevel(cap('chatgpt', 'gpt-5')), 'off');
    assert.equal(lowestThinkingLevel(cap('openai-compatible', 'gpt-5')), 'off');
    assert.equal(lowestThinkingLevel(cap('openai-compatible', 'qwen3-32b')), 'off');
  });

  test('where thinking cannot be stopped, it is the lowest level that exists', () => {
    // xAI always reasons, and Fable 5 always thinks: the floor is 'low', not an illegal 'off'.
    assert.equal(lowestThinkingLevel(cap('xai', 'grok-4.6')), 'low');
    assert.equal(lowestThinkingLevel(cap('anthropic', 'claude-fable-5')), 'low');
  });

  test('a model with no reasoning knob is left entirely alone', () => {
    assert.equal(lowestThinkingLevel(cap('openai-compatible', 'llama-3-8b')), 'default');
    assert.equal(lowestThinkingLevel(cap('xai', 'grok-4-fast')), 'default');
  });
});

describe('a server that refuses the reasoning field', () => {
  test('it recognises real refusals', () => {
    const real = [
      'Unrecognized request argument supplied: reasoning_effort',
      "{'error': {'message': \"This model does not support reasoning_effort.\"}}",
      'reasoning_effort is not supported for this model',
      'Extra inputs are not permitted',
      'chat_template_kwargs error: template has no variable enable_thinking',
    ];
    for (const body of real) assert.equal(isReasoningRejection(400, body), true, `not recognised: ${body}`);
  });

  test('it does NOT fire on other 400s, which must stay real errors', () => {
    // A false positive silently drops the level the user chose and never puts it back, so these
    // matter more than the matches above.
    const other = [
      'context length exceeded: 9000 tokens',
      'Invalid content type. image_url is only supported by certain models.',
      'invalid request',
      'tool schema is not valid JSON Schema',
      'model not found',
    ];
    for (const body of other) assert.equal(isReasoningRejection(400, body), false, `wrongly classified: ${body}`);
  });

  test('it ignores statuses that are not the server refusing a field', () => {
    assert.equal(isReasoningRejection(500, 'reasoning_effort is not supported'), false, 'a 5xx is an outage, not a refusal');
    assert.equal(isReasoningRejection(429, 'reasoning_effort is not supported'), false, 'a rate limit is not a refusal');
    assert.equal(isReasoningRejection(400, ''), false);
    assert.equal(isReasoningRejection(undefined, 'reasoning_effort is not supported'), false);
  });

  test('the memory key folds trailing slashes and case, like the vision key', () => {
    assert.equal(thinkingKey('http://Localhost:1234/v1/', 'gpt-5'), thinkingKey('http://localhost:1234/v1', 'gpt-5'));
    assert.notEqual(thinkingKey('http://localhost:1234/v1', 'gpt-5'), thinkingKey('http://localhost:1234/v1', 'gpt-4o'));
  });
});

describe('custom request fields', () => {
  test('an empty box is valid and contributes nothing', () => {
    assert.deepEqual(parseCustomFields(''), { ok: true, fields: {}, error: '' });
    assert.deepEqual(parseCustomFields('   '), { ok: true, fields: {}, error: '' });
  });

  test('a JSON object parses', () => {
    const r = parseCustomFields('{"reasoning_effort": "low", "top_p": 0.9}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.fields, { reasoning_effort: 'low', top_p: 0.9 });
  });

  test('anything that cannot be spread into a body is rejected with a reason', () => {
    for (const bad of ['[1,2]', '"text"', '42', '{nope}']) {
      const r = parseCustomFields(bad);
      assert.equal(r.ok, false, `${bad} should be rejected`);
      assert.ok(r.error, `${bad} should say why`);
      assert.deepEqual(r.fields, {}, `${bad} must contribute no fields`);
    }
  });

  test('an absurdly long box is rejected rather than sent on every request', () => {
    const r = parseCustomFields(`{"a": "${'x'.repeat(3000)}"}`);
    assert.equal(r.ok, false);
    assert.match(r.error, /Too long/);
  });
});

// ---------------------------------------------------------------------------
// The adapter: the field actually reaches the wire, and a refusal is survived
// ---------------------------------------------------------------------------

/** An SSE body that ends a turn with one line of text. Mirrors test/vision.test.ts's helper. */
function okStream(text = 'fine'): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } });
}

/** Swap global fetch for one test, recording every body sent. */
async function withFetch<T>(handler: (body: any, calls: number) => Response | Promise<Response>, fn: (sent: any[]) => Promise<T>): Promise<T> {
  const sent: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    return handler(body, sent.length);
  }) as typeof fetch;
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = original;
  }
}

/** A thinking memory backed by a plain Set, so the whole policy runs under node. */
function fakeThinkingMemory(initial: string[] = []) {
  const keys = new Set(initial);
  return { keys, isUnsupported: async (k: string) => keys.has(k), markUnsupported: async (k: string) => void keys.add(k) };
}

const chat = (settings: Settings, deps = {}) =>
  createOpenAIProvider(settings, deps).chat({ system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], callbacks: { onText: () => {} } });

const oaiSettings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  provider: 'openai-compatible',
  baseUrl: 'http://localhost:1234/v1',
  model: 'gpt-5',
  ...patch,
});

describe('the OpenAI-compatible adapter carries the level', () => {
  test('a chosen level puts reasoning_effort on the wire', async () => {
    await withFetch(
      () => okStream(),
      async (sent) => {
        await chat(oaiSettings({ thinking: 'low' }));
        assert.equal(sent.length, 1);
        assert.equal(sent[0].reasoning_effort, 'low');
      },
    );
  });

  test("'default' sends no reasoning field at all", async () => {
    await withFetch(
      () => okStream(),
      async (sent) => {
        await chat(oaiSettings({ thinking: 'default' }));
        assert.ok(!('reasoning_effort' in sent[0]), 'default must not send reasoning_effort');
        assert.ok(!('chat_template_kwargs' in sent[0]));
      },
    );
  });

  test('a non-reasoning model is sent nothing even at a raised level', async () => {
    await withFetch(
      () => okStream(),
      async (sent) => {
        await chat(oaiSettings({ model: 'llama-3-8b', thinking: 'high' }));
        assert.ok(!('reasoning_effort' in sent[0]), 'a model with no knob must never receive the field');
      },
    );
  });

  test('custom request fields are merged into the body', async () => {
    await withFetch(
      () => okStream(),
      async (sent) => {
        await chat(oaiSettings({ thinking: 'default', customFields: { top_p: 0.5, reasoning_effort: 'medium' } }));
        assert.equal(sent[0].top_p, 0.5);
        assert.equal(sent[0].reasoning_effort, 'medium', 'an explicitly typed field is sent even when the level is default');
      },
    );
  });
});

describe('the 400 fallback', () => {
  test('a refusal is retried once without the field, and remembered', async () => {
    const memory = fakeThinkingMemory();
    const told: string[] = [];
    await withFetch(
      (body, calls) => (calls === 1 && 'reasoning_effort' in body ? errorResponse(400, 'Unrecognized request argument supplied: reasoning_effort') : okStream()),
      async (sent) => {
        const res = await chat(oaiSettings({ thinking: 'high' }), { thinkingMemory: memory, onThinkingUnsupported: (k: string) => told.push(k) });
        // Two requests: the one that was refused, and the same conversation without the field.
        assert.equal(sent.length, 2, 'the request should have been sent again exactly once');
        assert.equal(sent[0].reasoning_effort, 'high');
        assert.ok(!('reasoning_effort' in sent[1]), 'the retry must not carry the field that was refused');
        // The history is otherwise identical: it is the same turn, not a different one.
        assert.deepEqual(sent[1].messages, sent[0].messages);
        // And the turn succeeded, rather than surfacing as an error.
        assert.equal(res.content.some((p) => p.type === 'text'), true);
        assert.equal(memory.keys.size, 1, 'the endpoint+model should be remembered');
        assert.equal(told.length, 1, 'the panel should be told once');
      },
    );
  });

  test('a remembered endpoint never sends the field again', async () => {
    const memory = fakeThinkingMemory([thinkingKey('http://localhost:1234/v1', 'gpt-5')]);
    await withFetch(
      () => okStream(),
      async (sent) => {
        await chat(oaiSettings({ thinking: 'high' }), { thinkingMemory: memory });
        assert.equal(sent.length, 1, 'a known-refusing endpoint should cost no second request');
        assert.ok(!('reasoning_effort' in sent[0]));
      },
    );
  });

  test('a 400 that is NOT about reasoning stays an error', async () => {
    const memory = fakeThinkingMemory();
    await withFetch(
      () => errorResponse(400, 'context length exceeded'),
      async (sent) => {
        await assert.rejects(() => chat(oaiSettings({ thinking: 'high' }), { thinkingMemory: memory }), /context length/);
        assert.equal(sent.length, 1, 'an unrelated 400 must not be retried');
        assert.equal(memory.keys.size, 0, 'an unrelated 400 must not mark the endpoint');
      },
    );
  });

  test('a server that refuses BOTH images and reasoning sheds them one at a time', async () => {
    // The two refusals are independent, and the second must not be hidden behind the first.
    const memory = fakeThinkingMemory();
    await withFetch(
      (body, calls) => {
        if (calls === 1) return errorResponse(400, 'Invalid content type. image_url is only supported by certain models.');
        if (calls === 2) return errorResponse(400, 'Unrecognized request argument supplied: reasoning_effort');
        return okStream();
      },
      async (sent) => {
        const messages: Msg[] = [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }, { type: 'text', text: 'look' }] }];
        await createOpenAIProvider(oaiSettings({ thinking: 'high', images: 'auto' }), { thinkingMemory: memory }).chat({
          system: 'SYS',
          messages,
          tools: [],
          callbacks: { onText: () => {} },
        });
        assert.equal(sent.length, 3, 'one send, one without images, one without either');
        assert.ok(!('reasoning_effort' in sent[2]), 'the final request carries neither');
        assert.equal(memory.keys.size, 1);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Three reasons to re-send, and none of them may loop
// ---------------------------------------------------------------------------
//
// After the fix/user-reports merge a single turn can be re-sent for three INDEPENDENT reasons:
//
//   images          lib/providers/openai.ts  — the endpoint refuses a picture      (adapter)
//   reasoning field lib/providers/openai.ts  — the endpoint refuses the knob       (adapter)
//   context overflow lib/agent/loop.ts       — the history is longer than the window (loop)
//
// The first two live inside one `chat()` call and are bounded by its own counter; the third lives
// outside it and re-enters `chat()` once. The danger is multiplication and mutual misreading: a
// context 400 mistaken for a reasoning refusal would silently drop the user's level AND skip the
// compaction that would actually have fixed it, and an adapter that re-sent on every pass would
// multiply the loop's one retry into several bills.
describe('the three re-send reasons compose without looping', () => {
  test('a context-overflow 400 is not mistaken for a reasoning or a vision refusal', () => {
    // Every phrasing here is one lib/agent/retry.ts lists as a real backend's overflow wording. If
    // either adapter classifier claimed one, the loop would never see it: the adapter would drop a
    // field, the re-send would overflow again, and the run would die with the level silently lost.
    const overflows = [
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9101 tokens",
      'prompt is too long: 215000 tokens > 200000 maximum',
      'the request exceeds the available context size',
      'input validation error: `inputs` must have less than 4096 tokens',
      'context_length_exceeded',
      'Please reduce the length of the messages',
      'input token count exceeds the maximum',
    ];
    for (const body of overflows) {
      assert.equal(isReasoningRejection(400, body), false, `claimed as a reasoning refusal: ${body}`);
      assert.equal(isVisionRejection(400, body), false, `claimed as a vision refusal: ${body}`);
      // And the loop's own classifier does recognise it, so it is handled by exactly one of the three.
      assert.equal(isContextLengthError(new ProviderError(body, { kind: 'http', status: 400 })), true, `not recognised as an overflow: ${body}`);
    }
  });

  test('a reasoning refusal is not mistaken for a context overflow', () => {
    // The converse: the loop must not compact a history that was never too long. That would spend a
    // summarisation call, throw away real turns, and still fail on the same rejected field.
    const refusal = 'Unrecognized request argument supplied: reasoning_effort';
    assert.equal(isContextLengthError(new ProviderError(refusal, { kind: 'http', status: 400 })), false);
    assert.equal(isReasoningRejection(400, refusal), true);
  });

  test('one chat() call sends at most three times, whatever the server refuses', async () => {
    // The adapter's own bound. A server that refuses everything must not be asked forever: images
    // go, then the reasoning field, then the failure is real and is thrown.
    const memory = fakeThinkingMemory();
    await withFetch(
      (body) => {
        if ((body.messages as any[]).some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))) {
          return errorResponse(400, 'Invalid content type. image_url is only supported by certain models.');
        }
        if ('reasoning_effort' in body) return errorResponse(400, 'Unrecognized request argument supplied: reasoning_effort');
        return errorResponse(400, 'something else entirely');
      },
      async (sent) => {
        const messages: Msg[] = [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }, { type: 'text', text: 'look' }] }];
        await assert.rejects(
          () =>
            createOpenAIProvider(oaiSettings({ thinking: 'high', images: 'auto' }), { thinkingMemory: memory }).chat({
              system: 'SYS',
              messages,
              tools: [],
              callbacks: { onText: () => {} },
            }),
          /something else entirely/,
          'the third failure is real and must surface rather than being retried again',
        );
        assert.equal(sent.length, 3, `the adapter sent ${sent.length} times; it must stop after shedding each thing once`);
      },
    );
  });

  test('a context overflow reaches the caller untouched, so the loop can compact and retry', async () => {
    // The adapter's job here is to do NOTHING: not to drop the level, not to drop the images, not
    // to re-send. One request, and the error propagates with its status intact so
    // isContextLengthError can see it.
    const memory = fakeThinkingMemory();
    await withFetch(
      () => errorResponse(400, "This model's maximum context length is 8192 tokens"),
      async (sent) => {
        const err = await chat(oaiSettings({ thinking: 'high' }), { thinkingMemory: memory }).then(
          () => null,
          (e) => e,
        );
        assert.equal(sent.length, 1, 'the adapter must not re-send on an overflow; that is the loop\'s retry to make');
        assert.equal(memory.keys.size, 0, 'an overflow must not be remembered as a reasoning refusal');
        assert.equal(isContextLengthError(err), true, 'the overflow did not survive the adapter as a recognisable error');
      },
    );
  });

  test('after a reasoning refusal, the loop\'s retry costs one request, not another fallback', async () => {
    // The composition that matters for the bill. Turn 1 discovers the refusal (2 sends). The loop
    // then compacts and calls chat() again — and because the refusal was REMEMBERED, that second
    // call sends once, with no field and no rediscovery. Three sends for the whole turn, not four.
    const memory = fakeThinkingMemory();
    await withFetch(
      (body) => ('reasoning_effort' in body ? errorResponse(400, 'Unrecognized request argument supplied: reasoning_effort') : okStream()),
      async (sent) => {
        const settings = oaiSettings({ thinking: 'high' });
        await chat(settings, { thinkingMemory: memory });
        assert.equal(sent.length, 2, 'the first call should discover the refusal in two sends');
        // The loop's single retry, re-entering the adapter with the same settings.
        await chat(settings, { thinkingMemory: memory });
        assert.equal(sent.length, 3, 'the retry re-discovered the refusal instead of remembering it');
        assert.ok(!('reasoning_effort' in sent[2]), 'the retry must not carry the field again');
      },
    );
  });
});
