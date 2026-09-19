// Swapping the model mid-conversation, which means sending a history ONE backend wrote to ANOTHER.
//
// The history is provider-neutral (`Msg/Part`) and each adapter converts it for its own wire
// protocol, so a swap is safe exactly when every adapter produces a valid request from a history
// any other adapter produced. This file builds such a history — turns written the way each of the
// three adapters really records them, with tool calls, tool results, images (the user's and a
// screenshot's), a compaction summary and the awkward leftovers a real session has — and checks
// every direction against the rules each API actually enforces:
//
//   Anthropic Messages   ids match ^[a-zA-Z0-9_-]+$; no empty or whitespace-only text block; no
//                        empty message; every tool_use answered in the NEXT message, tool_results
//                        first in it; no thinking block that another model signed.
//   chat/completions     every tool message directly follows the assistant message whose call it
//                        answers, all calls answered; no assistant message with neither content nor
//                        tool_calls; images only in user messages.
//   Responses            every function_call has its function_call_output and vice versa; a
//                        reasoning item only when this tag AND this model wrote it, and never as the
//                        last item of a turn.
//
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { SUMMARY_PREFIX } from '../lib/agent/compact.ts';
import { toAnthropicMessages } from '../lib/providers/anthropic.ts';
import { toOpenAIMessages } from '../lib/providers/openai.ts';
import { toInput } from '../lib/providers/responses.ts';
import type { Msg, Part } from '../lib/types.ts';

const PNG = 'iVBORw0KGgo=';
const text = (t: string): Part => ({ type: 'text', text: t });
const image = (): Part => ({ type: 'image', mediaType: 'image/png', data: PNG });

// ---------------------------------------------------------------------------
// Turns, written the way each adapter records them
// ---------------------------------------------------------------------------

/** lib/providers/anthropic.ts: text and tool_use blocks; thinking is dropped before it is stored. */
function anthropicTurn(n: number): Msg[] {
  const id = `toolu_01A${n}bcDEF`;
  return [
    { role: 'user', content: [image(), text(`[Current page: Example — https://example.com/]\n\nanthropic turn ${n}`)] },
    { role: 'assistant', content: [text('Let me look at the page.'), { type: 'tool_call', id, name: 'get_page', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: id, content: [text('<html>page</html>')] }] },
    { role: 'assistant', content: [text(`Anthropic answer ${n}.`)] },
  ];
}

/**
 * lib/providers/openai.ts, against the kind of server people really point it at: a local model that
 * emits "\n\n" before its tool call, and mints ids the Messages API would reject.
 */
function openaiTurn(n: number, ids: [string, string] = [`functions.get_page:${n}`, `call_${n}`]): Msg[] {
  return [
    { role: 'user', content: [text(`openai turn ${n}`)] },
    {
      role: 'assistant',
      content: [text('\n\n'), { type: 'tool_call', id: ids[0], name: 'get_page', input: {} }, { type: 'tool_call', id: ids[1], name: 'screenshot', input: {} }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: ids[0], content: [text('<html>page</html>')] },
        // A screenshot: an image inside a tool result.
        { type: 'tool_result', toolCallId: ids[1], content: [text('Captured the visible tab.'), image()] },
        // A nudge and a queued user message ride along after the results (lib/agent/loop.ts).
        text('You have read the page several times.'),
        text('also make it blue'),
      ],
    },
    { role: 'assistant', content: [text(`OpenAI answer ${n}.`)] },
  ];
}

/** lib/providers/responses.ts: one opaque item per output item, then the neutral parts derived from them. */
function responsesTurn(n: number, tag: 'chatgpt' | 'xai', model: string | undefined): Msg[] {
  const callId = `call_r${tag}${n}`;
  const opaque = (item: Record<string, unknown>): Part => ({ type: 'opaque', provider: tag, ...(model ? { model } : {}), item });
  return [
    { role: 'user', content: [text(`${tag} turn ${n}`)] },
    {
      role: 'assistant',
      content: [
        opaque({ type: 'reasoning', id: `rs_${tag}${n}`, encrypted_content: `SECRET-${tag}-${model}-${n}`, summary: [] }),
        opaque({ type: 'function_call', id: `fc_${tag}${n}`, call_id: callId, name: 'find_elements', arguments: '{"selector":"h1"}' }),
        { type: 'tool_call', id: callId, name: 'find_elements', input: { selector: 'h1' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: callId, content: [text('1 match')], isError: false }] },
    {
      role: 'assistant',
      content: [
        opaque({ type: 'reasoning', id: `rs_${tag}${n}b`, encrypted_content: `SECRET-${tag}-${model}-${n}b`, summary: [] }),
        opaque({ type: 'message', id: `msg_${tag}${n}`, role: 'assistant', content: [{ type: 'output_text', text: `${tag} answer ${n}.` }] }),
        text(`${tag} answer ${n}.`),
      ],
    },
  ];
}

/** The leftovers: a turn that was all reasoning, a reply that came back empty, an errored tool. */
function awkward(): Msg[] {
  return [
    { role: 'user', content: [text('awkward turn')] },
    { role: 'assistant', content: [{ type: 'opaque', provider: 'chatgpt', model: 'gpt-a', item: { type: 'reasoning', id: 'rs_cut', encrypted_content: 'SECRET-cut' } }] },
    { role: 'user', content: [text('are you there?')] },
    { role: 'assistant', content: [] },
    { role: 'user', content: [text('try once more')] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'toolu_err', name: 'run_script', input: { code: 'x(' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'toolu_err', content: [text('SyntaxError'), text('')], isError: true }] },
    { role: 'assistant', content: [text('That failed; here is another way.')] },
  ];
}

const summary = (): Msg => ({ role: 'user', content: [text(`${SUMMARY_PREFIX}\n\nThe user wanted the sidebar hidden.`)] });

// ---------------------------------------------------------------------------
// The rules, per wire protocol
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;

function assertAnthropicValid(messages: Msg[], label: string) {
  const out = toAnthropicMessages(messages) as unknown as Array<{ role: string; content: Block[] }>;
  assert.ok(out.length > 0, `${label}: nothing to send`);
  assert.equal(out[0]?.role, 'user', `${label}: the first message must be the user's`);
  out.forEach((m, i) => {
    assert.ok(Array.isArray(m.content) && m.content.length > 0, `${label}: message ${i} is empty`);
    for (const b of m.content) {
      assert.ok(['text', 'image', 'tool_use', 'tool_result'].includes(String(b.type)), `${label}: message ${i} carries a ${b.type} block`);
      if (b.type === 'text') assert.ok(String(b.text).trim(), `${label}: message ${i} has an empty text block`);
      if (b.type === 'tool_use') assert.match(String(b.id), /^[a-zA-Z0-9_-]{1,64}$/, `${label}: tool_use id ${b.id}`);
      if (b.type === 'tool_result') {
        assert.match(String(b.tool_use_id), /^[a-zA-Z0-9_-]{1,64}$/, `${label}: tool_result id ${b.tool_use_id}`);
        for (const c of b.content as Block[]) if (c.type === 'text') assert.ok(String(c.text).trim(), `${label}: empty text inside a tool_result`);
      }
    }
    // Every tool_use is answered in the very next message, by tool_result blocks that come first.
    const uses = m.content.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
    const ids = new Set(uses);
    assert.equal(ids.size, uses.length, `${label}: duplicate tool_use ids in message ${i}`);
    if (uses.length) {
      assert.equal(m.role, 'assistant', `${label}: tool_use in a ${m.role} message`);
      const next = out[i + 1];
      assert.ok(next && next.role === 'user', `${label}: tool_use in message ${i} has no following user message`);
      const firstOther = next.content.findIndex((b) => b.type !== 'tool_result');
      const results = next.content.filter((b) => b.type === 'tool_result');
      if (firstOther >= 0) assert.ok(next.content.slice(firstOther).every((b) => b.type !== 'tool_result'), `${label}: a tool_result after other content in message ${i + 1}`);
      assert.deepEqual(results.map((b) => String(b.tool_use_id)).sort(), [...uses].sort(), `${label}: message ${i + 1} does not answer exactly the calls of message ${i}`);
    }
    const results = m.content.filter((b) => b.type === 'tool_result');
    if (results.length) {
      const prev = out[i - 1];
      const prevUses = new Set((prev?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => String(b.id)));
      for (const r of results) assert.ok(prevUses.has(String(r.tool_use_id)), `${label}: orphan tool_result ${r.tool_use_id}`);
    }
  });
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes('SECRET-'), `${label}: another backend's reasoning reached Anthropic`);
  assert.ok(!/"type":"(redacted_)?thinking"/.test(wire), `${label}: a thinking block was sent`);
}

function assertOpenAIValid(messages: Msg[], label: string, sendImages = true) {
  const out = toOpenAIMessages('system prompt', messages, sendImages);
  assert.equal(out[0]?.role, 'system');
  let pending: string[] = [];
  out.forEach((m, i) => {
    if (m.role === 'tool') {
      assert.ok(pending.includes(m.tool_call_id), `${label}: tool message ${m.tool_call_id} at ${i} answers no open call`);
      pending = pending.filter((id) => id !== m.tool_call_id);
      assert.equal(typeof m.content, 'string', `${label}: a tool message must be text`);
      return;
    }
    assert.deepEqual(pending, [], `${label}: message ${i} (${m.role}) arrived while calls were unanswered`);
    if (m.role === 'assistant') {
      assert.ok((typeof m.content === 'string' && m.content.trim()) || m.tool_calls?.length, `${label}: assistant message ${i} has neither content nor tool_calls`);
      pending = (m.tool_calls ?? []).map((c) => c.id);
      assert.equal(new Set(pending).size, pending.length, `${label}: duplicate tool_call ids`);
    }
    if (m.role === 'user') {
      assert.ok(typeof m.content === 'string' ? m.content : m.content.length, `${label}: empty user message ${i}`);
      if (!sendImages) assert.equal(typeof m.content, 'string', `${label}: an image part was sent with images off`);
    }
  });
  assert.deepEqual(pending, [], `${label}: the history ends with unanswered calls`);
  assert.ok(!JSON.stringify(out).includes('SECRET-'), `${label}: a reasoning item reached chat/completions`);
}

function assertResponsesValid(messages: Msg[], tag: 'chatgpt' | 'xai', model: string, label: string) {
  const input = toInput(messages, tag, model);
  const calls: string[] = [];
  const outputs: string[] = [];
  input.forEach((item, i) => {
    assert.ok(['message', 'function_call', 'function_call_output', 'reasoning'].includes(String(item.type)), `${label}: item ${i} is a ${item.type}`);
    if (item.type === 'function_call') {
      assert.ok(item.call_id, `${label}: function_call without a call_id`);
      calls.push(String(item.call_id));
    }
    if (item.type === 'function_call_output') {
      assert.ok(calls.includes(String(item.call_id)), `${label}: orphan function_call_output ${item.call_id}`);
      outputs.push(String(item.call_id));
    }
    if (item.type === 'reasoning') {
      const next = input[i + 1];
      assert.ok(next && (next.type === 'function_call' || (next.type === 'message' && next.role === 'assistant') || next.type === 'reasoning'), `${label}: reasoning item ${item.id} has nothing after it to reason about`);
      // Only reasoning THIS tag and THIS model wrote (or, for stored histories, an unrecorded model).
      const blob = String(item.encrypted_content);
      assert.ok(blob.startsWith(`SECRET-${tag}-${model}-`) || blob.startsWith(`SECRET-${tag}-undefined-`), `${label}: foreign reasoning replayed: ${blob}`);
    }
  });
  assert.deepEqual([...calls].sort(), [...outputs].sort(), `${label}: calls and outputs do not pair up`);
  assert.equal(new Set(calls).size, calls.length, `${label}: a function_call was sent twice`);
}

function assertAllValid(messages: Msg[], label: string) {
  assertAnthropicValid(messages, `${label} → anthropic`);
  assertOpenAIValid(messages, `${label} → openai`);
  assertOpenAIValid(messages, `${label} → openai (images off)`, false);
  assertResponsesValid(messages, 'chatgpt', 'gpt-a', `${label} → chatgpt/gpt-a`);
  assertResponsesValid(messages, 'chatgpt', 'gpt-b', `${label} → chatgpt/gpt-b`);
  assertResponsesValid(messages, 'xai', 'grok-a', `${label} → xai/grok-a`);
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const WRITERS: Record<string, (n: number) => Msg[]> = {
  anthropic: (n) => anthropicTurn(n),
  openai: (n) => openaiTurn(n),
  'chatgpt/gpt-a': (n) => responsesTurn(n, 'chatgpt', 'gpt-a'),
  'xai/grok-a': (n) => responsesTurn(n, 'xai', 'grok-a'),
};

for (const [name, write] of Object.entries(WRITERS)) {
  test(`a history written by ${name} is a valid request for every backend`, () => {
    assertAllValid(write(1), name);
  });
}

test('the owner\'s route: anthropic → openai-compatible → responses → anthropic', () => {
  const history = [...anthropicTurn(1), ...openaiTurn(2), ...responsesTurn(3, 'chatgpt', 'gpt-a'), ...anthropicTurn(4)];
  assertAllValid(history, 'a→o→r→a');
});

test('every ordering of the four writers, with the awkward leftovers in the middle', () => {
  const names = Object.keys(WRITERS);
  const permutations = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
  for (const order of permutations(names)) {
    const history = order.flatMap((name, i) => [...(WRITERS[name]?.(i + 1) ?? []), ...(i === 1 ? awkward() : [])]);
    assertAllValid(history, order.join(' → '));
  }
});

test('…and the same after compaction put a summary where the early turns were', () => {
  const history = [summary(), ...responsesTurn(1, 'chatgpt', 'gpt-a'), ...openaiTurn(2), ...anthropicTurn(3)];
  assertAllValid(history, 'summary + r→o→a');
  // The summary is an ordinary user message everywhere.
  const first = toAnthropicMessages(history)[0];
  assert.equal(first?.role, 'user');
  assert.match(JSON.stringify(toOpenAIMessages('s', history)[1]), /Summary of the earlier part/);
});

// ---------------------------------------------------------------------------
// The specific guarantees
// ---------------------------------------------------------------------------

test('reasoning is replayed to the model that wrote it, and to no other', () => {
  const history = [...responsesTurn(1, 'chatgpt', 'gpt-a'), ...responsesTurn(2, 'xai', 'grok-a'), ...responsesTurn(3, 'chatgpt', 'gpt-b')];
  const reasoning = (tag: 'chatgpt' | 'xai', model: string) =>
    toInput(history, tag, model)
      .filter((i) => i.type === 'reasoning')
      .map((i) => String(i.id));
  assert.deepEqual(reasoning('chatgpt', 'gpt-a'), ['rs_chatgpt1', 'rs_chatgpt1b']);
  assert.deepEqual(reasoning('chatgpt', 'gpt-b'), ['rs_chatgpt3', 'rs_chatgpt3b']);
  assert.deepEqual(reasoning('xai', 'grok-a'), ['rs_xai2', 'rs_xai2b']);
  assert.deepEqual(reasoning('xai', 'grok-other'), []);
});

test('a turn whose reasoning is not replayed is rebuilt from its neutral parts, calls and all', () => {
  const input = toInput(responsesTurn(1, 'chatgpt', 'gpt-a'), 'chatgpt', 'gpt-b');
  assert.deepEqual(input.map((i) => i.type), ['message', 'function_call', 'function_call_output', 'message']);
  assert.deepEqual(input[1], { type: 'function_call', call_id: 'call_rchatgpt1', name: 'find_elements', arguments: '{"selector":"h1"}' });
  assert.deepEqual(input[3], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'chatgpt answer 1.' }] });
});

test('a history stored before the model was recorded still replays for its own tag, as it always did', () => {
  const old = responsesTurn(1, 'chatgpt', undefined);
  assert.equal(toInput(old, 'chatgpt', 'gpt-a').filter((i) => i.type === 'reasoning').length, 2);
  assert.equal(toInput(old, 'chatgpt').filter((i) => i.type === 'reasoning').length, 2);
  assert.equal(toInput(old, 'xai', 'grok-a').filter((i) => i.type === 'reasoning').length, 0);
});

test('a turn cut off mid-reasoning does not leave a dangling reasoning item', () => {
  const input = toInput(awkward(), 'chatgpt', 'gpt-a');
  assert.ok(!input.some((i) => i.type === 'reasoning'));
});

test('tool ids another backend minted are rewritten for Anthropic, identically at both ends', () => {
  const out = toAnthropicMessages(openaiTurn(7)) as unknown as Array<{ content: Block[] }>;
  const use = out[1]?.content.find((b) => b.type === 'tool_use');
  const result = out[2]?.content.find((b) => b.type === 'tool_result');
  assert.equal(use?.id, 'call_functions_get_page_7');
  assert.equal(result?.tool_use_id, 'call_functions_get_page_7');
  // An id that was already fine is left exactly as it was.
  assert.equal(out[1]?.content.filter((b) => b.type === 'tool_use')[1]?.id, 'call_7');
});

test('a rewritten id never lands on one that is already taken', () => {
  // "a:b" rewrites to call_a_b, which a real call in the same history already uses.
  const history = openaiTurn(1, ['a:b', 'call_a_b']);
  const out = toAnthropicMessages(history) as unknown as Array<{ content: Block[] }>;
  const ids = out[1]?.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
  assert.deepEqual(ids, ['call_a_b_2', 'call_a_b']);
  assertAnthropicValid(history, 'collision');
});

test('an over-long id is shortened rather than sent', () => {
  const long = 'x'.repeat(200);
  assertAnthropicValid(openaiTurn(1, [long, 'call_ok']), 'long id');
});

test('whitespace-only assistant text is dropped for Anthropic and kept out of the way for OpenAI', () => {
  const a = toAnthropicMessages(openaiTurn(1)) as unknown as Array<{ content: Block[] }>;
  assert.deepEqual(a[1]?.content.map((b) => b.type), ['tool_use', 'tool_use']);
});

test('a screenshot survives the swap in each protocol\'s own arrangement', () => {
  const history = openaiTurn(1);
  // Anthropic: inside the tool_result.
  const a = toAnthropicMessages(history) as unknown as Array<{ content: Block[] }>;
  const shot = a[2]?.content.filter((b) => b.type === 'tool_result')[1];
  assert.ok((shot?.content as Block[]).some((c) => c.type === 'image'));
  // chat/completions: in the user message after the tool messages.
  const o = toOpenAIMessages('s', history);
  const after = o[5];
  assert.equal(o[3]?.role, 'tool');
  assert.equal(o[4]?.role, 'tool');
  assert.equal(after?.role, 'user');
  assert.ok(Array.isArray(after?.content) && after.content.some((p) => p.type === 'image_url'));
  // Responses: an input_image in the user message after the outputs.
  const r = toInput(history, 'chatgpt', 'gpt-a');
  const userAfter = r.find((i, n) => n > 2 && i.type === 'message' && i.role === 'user');
  assert.ok((userAfter?.content as Block[]).some((c) => c.type === 'input_image'));
});
