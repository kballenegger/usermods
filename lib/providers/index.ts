import { CHATGPT_CODEX_BASE, XAI_PROXY_BASE, chatgptHeaders, getValidTokens, xaiProxyHeaders } from '../oauth';
import type { Settings } from '../types';
import { createAnthropicProvider } from './anthropic';
import { createOpenAIProvider } from './openai';
import { createResponsesProvider } from './responses';
import type { Provider } from './types';

export function createProvider(settings: Settings): Provider {
  switch (settings.provider) {
    case 'anthropic':
      return createAnthropicProvider(settings);
    case 'openai-compatible':
      return createOpenAIProvider(settings);
    case 'chatgpt':
      return createResponsesProvider({
        tag: 'chatgpt',
        baseUrl: settings.baseUrl || CHATGPT_CODEX_BASE,
        model: settings.model,
        headers: async () => chatgptHeaders(await getValidTokens('chatgpt')),
        body: { reasoning: { effort: 'medium', summary: 'auto' } },
      });
    case 'xai':
      return createResponsesProvider({
        tag: 'xai',
        baseUrl: settings.baseUrl || XAI_PROXY_BASE,
        model: settings.model,
        headers: async () => xaiProxyHeaders(settings.model, (await getValidTokens('xai')).access),
        body: xaiSupportsReasoning(settings.model) ? { reasoning: { effort: 'high' } } : {},
      });
  }
}

/** Effort-capable models per xAI's catalog; "non-reasoning" and "-fast" variants reject the field. */
function xaiSupportsReasoning(model: string): boolean {
  return !/non-reasoning|fast$/.test(model);
}

export type { Provider } from './types';
