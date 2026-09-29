// Images on an OpenAI-compatible backend: the message conversion, the rejection classifier, the
// Auto fallback, and the setting that governs all three.
//
// The bug this covers: the adapter used to turn every image inside a tool_result into the text
// "[image omitted: this backend does not accept images in tool results]". That sentence was about
// the SHAPE of a `tool` message — which genuinely cannot hold a picture — but it was applied to
// every backend, so a vision model behind a custom OpenAI endpoint was told its own screenshots
// were unavailable. lib/providers/responses.ts had already solved the identical problem by putting
// the picture in the message after the tool output; this brings the chat-completions adapter in
// line and adds the fallback a text-only endpoint needs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { toOpenAIMessages, hasImages, createOpenAIProvider, type OAIMessage } from '../lib/providers/openai.ts';
import {
  ATTACHMENT_UNSUPPORTED_NOTE,
  IMAGE_FORWARDED_NOTE,
  IMAGE_UNSUPPORTED_NOTE,
  isVisionRejection,
  resolveImagesSetting,
  shouldSendImages,
  visionKey,
  visionKeyFor,
  type VisionMemory,
} from '../lib/providers/vision.ts';
import { compact } from '../lib/agent/compact.ts';
import { SCREENSHOT_DESCRIPTION, SCREENSHOT_DESCRIPTION_BLIND, TOOLS, toolsFor } from '../lib/agent/tools.ts';
import { DEFAULT_SETTINGS, type Msg, type Part, type Settings } from '../lib/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PNG: Extract<Part, { type: 'image' }> = { type: 'image', mediaType: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' };
const JPEG: Extract<Part, { type: 'image' }> = { type: 'image', mediaType: 'image/jpeg', data: 'anBlZy1ieXRlcw==' };

const assistantCalls = (...calls: Array<{ id: string; name: string }>): Msg => ({
  role: 'assistant',
  content: calls.map((c) => ({ type: 'tool_call', id: c.id, name: c.name, input: {} })),
});

/** The roles of a converted history, which is what the chat/completions ordering rules are about. */
const roles = (out: OAIMessage[]) => out.map((m) => m.role);

const partsOf = (m: OAIMessage) => (Array.isArray(m.content) ? m.content : []);

/** A memory backed by a plain Set, so the whole policy runs under node. */
function fakeMemory(initial: string[] = []): VisionMemory & { keys: Set<string> } {
  const keys = new Set(initial);
  return {
    keys,
    isUnsupported: async (k) => keys.has(k),
    isUnsupportedNow: (k) => keys.has(k),
    markUnsupported: async (k) => void keys.add(k),
  };
}

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  provider: 'openai-compatible',
  baseUrl: 'http://example.test/v1',
  model: 'test-model',
  ...patch,
});

/** An SSE body that ends a turn with one line of text, which is all these tests need back. */
function okStream(text = 'fine'): Response {
  const body = [`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`, 'data: [DONE]', ''].join('\n\n');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } });
}

/** Swap global fetch for the duration of one test, recording every body sent. */
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

/** Every image_url part of one request body, in order. */
const imageParts = (body: any) =>
  (body.messages as any[]).flatMap((m, i) => (Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'image_url').map((p: any) => ({ message: i, role: m.role, url: p.image_url.url })) : []));

// ---------------------------------------------------------------------------
// Message conversion: a screenshot reaches the model
// ---------------------------------------------------------------------------

test('a screenshot in a tool result is sent as an image, in the user message after the tool messages', () => {
  const messages: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'is the banner gone?' }] },
    assistantCalls({ id: 'call_1', name: 'screenshot' }),
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call_1', content: [PNG] }] },
  ];
  const out = toOpenAIMessages('SYS', messages);

  // The ordering chat/completions requires: the tool message follows its assistant message with
  // nothing in between, and the picture comes after, not before.
  assert.deepEqual(roles(out), ['system', 'user', 'assistant', 'tool', 'user']);

  const toolMsg = out[3] as Extract<OAIMessage, { role: 'tool' }>;
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.equal(toolMsg.content, IMAGE_FORWARDED_NOTE, 'the tool text must point at the image rather than deny it');
  assert.ok(!/does not accept images/i.test(toolMsg.content), 'the old "backend does not accept images" text must be gone');

  const follow = partsOf(out[4]!);
  assert.equal(follow.length, 2, 'a naming text part, then the picture');
  assert.equal(follow[0]!.type, 'text');
  assert.match((follow[0] as any).text, /call_1/, 'the image is attributed to the call that produced it');
  assert.equal(follow[1]!.type, 'image_url');
  assert.equal((follow[1] as any).image_url.url, `data:image/png;base64,${PNG.data}`);
});

test('two screenshots in one turn stay in order and each names its own call', () => {
  const messages: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'compare them' }] },
    assistantCalls({ id: 'call_a', name: 'screenshot' }, { id: 'call_b', name: 'screenshot' }),
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'call_a', content: [PNG] },
        { type: 'tool_result', toolCallId: 'call_b', content: [JPEG] },
      ],
    },
  ];
  const out = toOpenAIMessages('SYS', messages);

  // Both tool messages before the single user message: a user message wedged between them would be
  // rejected by the API, and is exactly the mistake a naive per-result fix makes.
  assert.deepEqual(roles(out), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal((out[3] as any).tool_call_id, 'call_a');
  assert.equal((out[4] as any).tool_call_id, 'call_b');

  const parts = partsOf(out[5]!);
  assert.deepEqual(
    parts.map((p: any) => p.type),
    ['text', 'image_url', 'text', 'image_url'],
  );
  assert.match((parts[0] as any).text, /call_a/);
  assert.equal((parts[1] as any).image_url.url, `data:image/png;base64,${PNG.data}`);
  assert.match((parts[2] as any).text, /call_b/);
  assert.equal((parts[3] as any).image_url.url, `data:image/jpeg;base64,${JPEG.data}`);
});

test('a tool result carrying text AND an image keeps the text in the tool message', () => {
  const messages: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    assistantCalls({ id: 'c1', name: 'screenshot' }),
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: [{ type: 'text', text: 'captured 1568x980' }, PNG] }] },
  ];
  const out = toOpenAIMessages('SYS', messages);
  assert.equal((out[3] as any).content, `captured 1568x980\n${IMAGE_FORWARDED_NOTE}`);
  assert.equal(partsOf(out[4]!).filter((p: any) => p.type === 'image_url').length, 1);
});

test('a message queued mid-run merges into the image message rather than making a second user message', () => {
  // The loop appends a queued user turn to the same message as the tool results. Two consecutive
  // user messages are legal but read as two turns, and the queued words would be attributed to the
  // screenshot instead of to the person who typed them.
  const messages: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    assistantCalls({ id: 'c1', name: 'screenshot' }),
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'c1', content: [PNG] },
        JPEG,
        { type: 'text', text: 'also make it blue' },
      ],
    },
  ];
  const out = toOpenAIMessages('SYS', messages);
  assert.deepEqual(roles(out), ['system', 'user', 'assistant', 'tool', 'user']);
  const parts = partsOf(out[4]!);
  assert.deepEqual(
    parts.map((p: any) => p.type),
    ['text', 'image_url', 'image_url', 'text'],
    'the tool image and its caption first, then the queued turn exactly as the loop built it',
  );
  assert.equal((parts[3] as any).text, 'also make it blue');
});

test('a history with no images converts to plain string content, as it always did', () => {
  const messages: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    assistantCalls({ id: 'c1', name: 'get_page' }),
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: [{ type: 'text', text: '<html>' }] }] },
  ];
  const out = toOpenAIMessages('SYS', messages);
  // No trailing user message: a turn that is nothing but tool results has nothing left to say, and
  // an empty user message is a 400 on most backends. This is the behaviour the change preserves.
  assert.deepEqual(roles(out), ['system', 'user', 'assistant', 'tool']);
  assert.equal(typeof out[1]!.content, 'string');
  assert.equal(out[3]!.content, '<html>');
});

test('an errored tool result carrying an image still reads as an error', () => {
  const messages: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    assistantCalls({ id: 'c1', name: 'screenshot' }),
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: [{ type: 'text', text: 'partial' }, PNG], isError: true }] },
  ];
  const out = toOpenAIMessages('SYS', messages);
  assert.match((out[3] as any).content, /^ERROR: partial/);
});

// ---------------------------------------------------------------------------
// The same conversion with images switched off
// ---------------------------------------------------------------------------

test('with images off the shape is identical and every picture becomes a sentence', () => {
  const messages: Msg[] = [
    { role: 'user', content: [JPEG, { type: 'text', text: 'like this' }] },
    assistantCalls({ id: 'c1', name: 'screenshot' }),
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: [PNG] }] },
  ];
  const on = toOpenAIMessages('SYS', messages, true);
  const off = toOpenAIMessages('SYS', messages, false);

  // The tool messages are identical in both modes — same count, same ids, same position — which is
  // the half of the shape the API is strict about. The only difference is the extra user message
  // that carries the picture when there is one to carry: with images off there is nothing to put
  // in it, and an empty user message would itself be a 400.
  assert.deepEqual(roles(on), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.deepEqual(roles(off), ['system', 'user', 'assistant', 'tool']);
  assert.deepEqual(
    on.filter((m) => m.role === 'tool').map((m) => (m as any).tool_call_id),
    off.filter((m) => m.role === 'tool').map((m) => (m as any).tool_call_id),
  );

  assert.equal((off[3] as any).content, IMAGE_UNSUPPORTED_NOTE);
  assert.match((off[3] as any).content, /get_styles|find_elements|get_page/, 'a blind model is steered at structural tools');

  // Nothing anywhere is an image part any more.
  assert.equal(JSON.stringify(off).includes('image_url'), false);
  // The user's own attachment is accounted for too, not silently dropped.
  assert.match(JSON.stringify(off), new RegExp(ATTACHMENT_UNSUPPORTED_NOTE.slice(1, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('hasImages sees both a tool-result screenshot and a user attachment, and nothing else', () => {
  assert.equal(hasImages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), false);
  assert.equal(hasImages([{ role: 'user', content: [PNG] }]), true);
  assert.equal(hasImages([{ role: 'user', content: [{ type: 'tool_result', toolCallId: 'c', content: [PNG] }] }]), true);
  assert.equal(hasImages([{ role: 'user', content: [{ type: 'tool_result', toolCallId: 'c', content: [{ type: 'text', text: 'x' }] }] }]), false);
});

// ---------------------------------------------------------------------------
// Compaction: an elided screenshot must not come back
// ---------------------------------------------------------------------------

test('a screenshot elided by compaction is not resurrected as an image part', async () => {
  // A long history whose old screenshots have been replaced by stubs. The adapter reads the
  // CONTENT of each tool_result, so once compaction has swapped the image for text there is
  // nothing left for it to attach — which is what keeps the context budget honest.
  const big = 'x'.repeat(40_000);
  const messages: Msg[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `turn ${i}` }] });
    messages.push(assistantCalls({ id: `shot_${i}`, name: 'screenshot' }, { id: `page_${i}`, name: 'get_page' }));
    messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: `shot_${i}`, content: [{ type: 'image', mediaType: 'image/jpeg', data: 'anBlZy1ieXRlcw==' }] },
        { type: 'tool_result', toolCallId: `page_${i}`, content: [{ type: 'text', text: big }] },
      ],
    });
  }
  const res = await compact(messages, { budget: 20_000, signal: new AbortController().signal, hasDraft: false });
  assert.ok(res.steps.length, 'the history was compacted');

  const out = toOpenAIMessages('SYS', res.messages);
  const images = out.flatMap((m) => partsOf(m).filter((p: any) => p.type === 'image_url'));
  // Compaction leaves the two most recent user turns alone, so their screenshots survive; the four
  // older ones are stubs (or summarised away) and the adapter finds no image left to attach.
  assert.equal(images.length, 2, 'only the screenshots in the two most recent turns survive compaction');

  // And the conversion is still valid: every tool message answers a call that came before it.
  const seen = new Set<string>();
  out.forEach((m) => {
    if (m.role === 'assistant') for (const c of (m as any).tool_calls ?? []) seen.add(c.id);
    if (m.role === 'tool') assert.ok(seen.has((m as any).tool_call_id), `orphan tool message for ${(m as any).tool_call_id}`);
  });
});

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

test('a vision rejection is recognised from the wordings real backends use', () => {
  const rejections = [
    'Invalid content type. image_url is only supported by certain models.',
    "This model does not support images.",
    'Image input is not supported for this model',
    'multimodal content is not supported by this endpoint',
    'No endpoints found that support image input',
    'the model is not multimodal',
    'vision is not supported',
    'Unsupported content part type: image_url',
    'image_url is not a valid content type for this model',
    "model 'qwen3:4b' does not support images",
  ];
  for (const body of rejections) {
    assert.equal(isVisionRejection(400, JSON.stringify({ error: { message: body } })), true, `not recognised: ${body}`);
  }
});

test('the classifier is conservative: anything that is not about images is not a vision rejection', () => {
  // Every one of these arrives as a 400 on a request that happened to carry an image. Treating any
  // of them as "this model has no eyes" would silently blind a working vision model forever, which
  // is a worse bug than the one being fixed.
  const others = [
    'Invalid API key provided',
    "model 'gpt-9' does not exist",
    "This model's maximum context length is 8192 tokens, however you requested 9001",
    'tool_calls must be followed by tool messages',
    'rate limit exceeded',
    'Invalid request: messages[3] has empty content',
    'tools[0].function.parameters is invalid',
    'content filter triggered',
  ];
  for (const body of others) {
    assert.equal(isVisionRejection(400, JSON.stringify({ error: { message: body } })), false, `wrongly classified: ${body}`);
  }
});

test('only a chosen 4xx counts: server errors, rate limits and oversize payloads are not vision rejections', () => {
  const msg = JSON.stringify({ error: { message: 'this model does not support images' } });
  assert.equal(isVisionRejection(400, msg), true);
  assert.equal(isVisionRejection(422, msg), true, 'some backends answer 422 for a bad content part');
  assert.equal(isVisionRejection(500, msg), false, 'a 5xx is the server failing, and is worth retrying');
  assert.equal(isVisionRejection(503, msg), false);
  assert.equal(isVisionRejection(429, msg), false, 'a rate limit is retryable and says nothing about vision');
  assert.equal(isVisionRejection(413, msg), false, 'too large is about this picture, not about the model');
  assert.equal(isVisionRejection(undefined, msg), false);
  assert.equal(isVisionRejection(400, ''), false, 'an empty body proves nothing');
  assert.equal(isVisionRejection(400, undefined), false);
});

// ---------------------------------------------------------------------------
// The setting and the key
// ---------------------------------------------------------------------------

test('the Images setting defaults to auto and only takes its three values', () => {
  assert.equal(DEFAULT_SETTINGS.images, 'auto');
  assert.equal(resolveImagesSetting(undefined), 'auto', 'a profile saved before the setting existed');
  assert.equal(resolveImagesSetting('auto'), 'auto');
  assert.equal(resolveImagesSetting('send'), 'send');
  assert.equal(resolveImagesSetting('never'), 'never');
  assert.equal(resolveImagesSetting('yes'), 'auto', 'a corrupt value reads as the default');
  assert.equal(resolveImagesSetting(null), 'auto');
});

test('shouldSendImages: Never never asks, Send never remembers, Auto obeys what was learned', async () => {
  const known = fakeMemory(['http://x/v1|blind']);
  assert.equal(await shouldSendImages('never', 'http://x/v1|sighted', known), false);
  assert.equal(await shouldSendImages('send', 'http://x/v1|blind', known), true, 'Send overrides what was learned, on purpose');
  assert.equal(await shouldSendImages('auto', 'http://x/v1|blind', known), false);
  assert.equal(await shouldSendImages('auto', 'http://x/v1|sighted', known), true);
});

test('the memory key is per endpoint AND per model, and normalises the base URL', () => {
  // One Ollama server hosts a vision model and a text-only one; remembering the server alone would
  // blind both the moment either refused.
  assert.notEqual(visionKey('http://localhost:11434/v1', 'llava'), visionKey('http://localhost:11434/v1', 'qwen3'));
  assert.equal(visionKey('http://localhost:11434/v1/', 'm'), visionKey('http://localhost:11434/v1', 'm'));
  assert.equal(visionKey('HTTP://Localhost:11434/V1', 'm'), visionKey('http://localhost:11434/v1', 'm'));
  // An empty base URL is the default endpoint, spelled the one way the adapter spells it.
  assert.equal(visionKeyFor({ baseUrl: '', model: 'gpt-5' }), visionKeyFor({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }));
});

// ---------------------------------------------------------------------------
// The Auto fallback, against a fake fetch
// ---------------------------------------------------------------------------

const SHOT: Msg[] = [
  { role: 'user', content: [{ type: 'text', text: 'check it' }] },
  assistantCalls({ id: 'c1', name: 'screenshot' }),
  { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: [PNG] }] },
];

const chatArgs = { system: 'SYS', messages: SHOT, tools: TOOLS, callbacks: { onText: () => {} } };

test('Auto: a vision rejection is retried once without images, remembered, and skipped from then on', async () => {
  const memory = fakeMemory();
  const told: string[] = [];
  const provider = createOpenAIProvider(settings(), { memory, onVisionUnsupported: (k) => told.push(k) });

  await withFetch(
    (_body, n) => (n === 1 ? errorResponse(400, 'This model does not support images.') : okStream()),
    async (sent) => {
      const res = await provider.chat(chatArgs as any);
      assert.equal(res.stopReason, 'end_turn', 'the run completed rather than failing');

      assert.equal(sent.length, 2, 'exactly two requests: the attempt and the one immediate re-send');
      assert.equal(imageParts(sent[0]).length, 1, 'the first request really did carry the picture');
      assert.equal(imageParts(sent[1]).length, 0, 'the second carried none');

      // The second request is a valid history in its own right, not the first one with holes in it:
      // the tool message still answers its call, and the user message that only existed to carry
      // the picture is gone rather than left empty.
      assert.deepEqual(
        (sent[1].messages as any[]).map((m) => m.role),
        ['system', 'user', 'assistant', 'tool'],
      );
      assert.equal((sent[1].messages as any[])[3].tool_call_id, 'c1');
      assert.equal((sent[1].messages as any[])[3].content, IMAGE_UNSUPPORTED_NOTE);
    },
  );

  assert.deepEqual([...memory.keys], [visionKeyFor(settings())], 'the endpoint+model was remembered');
  assert.deepEqual(told, [visionKeyFor(settings())], 'the panel was told once');

  // A later request on the same provider skips the image without paying for another 400.
  await withFetch(
    () => okStream(),
    async (sent) => {
      await provider.chat(chatArgs as any);
      assert.equal(sent.length, 1, 'no fallback was needed the second time');
      assert.equal(imageParts(sent[0]).length, 0);
    },
  );
});

test('Auto: a 400 that is NOT about images is thrown, with no fallback and nothing remembered', async () => {
  const memory = fakeMemory();
  const told: string[] = [];
  const provider = createOpenAIProvider(settings(), { memory, onVisionUnsupported: (k) => told.push(k) });

  await withFetch(
    () => errorResponse(400, 'Invalid API key provided'),
    async (sent) => {
      await assert.rejects(() => provider.chat(chatArgs as any), /Invalid API key/);
      assert.equal(sent.length, 1, 'a bad key must not be retried without the picture');
    },
  );
  assert.equal(memory.keys.size, 0);
  assert.deepEqual(told, []);
});

test('Auto: the fallback is a single re-send — a second failure is thrown for withRetry to judge', async () => {
  // The composition rule. A vision rejection is `rejected` and backoff will not fix it, so the
  // fallback is one immediate re-send rather than a retry. If THAT request fails with something
  // retryable, it leaves this adapter as an ordinary ProviderError and lib/agent/retry.ts decides.
  const memory = fakeMemory();
  const provider = createOpenAIProvider(settings(), { memory });
  await withFetch(
    (_b, n) => (n === 1 ? errorResponse(400, 'image input is not supported') : new Response('upstream is down', { status: 503, statusText: 'Service Unavailable' })),
    async (sent) => {
      const err = await provider.chat(chatArgs as any).then(
        () => null,
        (e) => e,
      );
      assert.ok(err, 'the second failure surfaced');
      assert.equal(err.kind, 'http');
      assert.equal(err.status, 503, 'a retryable status, which withRetry will back off on');
      assert.equal(sent.length, 2, 'the fallback was tried once and only once');
    },
  );
  assert.equal(memory.keys.size, 1, 'the endpoint is still remembered as blind, so the retry does not re-discover it');
});

test('Never: no image is ever sent, and no request is spent finding out', async () => {
  const memory = fakeMemory();
  const provider = createOpenAIProvider(settings({ images: 'never' }), { memory });
  await withFetch(
    () => okStream(),
    async (sent) => {
      await provider.chat(chatArgs as any);
      assert.equal(sent.length, 1);
      assert.equal(imageParts(sent[0]).length, 0);
      assert.equal((sent[0].messages as any[])[3].content, IMAGE_UNSUPPORTED_NOTE);
    },
  );
  assert.equal(memory.keys.size, 0, 'Never learns nothing, because it never asks');
});

test('Send: the rejection is surfaced rather than worked around, and nothing is remembered', async () => {
  // Someone who chose Always send is telling us the model has vision. Quietly degrading would hide
  // a misconfiguration they asked to be told about.
  const memory = fakeMemory();
  const provider = createOpenAIProvider(settings({ images: 'send' }), { memory });
  await withFetch(
    () => errorResponse(400, 'this model does not support images'),
    async (sent) => {
      await assert.rejects(() => provider.chat(chatArgs as any), /does not support images/);
      assert.equal(sent.length, 1);
    },
  );
  assert.equal(memory.keys.size, 0);
});

test('a user attachment gets the same fallback as a screenshot', async () => {
  const memory = fakeMemory();
  const provider = createOpenAIProvider(settings(), { memory });
  const attached: Msg[] = [{ role: 'user', content: [JPEG, { type: 'text', text: 'make it look like this' }] }];
  await withFetch(
    (_b, n) => (n === 1 ? errorResponse(400, 'Invalid content type. image_url is only supported by certain models.') : okStream()),
    async (sent) => {
      await provider.chat({ ...chatArgs, messages: attached } as any);
      assert.equal(sent.length, 2);
      assert.equal(imageParts(sent[0]).length, 1);
      assert.equal(imageParts(sent[1]).length, 0);
      // The model is told the picture existed and could not be shown, so it does not answer as if
      // the user sent nothing.
      assert.match(JSON.stringify(sent[1].messages), /attached image not sent/i);
    },
  );
});

test('a history with no images takes the plain path and never consults the memory', async () => {
  let asked = 0;
  const memory: VisionMemory = { isUnsupported: async () => (asked++, true), isUnsupportedNow: () => true, markUnsupported: async () => {} };
  const provider = createOpenAIProvider(settings(), { memory });
  await withFetch(
    () => okStream(),
    async (sent) => {
      await provider.chat({ ...chatArgs, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] } as any);
      assert.equal(sent.length, 1);
    },
  );
  assert.equal(asked, 0, 'a text-only turn should not pay for a storage read');
});

// ---------------------------------------------------------------------------
// What the model is told about `screenshot`
// ---------------------------------------------------------------------------

test('the screenshot tool is described according to whether the model can see one', () => {
  const sighted = toolsFor(true).find((t) => t.name === 'screenshot')!;
  const blind = toolsFor(false).find((t) => t.name === 'screenshot')!;

  assert.equal(sighted.description, SCREENSHOT_DESCRIPTION);
  assert.ok(!/do not call it/i.test(sighted.description), 'a vision model must not be discouraged from taking screenshots');

  assert.equal(blind.description, SCREENSHOT_DESCRIPTION_BLIND);
  assert.match(blind.description, /get_styles/);
  assert.match(blind.description, /find_elements/);

  // The tool is still OFFERED either way: removing it would leave earlier screenshot calls in the
  // history referring to a function the model is no longer shown, which several backends reject.
  assert.equal(toolsFor(false).length, TOOLS.length);
  assert.deepEqual(toolsFor(false).map((t) => t.name), TOOLS.map((t) => t.name));
  assert.equal(toolsFor(true), TOOLS, 'the ordinary case allocates nothing');
});
