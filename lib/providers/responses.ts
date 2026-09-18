// OpenAI Responses API adapter (streaming, function tools). Used for the subscription-backed
// backends, which speak Responses rather than chat completions. Generic: the caller supplies the
// base URL, headers and any body extras.
import type { Msg, Part, ToolDef } from '../types';
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

/** Exported for test/compact.test.ts, which asserts that a compacted history still converts cleanly. */
export function toInput(messages: Msg[], tag: string): Item[] {
  const input: Item[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const opaque = m.content.filter((p): p is Extract<Part, { type: 'opaque' }> => p.type === 'opaque' && p.provider === tag);
      if (opaque.length) {
        // We produced this turn: replay the original output items verbatim (reasoning, messages, calls).
        for (const p of opaque) input.push(p.item as Item);
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
      const res = await fetch(`${base}/responses`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
        body: JSON.stringify({
          model: cfg.model,
          instructions: system,
          input: toInput(messages, cfg.tag),
          tools: tools.map((t: ToolDef) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false })),
          tool_choice: 'auto',
          parallel_tool_calls: false,
          store: false,
          stream: true,
          include: ['reasoning.encrypted_content'],
          ...cfg.body,
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
      }

      const content: Part[] = [];
      let stopReason: ProviderResponse['stopReason'] = 'end_turn';
      let sawToolCall = false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
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
              content.push({ type: 'opaque', provider: cfg.tag, item });
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
              const status = ev.response?.status;
              const reason = ev.response?.incomplete_details?.reason;
              if (status === 'incomplete' && reason === 'max_output_tokens') stopReason = 'max_tokens';
              else if (status === 'incomplete' && reason === 'content_filter') stopReason = 'refusal';
              break;
            }
            case 'response.incomplete':
              stopReason = ev.response?.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'other';
              break;
            case 'response.failed':
              throw new Error(ev.response?.error?.message ?? 'The model request failed.');
            case 'error':
              throw new Error(ev.error?.message ?? ev.message ?? 'The model request failed.');
          }
        }
      }
      if (sawToolCall && stopReason === 'end_turn') stopReason = 'tool_use';
      return { content, stopReason };
    },
  };
}
