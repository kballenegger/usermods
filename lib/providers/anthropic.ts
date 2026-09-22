import Anthropic from '@anthropic-ai/sdk';
import { applyThinking, resolveThinkingLevel, thinkingCapability } from '../thinking.ts';
import type { Msg, Part, Settings, ToolDef } from '../types';
import { ProviderError, isAbortError, parseRetryAfter, streamIncomplete } from './errors.ts';
import type { Provider, ProviderResponse } from './types';

/**
 * Models that accept adaptive thinking. Older ones (Haiku 4.5, 3.x) reject it.
 *
 * Kept in step with ANTHROPIC_ADAPTIVE in lib/thinking.ts, which decides which levels the picker
 * offers: the two have to agree, or a model would be offered an effort ladder while being sent the
 * legacy budget shape. Mythos Preview supports both modes and is listed here for that reason.
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#supported-models
 */
const ADAPTIVE_THINKING = /(opus-5|sonnet-5|fable-5|mythos-5|mythos-preview|opus-4-[678]|sonnet-4-6)/;

/** What the Messages API accepts as a tool_use id. */
const TOOL_ID_OK = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Tool-call ids the Messages API will accept, for a history another backend may have written.
 *
 * The model can be swapped mid-conversation, so the ids in the history are whatever the PREVIOUS
 * backend minted: OpenAI's `call_…` and Anthropic's own `toolu_…` pass as they are, but an
 * OpenAI-compatible server is free to send `functions.get_page:0` or a bare `0`, and the Messages
 * API rejects the whole request over one character outside [a-zA-Z0-9_-]. Ids are only ever a join
 * key between a call and its result, so a bad one is rewritten — the same way at both ends, and
 * never onto an id that is already taken.
 */
function toolIdMapper(messages: Msg[]): (id: string) => string {
  const taken = new Set<string>();
  for (const m of messages) for (const p of m.content) if (p.type === 'tool_call' && TOOL_ID_OK.test(p.id)) taken.add(p.id);
  const mapped = new Map<string, string>();
  return (id) => {
    if (TOOL_ID_OK.test(id)) return id;
    const known = mapped.get(id);
    if (known) return known;
    const base = `call_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 56);
    let next = base;
    for (let n = 2; taken.has(next); n++) next = `${base}_${n}`;
    taken.add(next);
    mapped.set(id, next);
    return next;
  };
}

/**
 * The neutral history as Messages API messages.
 *
 * Written to be safe for a history this adapter did not produce (see toolIdMapper): `opaque` parts
 * belong to the backend that made them and are never sent here; a text block that is empty or only
 * whitespace — a local model's "\n\n" before its tool call — is dropped, because the API refuses
 * it; and a message left with nothing is dropped too, since only the final assistant message may be
 * empty. Two user messages in a row, which that can leave behind, are fine: the API joins them.
 *
 * Nothing here can emit a `thinking` block. Thinking is signed for the model that produced it, and
 * this adapter never stores one (see chat() below), so there is none to replay to anyone.
 *
 * Exported for test/compact.test.ts and test/swap.test.ts.
 */
export function toAnthropicMessages(messages: Msg[]): Anthropic.MessageParam[] {
  const toolId = toolIdMapper(messages);
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const p of m.content) {
      switch (p.type) {
        case 'opaque':
          break;
        case 'text':
          if (p.text.trim()) content.push({ type: 'text', text: p.text });
          break;
        case 'image':
          content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
          break;
        case 'tool_call':
          content.push({ type: 'tool_use', id: toolId(p.id), name: p.name, input: p.input });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: toolId(p.toolCallId),
            is_error: p.isError,
            content: p.content
              .filter((c) => c.type !== 'text' || c.text.trim())
              .map((c) =>
                c.type === 'image'
                  ? ({ type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } } as const)
                  : ({ type: 'text', text: c.type === 'text' ? c.text : JSON.stringify(c) } as const),
              ),
          });
          break;
      }
    }
    if (content.length) out.push({ role: m.role, content });
  }
  return out;
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
      // The chat's Thinking level as request fields (lib/thinking.ts). 'default' produces nothing,
      // so a chat nobody has touched sends exactly the body it sent before this existed.
      //
      // Where these go matters for the prompt cache. The system block below is cached with
      // cache_control, and the cached prefix is built from the system prompt, the tools and the
      // messages — none of which any thinking field appears in. `thinking` and `output_config` are
      // SIBLINGS of `system` at the top level of the request, so changing the level mid-chat never
      // rewrites the block the cache_control marker sits on: the block and its marker are
      // byte-identical across levels (asserted in test/thinking.test.ts).
      //
      // What the level DOES cost is a cache miss of its own, and that is unavoidable rather than a
      // bug here: Anthropic renders the resolved thinking configuration and effort into the prompt,
      // so "switching thinking modes, changing the effort value, and changing budget_tokens all
      // invalidate cache breakpoints". That is one miss on the turn the user changes the level, and
      // hits again on every turn after it, because the fields are then stable.
      // https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-and-prompt-caching
      const level = resolveThinkingLevel(settings.thinking);
      const cap = thinkingCapability({ kind: 'anthropic', model });
      const think = applyThinking(level, cap);
      // The adapter's own default mode, which the level can override (to 'disabled', or to the
      // legacy 'enabled' + budget_tokens on an older model).
      const defaultThinking = ADAPTIVE_THINKING.test(model) ? { thinking: { type: 'adaptive' as const } } : {};

      const stream = client.messages.stream(
        {
          model,
          max_tokens: 16000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: toAnthropicMessages(messages),
          tools: toAnthropicTools(tools),
          ...defaultThinking,
          // A union the mapping builds structurally ({type:'disabled'} or {type:'enabled',
          // budget_tokens}); lib/thinking.ts owns which shape each model may receive.
          ...(think.thinking ? { thinking: think.thinking as unknown as Anthropic.ThinkingConfigParam } : {}),
          ...think.body,
        } as Anthropic.MessageStreamParams,
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
