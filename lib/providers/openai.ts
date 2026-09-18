// OpenAI-compatible chat completions adapter. Covers OpenAI, OpenRouter, Ollama, LM Studio,
// vLLM, mlx_lm.server and anything else that speaks /v1/chat/completions with tools.
import type { Msg, Part, Settings, ToolDef } from '../types';
import type { Provider, ProviderResponse } from './types';

export type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Exported for test/compact.test.ts, which asserts that a compacted history still converts cleanly. */
export function toOpenAIMessages(system: string, messages: Msg[]): OAIMessage[] {
  const out: OAIMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
      const calls = m.content.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
      continue;
    }
    // user: tool results become separate `tool` messages; the rest becomes one user message.
    const results = m.content.filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');
    for (const r of results) {
      const text = r.content
        .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image omitted: this backend does not accept images in tool results]' : JSON.stringify(c)))
        .join('\n');
      out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERROR: ${text}` : text });
    }
    const rest = m.content.filter((p) => p.type !== 'tool_result' && p.type !== 'opaque');
    if (rest.length) {
      const hasImage = rest.some((p) => p.type === 'image');
      out.push({
        role: 'user',
        content: hasImage
          ? rest.map((p) =>
              p.type === 'image'
                ? { type: 'image_url' as const, image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
                : { type: 'text' as const, text: p.type === 'text' ? p.text : JSON.stringify(p) },
            )
          : rest.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n'),
      });
    }
  }
  return out;
}

export function createOpenAIProvider(settings: Settings): Provider {
  const base = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    async chat({ system, messages, tools, signal, callbacks }): Promise<ProviderResponse> {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: settings.model,
          stream: true,
          messages: toOpenAIMessages(system, messages),
          ...(tools.length
            ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
            : {}),
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
      }

      let text = '';
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let finish: string | null = null;

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
          if (data === '[DONE]') continue;
          let json: any;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            callbacks.onText(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(idx, cur);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }

      const content: Part[] = [];
      if (text) content.push({ type: 'text', text });
      for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        let input: Record<string, unknown> = {};
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          input = { __invalid_json: c.args };
        }
        content.push({ type: 'tool_call', id: c.id || `call_${i}`, name: c.name, input });
      }
      const stopReason: ProviderResponse['stopReason'] =
        calls.size > 0 || finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
      return { content, stopReason };
    },
  };
}
