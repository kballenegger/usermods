import {
  CHATGPT_CODEX_BASE,
  STORE_BUILD,
  XAI_PROXY_BASE,
  unavailableProviderMessage,
} from '../buildflags.ts';
import type { Settings } from '../types';
// .ts extensions: lib/agent/loop.ts imports this file, and the loop is unit tested under node
// --experimental-strip-types, whose resolver does not guess them (see lib/transcript.ts).
import { createAnthropicProvider } from './anthropic.ts';
import { createOpenAIProvider } from './openai.ts';
import { createResponsesProvider } from './responses.ts';
import type { Provider } from './types';

export function createProvider(settings: Settings): Provider {
  switch (settings.provider) {
    case 'anthropic':
      return createAnthropicProvider(settings);
    case 'openai-compatible':
      return createOpenAIProvider(settings);
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
  if (STORE_BUILD) throw new Error(unavailableProviderMessage(kind));
  const oauth = () => import('../oauth');

  if (kind === 'chatgpt') {
    return createResponsesProvider({
      tag: 'chatgpt',
      baseUrl: settings.baseUrl || CHATGPT_CODEX_BASE,
      model: settings.model,
      headers: async () => {
        const o = await oauth();
        return o.chatgptHeaders(await o.getValidTokens('chatgpt'));
      },
      body: { reasoning: { effort: 'medium', summary: 'auto' } },
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
    body: xaiSupportsReasoning(settings.model) ? { reasoning: { effort: 'high' } } : {},
  });
}

/** Effort-capable models per xAI's catalog; "non-reasoning" and "-fast" variants reject the field. */
function xaiSupportsReasoning(model: string): boolean {
  return !/non-reasoning|fast$/.test(model);
}

export type { Provider } from './types';
