// OpenAI Responses API adapter (streaming, function tools). Used for the subscription-backed
// backends, which speak Responses rather than chat completions. Generic: the caller supplies the
// base URL, headers and any body extras.
import type { Msg, Part, ToolDef } from '../types';
import { ProviderError, fetchOrNetworkError, httpError, readStream, streamIncomplete } from './errors.ts';
import type { Provider, ProviderResponse } from './types';

export interface ResponsesConfig {
  baseUrl: string;
  model: string;
  headers: () => Promise<Record<string, string>>;
  /** Extra top-level request fields (e.g. reasoning settings). */
  body?: Record<string, unknown>;
  /** Tag stored on opaque parts so only this adapter replays them. */
  tag: string;
}

type Item = Record<string, unknown>;

/**
 * The neutral history as Responses input items.
 *
 * A turn this backend produced is replayed from its `opaque` items — the original output items,
 * reasoning included — and every other turn is rebuilt from its neutral parts. "This backend" means
 * the same TAG and the same MODEL: the model can be swapped mid-conversation, and an encrypted
 * reasoning item is the private state of the model that wrote it. One from ChatGPT is never sent to
 * xAI (different tag), and one from a model the chat has since left is not sent to its successor
 * either (different model) — those turns fall back to their neutral text and tool calls, which is
 * always a valid history, because the API only objects to a reasoning item WITHOUT the item it
 * reasons about, never to the item without its reasoning. `model` is optional on both sides so a
 * history stored before it was recorded still replays the way it always did.
 *
 * Exported for test/compact.test.ts and test/swap.test.ts.
 */
export function toInput(messages: Msg[], tag: string, model?: string): Item[] {
  const input: Item[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const opaque = m.content.filter(
        (p): p is Extract<Part, { type: 'opaque' }> =>
          p.type === 'opaque' && p.provider === tag && (model === undefined || p.model === undefined || p.model === model),
      );
      if (opaque.length) {
        // We produced this turn: replay the original output items verbatim (reasoning, messages, calls).
        const items = opaque.map((p) => p.item as Item);
        // …except reasoning that reasons about nothing: a turn cut off while it was still thinking
        // ends in a reasoning item with no message or call after it, and the API rejects exactly that.
        while (items.length && items[items.length - 1]?.type === 'reasoning') items.pop();
        input.push(...items);
        continue;
      }
      for (const p of m.content) {
        if (p.type === 'text' && p.text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: p.text }] });
        else if (p.type === 'tool_call') input.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.input) });
      }
      continue;
    }
    const images: Item[] = [];
    const texts: Item[] = [];
    for (const p of m.content) {
      if (p.type === 'tool_result') {
        const text = p.content
          .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image attached in the next message]' : JSON.stringify(c)))
          .join('\n');
        input.push({ type: 'function_call_output', call_id: p.toolCallId, output: p.isError ? `ERROR: ${text}` : text });
        for (const c of p.content) if (c.type === 'image') images.push({ type: 'input_image', image_url: `data:${c.mediaType};base64,${c.data}`, detail: 'auto' });
      } else if (p.type === 'text') texts.push({ type: 'input_text', text: p.text });
      else if (p.type === 'image') images.push({ type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}`, detail: 'auto' });
    }
    if (texts.length || images.length) input.push({ type: 'message', role: 'user', content: [...texts, ...images] });
  }
  return input;
}

export function createResponsesProvider(cfg: ResponsesConfig): Provider {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return {
    async chat({ system, messages, tools, signal, callbacks }): Promise<ProviderResponse> {
      const headers = await cfg.headers();
      const res = await fetchOrNetworkError(`${base}/responses`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
        body: JSON.stringify({
          model: cfg.model,
          instructions: system,
          input: toInput(messages, cfg.tag, cfg.model),
          tools: tools.map((t: ToolDef) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false })),
          tool_choice: 'auto',
          parallel_tool_calls: false,
          store: false,
          stream: true,
          include: ['reasoning.encrypted_content'],
          ...cfg.body,
        }),
      });
      if (!res.ok || !res.body) throw await httpError(res);

      const content: Part[] = [];
      let stopReason: ProviderResponse['stopReason'] = 'end_turn';
      let sawToolCall = false;
      // A Responses stream ends with response.completed or response.incomplete (a failure throws).
      // A body that stops before either has been cut off; see the same check in openai.ts.
      let sawTerminal = false;

      let buf = '';
      await readStream(res.body, signal, (chunk) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let ev: any;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          switch (ev.type) {
            case 'response.output_text.delta':
              if (typeof ev.delta === 'string') callbacks.onText(ev.delta);
              break;
            case 'response.output_item.done': {
              const item = ev.item as Item;
              // Keep the raw item for replay, then derive the neutral parts.
              content.push({ type: 'opaque', provider: cfg.tag, model: cfg.model, item });
              if (item.type === 'message' && Array.isArray(item.content)) {
                const text = (item.content as Item[]).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
                if (text) content.push({ type: 'text', text });
              } else if (item.type === 'function_call') {
                sawToolCall = true;
                let input: Record<string, unknown> = {};
                try {
                  input = typeof item.arguments === 'string' && item.arguments ? JSON.parse(item.arguments) : {};
                } catch {
                  input = { __invalid_json: item.arguments };
                }
                content.push({ type: 'tool_call', id: String(item.call_id ?? item.id), name: String(item.name), input });
              }
              break;
            }
            case 'response.completed': {
              sawTerminal = true;
              const status = ev.response?.status;
              const reason = ev.response?.incomplete_details?.reason;
              if (status === 'incomplete' && reason === 'max_output_tokens') stopReason = 'max_tokens';
              else if (status === 'incomplete' && reason === 'content_filter') stopReason = 'refusal';
              break;
            }
            case 'response.incomplete':
              sawTerminal = true;
              stopReason = ev.response?.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'other';
              break;
            case 'response.failed':
              throw streamedError(ev.response?.error);
            case 'error':
              throw streamedError(ev.error ?? ev);
          }
        }
      });
      if (!sawTerminal) throw streamIncomplete();
      if (sawToolCall && stopReason === 'end_turn') stopReason = 'tool_use';
      return { content, stopReason };
    },
  };
}

/**
 * Error codes a Responses backend reports INSIDE a 200 stream that mean "try again": the server
 * fell over or is shedding load. Everything else (a bad request, a policy rejection, an unknown
 * model) is reported as 'rejected', because sending the same request again gets the same answer.
 */
const TRANSIENT_CODES = /^(server_error|internal_error|overloaded|overloaded_error|rate_limit_exceeded|rate_limit_error|service_unavailable|timeout)$/i;

function streamedError(err: { code?: unknown; type?: unknown; message?: unknown } | null | undefined): ProviderError {
  const message = typeof err?.message === 'string' && err.message ? err.message : 'The model request failed.';
  const code = typeof err?.code === 'string' ? err.code : typeof err?.type === 'string' ? err.type : '';
  return new ProviderError(message, { kind: TRANSIENT_CODES.test(code) ? 'overloaded' : 'rejected' });
}
