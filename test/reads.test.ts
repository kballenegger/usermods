// The page reads through the real agent loop: what find_elements and get_page send to the content
// script, and the read budget charging what each read actually returned. The pure halves are in
// test/agent.test.ts (the budget) and test/snapshot.test.ts (the page side).
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent, type AgentEnv, type AgentInput } from '../lib/agent/loop.ts';
import type { Provider, ProviderResponse } from '../lib/providers/types.ts';
import type { Msg, Part, Settings } from '../lib/types.ts';

const SETTINGS = { provider: 'openai-compatible', baseUrl: 'http://unused.invalid/v1', apiKey: '', model: 'fake' } as Settings;

const call = (id: string, name: string, input: Record<string, unknown> = {}): Part => ({ type: 'tool_call', id, name, input });
const step = (calls: Part[]): ProviderResponse => ({ content: calls, stopReason: calls.length ? 'tool_use' : 'end_turn' });

function provider(steps: ProviderResponse[]): Provider {
  return {
    async chat() {
      return steps.shift() ?? step([]);
    },
  };
}

/** A page whose get_page answers are `pageChars` long and whose lookups are short. */
function env(pageChars: number) {
  const sent: Record<string, unknown>[] = [];
  const e: AgentEnv = {
    async sendToContent<T>(req: unknown): Promise<T> {
      sent.push(req as Record<string, unknown>);
      const type = (req as { type: string }).type;
      if (type === 'snapshot') return { html: 'x'.repeat(pageChars), url: 'https://example.com/', title: 'Example' } as T;
      return { text: '1 element(s) match ".a":\n1. .a [stable: named class] [10x10 @0,0] A' } as T;
    },
    async runScript() {
      return { outcome: { kind: 'ok', value: 'done' }, logs: [] } as never;
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
  };
  return { env: e, sent };
}

async function run(steps: ProviderResponse[], pageChars = 18_000) {
  const { env: e, sent } = env(pageChars);
  const args: AgentInput = {
    settings: SETTINGS,
    history: [],
    turn: { id: 't1', text: 'hide the sidebar' },
    pullQueued: () => [],
    env: e,
    emit: () => {},
    signal: new AbortController().signal,
    provider: provider(steps),
  };
  const out = await runAgent(args);
  return { out, sent };
}

const texts = (messages: Msg[]) => messages.flatMap((m) => m.content).flatMap((p) => (p.type === 'text' ? [p.text] : p.type === 'tool_result' ? p.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])) : []));
const nudged = (messages: Msg[]) => texts(messages).some((t) => /page reads without running/.test(t));

test('find_elements sends text, alone or with a selector, and refuses neither', async () => {
  const { out, sent } = await run([
    step([call('a', 'find_elements', { text: 'Recommended for you' })]),
    step([call('b', 'find_elements', { selector: 'section', text: 'Trending', limit: 3 })]),
    step([call('c', 'find_elements', {})]),
  ]);
  assert.deepEqual(sent, [
    { type: 'query', selector: undefined, text: 'Recommended for you', limit: 20, styles: undefined, overlays: false },
    { type: 'query', selector: 'section', text: 'Trending', limit: 3, styles: undefined, overlays: false },
  ]);
  const refused = out.messages.flatMap((m) => m.content).find((p) => p.type === 'tool_result' && p.toolCallId === 'c');
  assert.ok(refused && refused.type === 'tool_result' && refused.isError);
  assert.match(texts([{ role: 'user', content: [refused] }]).join(''), /selector, text or overlays is required/);
});

test('find_elements passes styles and overlays through, and overlays alone is a valid call', async () => {
  const { sent } = await run([
    step([call('a', 'find_elements', { overlays: true })]),
    step([call('b', 'find_elements', { selector: 'li', styles: ['color', '', 7, 'margin'] })]),
  ]);
  assert.deepEqual(sent, [
    { type: 'query', selector: undefined, text: undefined, limit: 20, styles: undefined, overlays: true },
    { type: 'query', selector: 'li', text: undefined, limit: 20, styles: ['color', 'margin'], overlays: false },
  ]);
});

test('get_page passes text mode and its offset through', async () => {
  const { sent } = await run([step([call('a', 'get_page', { text: true, offset: 20000 })]), step([call('b', 'get_page', {})])]);
  assert.equal(sent[0]!.text, true);
  assert.equal(sent[0]!.offset, 20000);
  assert.equal(sent[1]!.text, false);
  assert.equal(sent[1]!.offset, 0);
});

test('a text read is at least 1,000 characters a part, and styles drop names no property has', async () => {
  const { sent } = await run([
    step([call('a', 'get_page', { text: true, max_chars: 1 })]),
    step([call('b', 'find_elements', { selector: 'p', styles: ['color', 'x'.repeat(5000)] })]),
  ]);
  assert.equal(sent[0]!.maxChars, 1000);
  assert.deepEqual(sent[1]!.styles, ['color']);
});

test('get_page passes include_hidden through, and only when it is true', async () => {
  const { sent } = await run([step([call('a', 'get_page', { include_hidden: true })]), step([call('b', 'get_page', { selector: 'main' })])]);
  assert.equal(sent[0]!.includeHidden, true);
  assert.equal(sent[1]!.includeHidden, false);
});

test('one page read and a run of small lookups is not nudged', async () => {
  const { out } = await run([
    step([call('p', 'get_page')]),
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => step([call(id, 'find_elements', { selector: `.${id}` })])),
    step([call('s', 'get_styles', { selector: '.a' })]),
  ]);
  assert.equal(nudged(out.messages), false);
});

test('four full get_page reads in a row are still nudged on the fourth', async () => {
  const { out } = await run(['a', 'b', 'c', 'd'].map((id) => step([call(id, 'get_page', { selector: `#${id}` })])));
  const results = out.messages.filter((m) => m.role === 'user' && m.content.some((p) => p.type === 'tool_result'));
  assert.equal(results.length, 4);
  assert.deepEqual(results.map((m) => nudged([m])), [false, false, false, true]);
  assert.match(texts([results[3]!]).join('\n'), /You have made 4 page reads without running or proposing anything/);
});
