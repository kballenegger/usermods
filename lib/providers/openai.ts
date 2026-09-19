// OpenAI-compatible chat completions adapter. Covers OpenAI, OpenRouter, Ollama, LM Studio,
// vLLM, mlx_lm.server and anything else that speaks /v1/chat/completions with tools.
import type { Msg, Part, Settings, ToolDef } from '../types';
import { ProviderError, fetchOrNetworkError, httpError, parseRetryAfter, readStream, streamIncomplete } from './errors.ts';
import type { Provider, ProviderResponse } from './types';
import {
  ATTACHMENT_UNSUPPORTED_NOTE,
  IMAGE_FORWARDED_NOTE,
  IMAGE_UNSUPPORTED_NOTE,
  NO_VISION_MEMORY,
  DEFAULT_OPENAI_BASE,
  isVisionRejection,
  resolveImagesSetting,
  shouldSendImages,
  visionKeyFor,
  type VisionMemory,
} from './vision.ts';

export type OAIPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OAIPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Deliver the images a tool result carried, given that a `tool` message cannot hold one.
 *
 * chat/completions is strict about two things at once, and they pull in opposite directions. A
 * `tool` message's content is text — there is no image part in its schema, and a backend that is
 * handed one answers 400. And every `tool` message answering an assistant's tool_calls must follow
 * that assistant message with nothing in between, or the API rejects the history outright.
 *
 * So the picture cannot go where it belongs and cannot go before the tool messages either. It goes
 * immediately AFTER them, in a user message of its own, with the tool text saying to look there —
 * which is exactly the arrangement lib/providers/responses.ts already uses for the same reason, and
 * the arrangement every vision-capable chat/completions backend reads correctly, because from the
 * model's point of view it is a person saying "here is the screenshot you just took".
 *
 * A text part names which call each image belongs to, so a step with two screenshots in it is not
 * two anonymous pictures. When the original user message ALSO had its own text and images (a
 * message the user typed while the tools were running), they merge into this same message rather
 * than becoming a second user message beside it: two user messages in a row are legal but they
 * read as two turns, and the queued text would be attributed to the screenshot.
 */
function imageFollowUp(items: Array<{ callId: string; images: Array<Extract<Part, { type: 'image' }>> }>): OAIPart[] {
  const parts: OAIPart[] = [];
  for (const { callId, images } of items) {
    if (!images.length) continue;
    parts.push({
      type: 'text',
      text: `[${images.length === 1 ? 'Image' : `${images.length} images`} returned by tool call ${callId}]`,
    });
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
  }
  return parts;
}

/** Everything but a tool result and an opaque part, as chat-completions content parts. */
function userParts(rest: Part[], sendImages: boolean): OAIPart[] {
  const parts: OAIPart[] = [];
  for (const p of rest) {
    if (p.type === 'image') {
      if (sendImages) parts.push({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
      else parts.push({ type: 'text', text: ATTACHMENT_UNSUPPORTED_NOTE });
    } else {
      parts.push({ type: 'text', text: p.type === 'text' ? p.text : JSON.stringify(p) });
    }
  }
  return parts;
}

/**
 * The neutral history as chat-completions messages.
 *
 * `sendImages` is false when the configured model is known not to take them (or the user set Images
 * to Never): every picture is replaced by a sentence saying so, and the shape of the history is
 * otherwise identical — same messages, same order, same ids — so the two modes differ only in what
 * the model can see, never in what the API will accept.
 *
 * Exported for test/compact.test.ts, which asserts that a compacted history still converts cleanly.
 */
export function toOpenAIMessages(system: string, messages: Msg[], sendImages = true): OAIMessage[] {
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

    // user: tool results become separate `tool` messages FIRST, unbroken, then one user message
    // carrying their images and anything else this message held.
    const results = m.content.filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result');
    const carried: Array<{ callId: string; images: Array<Extract<Part, { type: 'image' }>> }> = [];
    for (const r of results) {
      const images = r.content.filter((c): c is Extract<Part, { type: 'image' }> => c.type === 'image');
      const text = r.content
        .map((c) =>
          c.type === 'text' ? c.text : c.type === 'image' ? (sendImages ? IMAGE_FORWARDED_NOTE : IMAGE_UNSUPPORTED_NOTE) : JSON.stringify(c),
        )
        .join('\n');
      out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERROR: ${text}` : text });
      if (sendImages && images.length) carried.push({ callId: r.toolCallId, images });
    }

    const rest = m.content.filter((p) => p.type !== 'tool_result' && p.type !== 'opaque');
    const follow = imageFollowUp(carried);
    const own = userParts(rest, sendImages);
    const parts = [...follow, ...own];
    if (!parts.length) continue;
    // A message with nothing but text collapses to a plain string, which is what a chat-completions
    // backend that predates content parts expects and what every later one still accepts.
    const plain = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: plain ? parts.map((p) => (p as { text: string }).text).join('\n') : parts });
  }
  return out;
}

/** Does this history contain anything that would be sent as an image_url part? */
export function hasImages(messages: Msg[]): boolean {
  return messages.some((m) => m.content.some((p) => p.type === 'image' || (p.type === 'tool_result' && p.content.some((c) => c.type === 'image'))));
}

/** What createOpenAIProvider needs beyond the settings. Injected so the tests can drive both. */
export interface OpenAIProviderDeps {
  /** Where "this endpoint+model does not take images" is remembered across sessions. */
  memory?: VisionMemory;
  /** Told once, when Auto has just discovered a text-only backend. The panel shows a note. */
  onVisionUnsupported?: (key: string) => void;
}

export function createOpenAIProvider(settings: Settings, deps: OpenAIProviderDeps = {}): Provider {
  const base = (settings.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/+$/, '');
  const memory = deps.memory ?? NO_VISION_MEMORY;
  const setting = resolveImagesSetting(settings.images);
  const key = visionKeyFor(settings);

  return {
    async chat({ system, messages, tools, signal, callbacks }): Promise<ProviderResponse> {
      const toolsField = tools.length
        ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
        : {};
      const send = (withImages: boolean) =>
        fetchOrNetworkError(`${base}/chat/completions`, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: settings.model,
            stream: true,
            messages: toOpenAIMessages(system, messages, withImages),
            ...toolsField,
          }),
        });

      // Does this request carry a picture at all, and are we allowed to send it? A history with no
      // images takes the plain path and never consults the store.
      const carriesImages = hasImages(messages);
      let withImages = carriesImages && (await shouldSendImages(setting, key, memory));

      let res = await send(withImages);

      // The Auto fallback. It lives HERE, in the adapter, rather than in the agent loop, for two
      // reasons. Only the adapter knows whether this request actually put an `image_url` part on
      // the wire — the loop holds a neutral history and cannot tell what the chat/completions shape
      // of it was — and only the adapter can rebuild the same request without them. Doing it in the
      // loop would mean teaching the loop one wire protocol's content parts, and every other
      // adapter would have to be taught not to care.
      //
      // It is also deliberately NOT part of lib/agent/retry.ts. A vision rejection is a `rejected`
      // ProviderError: sending the same bytes again gets the same 400, five times, with backoff in
      // between. This is a different request, sent once, immediately, with no wait — so the two
      // compose exactly as they should. If this second request fails in a way backoff CAN fix, it
      // throws and withRetry takes it from there, and the images are already remembered as
      // unsupported so the retry does not re-discover it.
      if (!res.ok && withImages && setting === 'auto') {
        // The body is read here rather than by httpError, because the classifier needs it and a
        // Response body can only be read once.
        const body = await res.text().catch(() => '');
        if (isVisionRejection(res.status, body)) {
          await memory.markUnsupported(key);
          deps.onVisionUnsupported?.(key);
          withImages = false;
          res = await send(false);
        } else {
          throw new ProviderError(`${res.status} ${res.statusText}: ${body.slice(0, 500)}`.trim(), {
            kind: 'http',
            status: res.status,
            retryAfterMs: parseRetryAfter(res.headers),
          });
        }
      }
      if (!res.ok || !res.body) throw await httpError(res);

      let text = '';
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let finish: string | null = null;
      // Whether the reply actually ended. A chat-completions stream ends with a chunk carrying a
      // finish_reason and then `[DONE]`; a body that simply stops has been cut off, and treating
      // the half of a reply we did get as the whole of it would put a truncated tool call (or a
      // sentence that stops mid-word) into the history as if the model had meant it.
      let sawDone = false;

      let buf = '';
      await readStream(res.body, signal, (chunk) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            sawDone = true;
            continue;
          }
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
      });
      if (!finish && !sawDone) throw streamIncomplete();

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
