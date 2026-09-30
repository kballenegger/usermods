// Late errors from run_script callbacks reach the model on the NEXT tool result, whatever that tool
// is, once, and without a tool of their own. The background's buffer and the page's catcher are
// tested in test/runscript.test.ts and test/exec-wrap-runtime.test.ts; this is the loop's half.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent, withLeadingLine, type AgentEnv } from '../lib/agent/loop.ts';
import type { Provider, ProviderResponse } from '../lib/providers/types.ts';
import type { AgentEventBody, Msg, Part, Settings } from '../lib/types.ts';

const SETTINGS = { provider: 'openai-compatible', baseUrl: 'http://unused.invalid/v1', apiKey: '', model: 'fake' } as Settings;
const LATE = '[Uncaught in your run_script callbacks since the last result: TypeError: x is null (line 3)]';

function provider(replies: ProviderResponse[]): Provider {
  return {
    async chat() {
      const r = replies.shift();
      if (!r) throw new Error('out of replies');
      return r;
    },
  };
}
const calls = (...parts: Array<[string, string, Record<string, unknown>]>): ProviderResponse => ({
  content: parts.map(([id, name, input]) => ({ type: 'tool_call', id, name, input }) as Part),
  stopReason: 'tool_use',
});

test('a late error is put in front of the next tool result once, and the panel summary is the tool\'s own', async () => {
  // The run_script arms an observer and reports. The observer throws while the next tool (a
  // find_elements) is running, so that result carries the line; the one after carries nothing.
  const pending: string[] = [];
  const env: AgentEnv = {
    async sendToContent<T>(): Promise<T> {
      if (!pending.length && !armedErrorSent) {
        armedErrorSent = true;
        pending.push(LATE);
      }
      return { text: 'h1: Hello' } as T;
    },
    async runScript() {
      return { outcome: { kind: 'ok', returnedValue: true, result: '"armed"' }, logs: [] };
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
    takeLateErrors: () => pending.shift() ?? null,
  };
  let armedErrorSent = false;
  const events: AgentEventBody[] = [];
  const out = await runAgent({
    settings: SETTINGS,
    history: [],
    turn: { id: 't1', text: 'hide the popup' },
    pullQueued: () => [],
    env,
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    provider: provider([
      calls(['c1', 'run_script', { code: 'observe()' }]),
      calls(['c2', 'find_elements', { selector: 'h1' }]),
      calls(['c3', 'find_elements', { selector: 'h1' }]),
      { content: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn' },
    ]),
  });
  const results = out.messages.flatMap((m: Msg) => m.content).filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');
  const textOf = (p: Extract<Part, { type: 'tool_result' }>) => p.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  assert.equal(textOf(results[0]!), 'Result: "armed"');
  assert.equal(textOf(results[1]!), `${LATE}\nh1: Hello`);
  assert.equal(textOf(results[2]!), 'h1: Hello');
  const summaries = events.filter((e): e is Extract<AgentEventBody, { type: 'tool_result' }> => e.type === 'tool_result').map((e) => e.summary);
  assert.equal(summaries[1], 'h1: Hello');
});

test('an env without takeLateErrors behaves as before', () => {
  // Optional on AgentEnv, so every existing env (the tests' fakes, an old caller) compiles and runs.
  const env: Partial<AgentEnv> = {};
  assert.equal(env.takeLateErrors?.() ?? null, null);
});

test('the late line joins a leading text part, or goes before an image as its own part', () => {
  assert.deepEqual(withLeadingLine('L', [{ type: 'text', text: 'body' }]), [{ type: 'text', text: 'L\nbody' }]);
  const img: Part = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
  assert.deepEqual(withLeadingLine('L', [img]), [{ type: 'text', text: 'L' }, img]);
  assert.deepEqual(withLeadingLine('L', []), [{ type: 'text', text: 'L' }]);
});
