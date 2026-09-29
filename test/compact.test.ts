// History compaction: the size estimator, the two tiers, and the invariant that matters most —
// whatever compaction does, every one of the three provider adapters must still be able to turn
// the result into a valid request. Those adapters are imported and run for real here; a pairing
// bug that only shows up as a 400 from the provider is exactly the kind this suite is for.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compact,
  cutIndex,
  dropOldest,
  ELIDED_MARK,
  elide,
  estimateMessage,
  estimatePart,
  estimateTokens,
  IMAGE_TOKENS,
  isElided,
  isUserTurnStart,
  needsCompaction,
  OMITTED_NOTE,
  PROTECT_RECENT_TURNS,
  renderForSummary,
  startsWithSummary,
  SUMMARY_PREFIX,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT_WITH_DRAFT,
} from '../lib/agent/compact.ts';
import { toAnthropicMessages } from '../lib/providers/anthropic.ts';
import { toOpenAIMessages } from '../lib/providers/openai.ts';
import { toInput } from '../lib/providers/responses.ts';
import type { Msg, Part } from '../lib/types.ts';

// ---------- fixtures ----------

let seq = 0;
const nextId = () => `call_${++seq}`;

const userTurn = (text: string): Msg => ({ role: 'user', content: [{ type: 'text', text }] });

/** One assistant turn calling a tool, and the user message carrying the result back. */
function exchange(tool: string, input: Record<string, unknown>, result: string, id = nextId()): Msg[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_call', id, name: tool, input }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: id, content: [{ type: 'text', text: result }] }] },
  ];
}

const big = (n: number) => 'x'.repeat(n);

/** A long conversation: `turns` user turns, each with one fat get_page exchange. */
function longHistory(turns: number, resultChars = 40_000): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(userTurn(`turn ${i}: make the page nicer`));
    out.push(...exchange('get_page', { max_chars: 60000 }, `snapshot ${i}\n${big(resultChars)}`));
    out.push({ role: 'assistant', content: [{ type: 'text', text: `done with turn ${i}` }] });
  }
  return out;
}

// ---------- the estimator ----------

test('text is estimated at roughly four characters per token', () => {
  const t = estimatePart({ type: 'text', text: big(4000) });
  assert.ok(t >= 1000 && t <= 1010, `expected ~1000 tokens, got ${t}`);
});

test('an image costs a flat amount rather than the length of its base64', () => {
  const small = estimatePart({ type: 'image', mediaType: 'image/png', data: big(10) });
  const large = estimatePart({ type: 'image', mediaType: 'image/png', data: big(2_000_000) });
  assert.equal(small, large);
  assert.ok(small >= IMAGE_TOKENS);
});

test('a tool call is measured by the JSON length of its input, not just its name', () => {
  const smallCall = estimatePart({ type: 'tool_call', id: 'a', name: 'run_script', input: { code: 'x' } });
  const bigCall = estimatePart({ type: 'tool_call', id: 'a', name: 'run_script', input: { code: big(8000) } });
  assert.ok(bigCall - smallCall >= 1900, `expected the big input to cost ~2000 more, got ${bigCall - smallCall}`);
});

test('an opaque provider item is measured by its serialized length', () => {
  const part: Part = { type: 'opaque', provider: 'chatgpt', item: { type: 'reasoning', encrypted_content: big(4000) } };
  assert.ok(estimatePart(part) >= 1000);
});

test('a tool result adds up the parts it contains', () => {
  const part: Part = {
    type: 'tool_result',
    toolCallId: 'a',
    content: [{ type: 'text', text: big(4000) }, { type: 'image', mediaType: 'image/jpeg', data: 'zz' }],
  };
  assert.ok(estimatePart(part) >= 1000 + IMAGE_TOKENS);
});

test('an unserializable opaque item is counted as zero rather than throwing', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  // Zero characters, so it costs exactly what an item with nothing to serialize costs: the part's
  // own envelope and no more.
  const empty = estimatePart({ type: 'opaque', provider: 'x', item: undefined });
  assert.equal(estimatePart({ type: 'opaque', provider: 'x', item: cyclic }), empty);
});

test('estimateTokens is the sum over messages, and every message costs something', () => {
  const msgs = [userTurn('a'), userTurn('b')];
  assert.equal(estimateTokens(msgs), estimateMessage(msgs[0]!) + estimateMessage(msgs[1]!));
  assert.ok(estimateMessage({ role: 'user', content: [] }) > 0);
});

test('needsCompaction only fires above 70% of the budget', () => {
  const msgs = longHistory(1);
  const size = estimateTokens(msgs);
  assert.equal(needsCompaction(msgs, size * 2), false);
  assert.equal(needsCompaction(msgs, size), true);
  assert.equal(needsCompaction(msgs, 0), false, 'a zero budget disables compaction rather than compacting everything');
});

// ---------- turn boundaries ----------

test('a user message carrying tool results is not a turn start', () => {
  assert.equal(isUserTurnStart(userTurn('hi')), true);
  assert.equal(isUserTurnStart({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'a', content: [] }] }), false);
  assert.equal(isUserTurnStart({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }), false);
});

test('a user message that carries BOTH tool results and injected text stays with its tool call', () => {
  // The loop appends a mid-run user message to the tool-result message; cutting there would orphan
  // the assistant's tool_call.
  const m: Msg = {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: 'a', content: [] }, { type: 'text', text: 'actually, make it blue' }],
  };
  assert.equal(isUserTurnStart(m), false);
});

// ---------- tier 1: elision ----------

test('elision replaces old bulky tool results with a stub and leaves the pairing intact', () => {
  const msgs = longHistory(6);
  const { messages: out, changed } = elide(msgs, Math.floor(estimateTokens(msgs) * 0.4));
  assert.equal(changed, true);
  assert.equal(out.length, msgs.length, 'elision never removes messages');
  assert.ok(estimateTokens(out) < estimateTokens(msgs) * 0.6);

  const stubs = out.flatMap((m) => m.content).filter((p) => p.type === 'tool_result' && isElided(p));
  assert.ok(stubs.length > 0);
  for (const m of out) {
    for (const p of m.content) {
      if (p.type === 'tool_result' && isElided(p)) {
        const text = p.content[0];
        assert.ok(text?.type === 'text' && text.text.startsWith(ELIDED_MARK));
        assert.match(text.text, /get_page result · [\d,]+ chars · call get_page again/);
      }
    }
  }
});

test('elision never touches propose_mod: the mod code is the artefact of the session', () => {
  const code = big(30_000);
  const msgs: Msg[] = [
    userTurn('t0'),
    ...exchange('propose_mod', { name: 'Demo', code, matches: ['*://e.com/*'] }, 'shown to the user'),
    ...exchange('get_page', {}, big(40_000)),
    userTurn('t1'),
    ...exchange('get_page', {}, big(40_000)),
    userTurn('t2'),
    userTurn('t3'),
  ];
  const { messages: out } = elide(msgs, 100);
  const proposeInput = out.flatMap((m) => m.content).find((p) => p.type === 'tool_call' && p.name === 'propose_mod');
  assert.ok(proposeInput?.type === 'tool_call' && (proposeInput.input.code as string).length === code.length);
  // Its RESULT is small anyway, but it must not be stubbed either.
  const proposeResult = out[2]!.content[0]!;
  assert.ok(proposeResult.type === 'tool_result' && !isElided(proposeResult));
});

test('the latest result of each tool kind survives, so the model keeps one fresh example', () => {
  const msgs: Msg[] = [
    userTurn('t0'),
    ...exchange('get_page', {}, `first ${big(40_000)}`),
    ...exchange('find_elements', { selector: '.a' }, `elements ${big(40_000)}`),
    userTurn('t1'),
    ...exchange('get_page', {}, `second ${big(40_000)}`),
    userTurn('t2'),
    userTurn('t3'),
  ];
  const { messages: out } = elide(msgs, 10);
  const results = out.flatMap((m) => m.content).filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');
  const live = results.filter((r) => !isElided(r));
  const liveText = live.flatMap((r) => r.content).map((c) => (c.type === 'text' ? c.text.slice(0, 20) : '')).join('|');
  assert.ok(liveText.includes('second'), `the newest get_page must survive: ${liveText}`);
  assert.ok(liveText.includes('elements'), `the only find_elements must survive: ${liveText}`);
  assert.ok(!liveText.includes('first'), `the older get_page should have been elided: ${liveText}`);
});

test('nothing inside the two most recent user turns is elided', () => {
  const msgs = longHistory(3);
  const { messages: out } = elide(msgs, 1);
  // Three turns, two protected: only the first turn's result can go.
  const elidedCount = out.flatMap((m) => m.content).filter((p) => p.type === 'tool_result' && isElided(p)).length;
  assert.equal(elidedCount, 1);
});

test('a single long turn is still elidable — the turn rule alone would protect the whole history', async () => {
  // The shape the agent really produces: one user message, then many tool rounds. A "protect the
  // last two USER TURNS" rule protects everything here, which would leave the compactor watching a
  // run die on a context error. It falls back to protecting the last few MESSAGES instead.
  const msgs: Msg[] = [userTurn('trace every heading on this page')];
  for (let i = 0; i < 6; i++) {
    const id = nextId();
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: `round ${i}` }, { type: 'tool_call', id, name: 'get_page', input: {} }] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', toolCallId: id, content: [{ type: 'text', text: big(50_000) }] }] });
  }
  const r = await compact(msgs, { budget: 12_000, summarise: async () => 'S' });
  assert.deepEqual(r.steps.map((s) => s.tier), ['elided'], `nothing was compacted: ${JSON.stringify(r.steps)}`);
  assert.ok(r.after < r.before / 1.5, `${r.before} -> ${r.after}`);
  assertValid(r.messages, 'single long turn');
  // Tier 2 correctly declines: there is no second turn boundary to cut at without orphaning a call.
  assert.ok(!r.steps.some((s) => s.tier === 'summarised'));
});

test('the last few messages of a single long turn are still protected', () => {
  const msgs: Msg[] = [userTurn('one turn')];
  for (let i = 0; i < 6; i++) {
    const id = nextId();
    msgs.push({ role: 'assistant', content: [{ type: 'tool_call', id, name: 'get_page', input: {} }] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', toolCallId: id, content: [{ type: 'text', text: big(50_000) }] }] });
  }
  const out = elide(msgs, 1).messages;
  const results = out.flatMap((m) => m.content).filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');
  assert.ok(results.slice(-3).every((r) => !isElided(r)), 'the most recent rounds must survive');
  assert.ok(results.slice(0, 2).every((r) => isElided(r)), 'the oldest rounds should have gone');
});

test('elision goes largest-and-oldest first and stops as soon as it is under target', () => {
  const ids = ['small', 'huge', 'medium'];
  const msgs: Msg[] = [
    userTurn('t0'),
    ...exchange('get_page', { n: 0 }, big(2_000), ids[0]),
    ...exchange('get_page', { n: 1 }, big(200_000), ids[1]),
    ...exchange('get_page', { n: 2 }, big(20_000), ids[2]),
    // A newer get_page, so none of the three above is "the latest of its kind".
    ...exchange('get_page', { n: 3 }, big(1_000)),
    userTurn('t1'),
    userTurn('t2'),
  ];
  const target = estimateTokens(msgs) - 40_000; // only the huge one needs to go
  const { messages: out } = elide(msgs, target);
  const byId = new Map(out.flatMap((m) => m.content).filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result').map((p) => [p.toolCallId, p]));
  assert.equal(isElided(byId.get('huge')!), true, 'the largest goes first');
  assert.equal(isElided(byId.get('medium')!), false, 'and nothing more than needed goes');
  assert.equal(isElided(byId.get('small')!), false);
});

test('eliding an already-elided history changes nothing', () => {
  const msgs = longHistory(6);
  const once = elide(msgs, 10).messages;
  const twice = elide(once, 10);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.messages, once);
});

test('a history with nothing elidable reports no change rather than rebuilding itself', () => {
  const msgs = [userTurn('a'), { role: 'assistant', content: [{ type: 'text', text: 'b' }] } as Msg];
  const r = elide(msgs, 1);
  assert.equal(r.changed, false);
  assert.equal(r.messages, msgs);
});

test('bracketed nudge text appended to a tool-result message is ordinary text to the compactor', () => {
  // The loop appends notes to the tool-result message — a queued user message, and (from the
  // loop-behaviour work) bracketed nudges like read budgets or an iteration warning. They are
  // `text` parts sitting beside a `tool_result`, so the compactor must count them, leave them
  // alone when it stubs the result next to them, and not mistake them for a turn boundary.
  const id = nextId();
  const nudge = '[You have read the page 3 times. Prefer acting on what you already know.]';
  const msgs: Msg[] = [
    userTurn('t0'),
    { role: 'assistant', content: [{ type: 'tool_call', id, name: 'get_page', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: id, content: [{ type: 'text', text: big(60_000) }] }, { type: 'text', text: nudge }] },
    ...exchange('get_page', {}, big(10_000)),
    userTurn('t1'),
    userTurn('t2'),
  ];
  assert.equal(isUserTurnStart(msgs[2]!), false, 'a message carrying a nudge beside a result is not a turn start');
  assert.ok(estimateMessage(msgs[2]!) > 15_000, 'the nudge message is measured, result and all');

  const out = elide(msgs, 10).messages;
  assertValid(out, 'nudge');
  const nudged = out[2]!;
  assert.equal(nudged.content.length, 2, 'the nudge survives beside the stubbed result');
  const kept = nudged.content[1];
  assert.ok(kept?.type === 'text' && kept.text === nudge, 'the nudge text was altered');
  const result = nudged.content[0];
  assert.ok(result?.type === 'tool_result' && isElided(result), 'the result beside it should have been elided');
});

// ---------- pairing validity, run through the real adapters ----------

/**
 * Every assistant tool_call has exactly one tool_result, and every tool_result answers a call that
 * came before it. Asserted on the neutral history and then again on each adapter's output, because
 * each of the three flattens it differently.
 */
function assertValid(messages: Msg[], label: string) {
  // Neutral form.
  const open = new Set<string>();
  const seen = new Set<string>();
  for (const m of messages) {
    for (const p of m.content) {
      if (p.type === 'tool_call') {
        assert.ok(m.role === 'assistant', `${label}: a tool_call in a ${m.role} message`);
        assert.ok(!open.has(p.id), `${label}: duplicate tool_call id ${p.id}`);
        open.add(p.id);
      } else if (p.type === 'tool_result') {
        assert.ok(m.role === 'user', `${label}: a tool_result in a ${m.role} message`);
        assert.ok(open.has(p.toolCallId), `${label}: tool_result ${p.toolCallId} answers no call before it`);
        assert.ok(!seen.has(p.toolCallId), `${label}: tool_result ${p.toolCallId} appears twice`);
        seen.add(p.toolCallId);
      }
    }
  }
  assert.deepEqual([...open].filter((id) => !seen.has(id)), [], `${label}: unanswered tool calls`);

  // Anthropic: tool_use blocks and tool_result blocks, matched by id.
  const anth = toAnthropicMessages(messages);
  const uses = new Set<string>();
  const answered = new Set<string>();
  for (const m of anth) {
    assert.ok(Array.isArray(m.content), `${label}/anthropic: content is not a block list`);
    for (const b of m.content as unknown as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') uses.add(String(b.id));
      if (b.type === 'tool_result') {
        assert.ok(uses.has(String(b.tool_use_id)), `${label}/anthropic: orphan tool_result ${b.tool_use_id}`);
        answered.add(String(b.tool_use_id));
      }
    }
  }
  assert.equal(answered.size, uses.size, `${label}/anthropic: ${uses.size - answered.size} unanswered tool_use blocks`);

  // OpenAI chat completions: an assistant message with tool_calls must be followed by exactly one
  // `tool` message per call, and no `tool` message may appear without one.
  const oai = toOpenAIMessages('sys', messages);
  const pending = new Set<string>();
  for (const m of oai) {
    if (m.role === 'assistant') {
      for (const c of m.tool_calls ?? []) pending.add(c.id);
    } else if (m.role === 'tool') {
      assert.ok(pending.has(m.tool_call_id), `${label}/openai: orphan tool message ${m.tool_call_id}`);
      pending.delete(m.tool_call_id);
    }
    if (m.role === 'user') assert.ok(m.content, `${label}/openai: empty user content`);
  }
  assert.deepEqual([...pending], [], `${label}/openai: tool_calls with no tool message`);

  // Responses API: function_call items answered by function_call_output items with the same call_id.
  const input = toInput(messages, 'chatgpt');
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const item of input) {
    if (item.type === 'function_call') calls.add(String(item.call_id));
    if (item.type === 'function_call_output') {
      assert.ok(calls.has(String(item.call_id)), `${label}/responses: orphan function_call_output ${item.call_id}`);
      outputs.add(String(item.call_id));
    }
  }
  assert.equal(outputs.size, calls.size, `${label}/responses: ${calls.size - outputs.size} unanswered function_calls`);
}

test('the history stays valid for all three adapters after elision', () => {
  const msgs = longHistory(8);
  assertValid(msgs, 'before');
  assertValid(elide(msgs, 10).messages, 'after elision');
});

test('the history stays valid for all three adapters after summarisation', async () => {
  const msgs = longHistory(8);
  const r = await compact(msgs, { budget: 2000, summarise: async () => 'a summary' });
  assert.ok(r.steps.some((s) => s.tier === 'summarised'));
  assertValid(r.messages, 'after summarisation');
});

test('the history stays valid after the drop-oldest fallback', async () => {
  const msgs = longHistory(8);
  const r = await compact(msgs, { budget: 2000, summarise: async () => { throw new Error('429'); } });
  assertValid(r.messages, 'after fallback');
});

test('a multi-call turn keeps every result with its call through elision', () => {
  const a = nextId();
  const b = nextId();
  const msgs: Msg[] = [
    userTurn('t0'),
    {
      role: 'assistant',
      content: [
        { type: 'tool_call', id: a, name: 'get_page', input: {} },
        { type: 'tool_call', id: b, name: 'get_styles', input: { selector: '.x' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: a, content: [{ type: 'text', text: big(50_000) }] },
        { type: 'tool_result', toolCallId: b, content: [{ type: 'text', text: big(50_000) }] },
      ],
    },
    ...exchange('get_page', {}, big(10_000)),
    ...exchange('get_styles', { selector: '.y' }, big(10_000)),
    userTurn('t1'),
    userTurn('t2'),
  ];
  const out = elide(msgs, 10).messages;
  assertValid(out, 'multi-call turn');
  assert.equal(out[2]!.content.length, 2, 'both results are still in the same message');
});

// ---------- tier 2: cutting, opaque items, fallback ----------

test('cutIndex lands on a user-turn start, keeping K turns', () => {
  const msgs = longHistory(6);
  const cut = cutIndex(msgs, 3);
  assert.equal(isUserTurnStart(msgs[cut]!), true);
  assert.equal(msgs.slice(cut).filter(isUserTurnStart).length, 3);
});

test('cutIndex returns 0 when there are not K turns to keep, so nothing is summarised', () => {
  assert.equal(cutIndex(longHistory(2), 3), 0);
  assert.equal(cutIndex([], 3), 0);
});

test('a turn holding opaque provider items is summarised or kept whole, never split', async () => {
  // Shaped the way lib/providers/responses.ts really records a turn: one opaque item per output
  // item (the reasoning block AND the function_call), plus the neutral tool_call derived from it.
  // The adapter replays the opaque items INSTEAD of the neutral parts, so a turn that lost half its
  // opaque items would send a reasoning block with no call behind it.
  const msgs: Msg[] = [];
  const reasoningFor = new Map<string, string>();
  for (let i = 0; i < 6; i++) {
    const id = nextId();
    reasoningFor.set(id, `r${i}`);
    msgs.push(userTurn(`turn ${i}`));
    msgs.push({
      role: 'assistant',
      content: [
        { type: 'opaque', provider: 'chatgpt', item: { type: 'reasoning', id: `r${i}`, encrypted_content: big(20_000) } },
        { type: 'opaque', provider: 'chatgpt', item: { type: 'function_call', call_id: id, name: 'get_page', arguments: '{}' } },
        { type: 'tool_call', id, name: 'get_page', input: {} },
      ],
    });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', toolCallId: id, content: [{ type: 'text', text: big(30_000) }] }] });
  }
  const r = await compact(msgs, { budget: 2000, summarise: async () => 'summary' });
  assertValid(r.messages, 'opaque');

  // Each surviving assistant message either has its opaque item AND its tool_call, or neither.
  for (const m of r.messages) {
    if (m.role !== 'assistant') continue;
    const hasOpaque = m.content.some((p) => p.type === 'opaque');
    const hasCall = m.content.some((p) => p.type === 'tool_call');
    assert.equal(hasOpaque, hasCall, 'an opaque item was separated from the call it reasons about');
  }
  // And the Responses adapter still replays each kept call right behind the reasoning item it
  // came with.
  const input = toInput(r.messages, 'chatgpt') as Array<{ type: string; id?: string; call_id?: string }>;
  const calls = input.filter((it) => it.type === 'function_call');
  assert.equal(calls.length, 3, 'the kept turns each replay their call');
  for (const call of calls) {
    const before = input[input.indexOf(call) - 1];
    assert.equal(before?.type, 'reasoning', `call ${call.call_id} was replayed without its reasoning item`);
    assert.equal(before?.id, reasoningFor.get(call.call_id!), `call ${call.call_id} follows another turn's reasoning`);
  }
});

test('the summary is one synthetic user message at the front, and the recent turns are verbatim', async () => {
  const msgs = longHistory(8);
  const r = await compact(msgs, { budget: 2000, summarise: async () => 'THE SUMMARY' });
  const first = r.messages[0]!;
  assert.equal(first.role, 'user');
  assert.equal(startsWithSummary(r.messages), true);
  const text = first.content[0];
  assert.ok(text?.type === 'text' && text.text.startsWith(SUMMARY_PREFIX) && text.text.includes('THE SUMMARY'));
  assert.equal(r.messages.slice(1).filter(isUserTurnStart).length, 3, 'exactly K turns kept');
  // All three kept turns follow the summary, in order. The oldest of them is outside elision's
  // protected window and may have had a bulky result stubbed; the protected turns are byte for byte
  // what came in.
  assert.equal(r.messages.length, 1 + msgs.length - cutIndex(msgs, 3), 'every kept message is there');
  const verbatim = msgs.slice(cutIndex(msgs, PROTECT_RECENT_TURNS));
  assert.deepEqual(r.messages.slice(-verbatim.length), verbatim, 'the protected tail is untouched');
});

test('the summariser gets the plain prompt, or the draft prompt when the chat has a draft', async () => {
  const systems: string[] = [];
  const summarise = async (system: string) => {
    systems.push(system);
    return 'summary';
  };
  await compact(longHistory(8), { budget: 2000, summarise });
  await compact(longHistory(8), { budget: 2000, summarise, hasDraft: true });
  assert.deepEqual(systems, [SUMMARY_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT_WITH_DRAFT]);
});

test('an over-long summary is capped rather than becoming the new problem', async () => {
  const msgs = longHistory(8);
  const r = await compact(msgs, { budget: 2000, summarise: async () => big(200_000) });
  assert.ok(estimateMessage(r.messages[0]!) < 2000, `the summary message was ${estimateMessage(r.messages[0]!)} tokens`);
});

test('a failing summary call falls back to dropping the oldest turns, never to throwing', async () => {
  const msgs = longHistory(8);
  const r = await compact(msgs, { budget: 2000, summarise: async () => { throw new Error('rate limited'); } });
  const first = r.messages[0]!.content[0];
  assert.ok(first?.type === 'text' && first.text === OMITTED_NOTE);
  assert.ok(r.after < r.before);
  assert.equal(r.messages.slice(1).filter(isUserTurnStart).length, 3);
});

test('an empty or whitespace-only summary also falls back', async () => {
  const r = await compact(longHistory(8), { budget: 2000, summarise: async () => '   ' });
  const first = r.messages[0]!.content[0];
  assert.ok(first?.type === 'text' && first.text === OMITTED_NOTE);
});

test('no summariser at all degrades to the fallback instead of failing the turn', async () => {
  const r = await compact(longHistory(8), { budget: 2000 });
  const first = r.messages[0]!.content[0];
  assert.ok(first?.type === 'text' && first.text === OMITTED_NOTE);
});

test('an aborted run skips the model call and takes the fallback', async () => {
  const ac = new AbortController();
  ac.abort();
  let called = false;
  const r = await compact(longHistory(8), {
    budget: 2000,
    signal: ac.signal,
    summarise: async () => {
      called = true;
      return 'nope';
    },
  });
  assert.equal(called, false, 'an aborted run must not spend a model call');
  const first = r.messages[0]!.content[0];
  assert.ok(first?.type === 'text' && first.text === OMITTED_NOTE);
});

test('dropOldest with nothing to drop returns the history untouched', () => {
  const msgs = longHistory(2);
  assert.equal(dropOldest(msgs, 0), msgs);
});

// ---------- the whole policy ----------

test('a history under 70% of budget is returned untouched, with no steps', async () => {
  const msgs = longHistory(2);
  const r = await compact(msgs, { budget: estimateTokens(msgs) * 3 });
  assert.deepEqual(r.steps, []);
  assert.equal(r.messages, msgs);
  assert.equal(r.before, r.after);
});

test('elision alone is enough when it gets under budget, and no model call is made', async () => {
  const msgs = longHistory(8);
  let called = false;
  const r = await compact(msgs, {
    budget: Math.floor(estimateTokens(msgs) * 0.9),
    summarise: async () => {
      called = true;
      return 'x';
    },
  });
  assert.deepEqual(r.steps.map((s) => s.tier), ['elided']);
  assert.equal(called, false, 'tier 2 must not run when tier 1 was enough');
  assert.ok(r.after < r.before);
});

test('both tiers run, in order, when elision is not enough', async () => {
  const msgs = longHistory(10);
  const r = await compact(msgs, { budget: 2000, summarise: async () => 'summary' });
  assert.deepEqual(r.steps.map((s) => s.tier), ['elided', 'summarised']);
  // The steps chain: tier 1's "after" is tier 2's "before", and the last one is the final size.
  assert.equal(r.steps[0]!.before, r.before);
  assert.equal(r.steps[0]!.after, r.steps[1]!.before);
  assert.equal(r.steps[1]!.after, r.after);
  assert.ok(r.after < r.before / 2);
});

test('compacting an already-compacted history is a no-op', async () => {
  const msgs = longHistory(10);
  const once = await compact(msgs, { budget: 2000, summarise: async () => 'summary' });
  const twice = await compact(once.messages, { budget: 2000, summarise: async () => 'summary again' });
  assert.deepEqual(twice.steps, [], `a second pass did ${JSON.stringify(twice.steps)}`);
  assert.deepEqual(twice.messages, once.messages);
  assert.equal(startsWithSummary(twice.messages), true);
  assert.ok(!JSON.stringify(twice.messages).includes('summary again'), 'the summary must not be summarised');
});

test('a later compaction folds the previous summary into the new one, keeping it at the front', async () => {
  // The chat kept going after the first compaction, and grew too big again. The old summary is
  // context we already paid a model call for: it must reach the summariser and must not be one of
  // the K "recent turns" that are kept verbatim.
  const once = await compact(longHistory(10), { budget: 2000, summarise: async () => 'FIRST SUMMARY' });
  const grown = [...once.messages, ...longHistory(5)];
  let sawOld = false;
  const twice = await compact(grown, {
    budget: 2000,
    summarise: async (_system, user) => {
      sawOld = user.includes('FIRST SUMMARY');
      return 'SECOND SUMMARY';
    },
  });
  assert.deepEqual(twice.steps.map((s) => s.tier), ['elided', 'summarised']);
  assert.equal(sawOld, true, 'the previous summary must be handed to the summariser, not thrown away');
  assert.equal(startsWithSummary(twice.messages), true);
  assert.equal(twice.messages.filter(startsWithSummaryAt).length, 1, 'exactly one summary message survives');
  const first = twice.messages[0]!.content[0];
  assert.ok(first?.type === 'text' && first.text.includes('SECOND SUMMARY') && !first.text.includes('FIRST SUMMARY'));
  assertValid(twice.messages, 'second compaction');
});

/** Is this single message a summary message? (startsWithSummary takes a history.) */
const startsWithSummaryAt = (m: Msg) => startsWithSummary([m]);

test('a summary is never made of a summary even when the result is still over budget', async () => {
  // Budget so small that the compacted history is still above it: the second pass has nothing left
  // to cut (K turns are kept whatever the cost), so it must stop rather than fold the summary in.
  const once = await compact(longHistory(10), { budget: 2000, summarise: async () => 'summary' });
  const twice = await compact(once.messages, { budget: 10, summarise: async () => 'second summary' });
  assert.ok(!JSON.stringify(twice.messages).includes('second summary'));
});

// ---------- the summariser's input ----------

test('the transcript handed to the summariser clips tool output but keeps propose_mod whole', () => {
  const code = big(30_000);
  const msgs: Msg[] = [
    userTurn('make the header sticky'),
    ...exchange('get_page', {}, big(80_000)),
    ...exchange('propose_mod', { name: 'Sticky', code, matches: ['*://e.com/*'] }, 'shown'),
  ];
  const rendered = renderForSummary(msgs);
  assert.ok(rendered.includes('make the header sticky'));
  assert.ok(rendered.includes('more chars]'), 'the fat snapshot should be clipped');
  assert.ok(rendered.includes(code), 'the mod code must reach the summariser in full');
  assert.ok(rendered.length < 200_000);
});

test('opaque items contribute nothing to the summariser input', () => {
  const rendered = renderForSummary([
    { role: 'assistant', content: [{ type: 'opaque', provider: 'chatgpt', item: { encrypted_content: 'SECRETBLOB' } }, { type: 'text', text: 'hello' }] },
  ]);
  assert.ok(!rendered.includes('SECRETBLOB'));
  assert.ok(rendered.includes('hello'));
});

test('images and errors are labelled in the summariser input', () => {
  const id = nextId();
  const rendered = renderForSummary([
    { role: 'assistant', content: [{ type: 'tool_call', id, name: 'run_script', input: { code: 'boom()' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: id, isError: true, content: [{ type: 'text', text: 'ReferenceError' }] }] },
  ]);
  assert.match(rendered, /TOOL RESULT run_script \(error\): ReferenceError/);
});
