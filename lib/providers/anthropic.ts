import Anthropic from '@anthropic-ai/sdk';
import type { Msg, Part, Settings, ToolDef } from '../types';
import type { Provider, ProviderResponse } from './types';

/** Models that accept adaptive thinking. Older ones (Haiku 4.5, 3.x) reject it. */
const ADAPTIVE_THINKING = /(opus-5|sonnet-5|fable-5|mythos-5|opus-4-[678]|sonnet-4-6)/;

function toAnthropicMessages(messages: Msg[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((p): Anthropic.ContentBlockParam => {
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
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl || undefined,
    // We run inside an extension service worker, which the SDK treats as a browser.
    // The key never leaves the user's own machine except to the endpoint they configured.
    dangerouslyAllowBrowser: true,
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
      const message = await stream.finalMessage();

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
