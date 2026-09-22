import {
  CHATGPT_CODEX_BASE,
  SUBSCRIPTIONS_OFF,
  XAI_PROXY_BASE,
  unavailableProviderMessage,
} from '../buildflags.ts';
import type { Settings } from '../types';
// .ts extensions: lib/agent/loop.ts imports this file, and the loop is unit tested under node
// --experimental-strip-types, whose resolver does not guess them (see lib/transcript.ts).
import { applyThinking, resolveThinkingLevel, thinkingCapability, xaiSupportsReasoning } from '../thinking.ts';
import { createAnthropicProvider } from './anthropic.ts';
import { createOpenAIProvider, type OpenAIProviderDeps } from './openai.ts';
import { createResponsesProvider } from './responses.ts';
import type { Provider } from './types';

/**
 * Extras only the OpenAI-compatible adapter takes: where its "this model has no eyes" memory lives
 * and who to tell when it learns something. Passed from the background, which owns both storage and
 * the panel's event stream; a caller that omits them (the unit tests) gets an adapter that still
 * falls back, but remembers nothing and tells no one.
 */
export function createProvider(settings: Settings, deps: OpenAIProviderDeps = {}): Provider {
  switch (settings.provider) {
    case 'anthropic':
      return createAnthropicProvider(settings);
    case 'openai-compatible':
      return createOpenAIProvider(settings, deps);
    case 'chatgpt':
    case 'xai':
      return createSubscriptionProvider(settings, settings.provider);
  }
}

/**
 * ChatGPT / SuperGrok, which sign in with an account instead of an API key.
 *
 * Absent from the Chrome Web Store build. The guard is a compile-time constant, so the bundler
 * drops this whole branch there — including the dynamic import of ../oauth, and with it every
 * vendor auth endpoint. The import is deliberately dynamic for that reason: a static one would
 * pull the auth module into every bundle that reaches createProvider.
 */
function createSubscriptionProvider(settings: Settings, kind: 'chatgpt' | 'xai'): Provider {
  if (SUBSCRIPTIONS_OFF) throw new Error(unavailableProviderMessage(kind));
  const oauth = () => import('../oauth');

  // The chat's Thinking level, if it set one. 'default' maps to nothing, so the per-vendor defaults
  // just below stay exactly as they were: medium for ChatGPT, high for xAI. A chosen level replaces
  // the effort and keeps `summary`, which is about what comes BACK rather than how hard it thinks.
  const level = resolveThinkingLevel(settings.thinking);
  const chosen = applyThinking(level, thinkingCapability({ kind, model: settings.model })).body as
    | { reasoning?: { effort?: string } }
    | Record<string, never>;
  const effort = chosen.reasoning?.effort;

  if (kind === 'chatgpt') {
    return createResponsesProvider({
      tag: 'chatgpt',
      baseUrl: settings.baseUrl || CHATGPT_CODEX_BASE,
      model: settings.model,
      headers: async () => {
        const o = await oauth();
        return o.chatgptHeaders(await o.getValidTokens('chatgpt'));
      },
      body: { reasoning: { effort: effort ?? 'medium', summary: 'auto' } },
    });
  }

  return createResponsesProvider({
    tag: 'xai',
    baseUrl: settings.baseUrl || XAI_PROXY_BASE,
    model: settings.model,
    headers: async () => {
      const o = await oauth();
      return o.xaiProxyHeaders(settings.model, (await o.getValidTokens('xai')).access);
    },
    // xAI's non-reasoning and -fast variants reject the field outright, which is also why
    // thinkingCapability offers them no levels: neither half can put one on the wire.
    body: xaiSupportsReasoning(settings.model) ? { reasoning: { effort: effort ?? 'high' } } : {},
  });
}

export type { Provider } from './types';
