import Anthropic from '@anthropic-ai/sdk';
import type { Msg, Part, Settings, ToolDef } from '../types';
import { ProviderError, isAbortError, parseRetryAfter, streamIncomplete } from './errors.ts';
import type { Provider, ProviderResponse } from './types';

/** Models that accept adaptive thinking. Older ones (Haiku 4.5, 3.x) reject it. */
const ADAPTIVE_THINKING = /(opus-5|sonnet-5|fable-5|mythos-5|opus-4-[678]|sonnet-4-6)/;

/** Exported for test/compact.test.ts, which asserts that a compacted history still converts cleanly. */
export function toAnthropicMessages(messages: Msg[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.filter((p) => p.type !== 'opaque').map((p): Anthropic.ContentBlockParam => {
      switch (p.type) {
        case 'text':
          return { type: 'text', text: p.text };
        case 'image':
          return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } };
        case 'tool_call':
          return { type: 'tool_use', id: p.id, name: p.name, input: p.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            is_error: p.isError,
            content: p.content.map((c) =>
              c.type === 'image'
                ? ({ type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } } as const)
                : ({ type: 'text', text: c.type === 'text' ? c.text : JSON.stringify(c) } as const),
            ),
          };
      }
    }),
  }));
}

function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export function createAnthropicProvider(settings: Settings): Provider {
  const client = new Anthropic({
    // The SDK insists on a key; local proxies usually ignore it.
    apiKey: settings.apiKey || (settings.baseUrl ? 'none' : ''),
    baseURL: settings.baseUrl || undefined,
    // We run inside an extension service worker, which the SDK treats as a browser.
    // The key never leaves the user's own machine except to the endpoint they configured.
    dangerouslyAllowBrowser: true,
    // The SDK would otherwise retry 408/409/429/5xx and connection errors twice on its own, under
    // the agent loop's five: up to eighteen requests for one model call, with the first two
    // rounds invisible to the activity line. The loop owns the retry policy (lib/agent/retry.ts),
    // so the SDK makes exactly one attempt and reports what happened.
    maxRetries: 0,
  });
  const model = settings.model || 'claude-opus-5';

  return {
    async chat({ system, messages, tools, signal, callbacks }): Promise<ProviderResponse> {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 16000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: toAnthropicMessages(messages),
          tools: toAnthropicTools(tools),
          ...(ADAPTIVE_THINKING.test(model) ? { thinking: { type: 'adaptive' as const } } : {}),
        },
        { signal },
      );
      stream.on('text', (delta) => callbacks.onText(delta));
      let message: Anthropic.Message;
      try {
        message = await stream.finalMessage();
      } catch (e) {
        throw toProviderError(e, signal);
      }
      // A stream that closes cleanly but early still resolves, with whatever had accumulated and no
      // stop_reason: message_delta, which carries it, never arrived. That is a dropped connection,
      // not a reply.
      if (message.stop_reason == null) throw streamIncomplete();

      const content: Part[] = [];
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use')
          content.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input as Record<string, unknown> });
        // thinking blocks are dropped: we never replay them and they carry no user-visible text by default.
      }
      const stopReason: ProviderResponse['stopReason'] =
        message.stop_reason === 'end_turn' || message.stop_reason === 'tool_use' || message.stop_reason === 'max_tokens' || message.stop_reason === 'refusal'
          ? message.stop_reason
          : 'other';
      return { content, stopReason };
    },
  };
}

/** Error types Anthropic reports inside a 200 stream that mean "try again shortly". */
const TRANSIENT_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error']);

/**
 * The SDK's errors, as the structured error the loop's retry classifier reads. Typed classes, not
 * message matching: APIError carries the status and the response headers; a connection that never
 * produced a response is APIConnectionError; an `error` event inside a stream is an APIError with
 * no status and the error type on it. An abort is handed back untouched.
 */
export function toProviderError(e: unknown, signal?: AbortSignal): unknown {
  if (isAbortError(e) || signal?.aborted) return e;
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach the model provider (${e.message}).`, { kind: 'network', cause: e });
  if (e instanceof Anthropic.APIError) {
    if (typeof e.status === 'number') {
      return new ProviderError(e.message, { kind: 'http', status: e.status, retryAfterMs: parseRetryAfter(e.headers), cause: e });
    }
    const type = typeof e.type === 'string' ? e.type : '';
    return new ProviderError(e.message, { kind: TRANSIENT_TYPES.has(type) ? 'overloaded' : 'rejected', cause: e });
  }
  // What is left is the SDK's bare AnthropicError. Two of those are a reply that did not finish: a
  // body that broke mid-read (MessageStream wraps the reader's TypeError and keeps it as `cause`)
  // and "request ended without sending any chunks". Anything else of that class is the SDK
  // refusing to make the request at all (no credentials, say), which retrying cannot fix.
  if (e instanceof Anthropic.AnthropicError) {
    const wrapped = (e as { cause?: unknown }).cause instanceof Error;
    if (wrapped || /ended without/i.test(e.message)) return streamIncomplete(e);
  }
  return e;
}
