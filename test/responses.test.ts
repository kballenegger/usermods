import assert from 'node:assert/strict';
import test from 'node:test';
import { createResponsesProvider } from '../lib/providers/responses.ts';

test('Responses finishes at the completion event even when the connection stays open', { timeout: 1_000 }, async (t) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const events = [
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] } },
        { type: 'response.completed', response: { status: 'completed' } },
      ];
      controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
    },
    cancel() {
      cancelled = true;
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  const provider = createResponsesProvider({
    baseUrl: 'https://example.invalid',
    model: 'test-model',
    tag: 'chatgpt',
    headers: async () => ({}),
  });
  const deltas: string[] = [];
  const reply = await provider.chat({
    system: 'Test',
    messages: [],
    tools: [],
    callbacks: { onText: (text) => deltas.push(text) },
  });
  assert.deepEqual(deltas, ['Hello']);
  assert.deepEqual(reply.content.filter((part) => part.type === 'text'), [{ type: 'text', text: 'Hello' }]);
  assert.equal(reply.stopReason, 'end_turn');
  assert.equal(cancelled, true);
});
