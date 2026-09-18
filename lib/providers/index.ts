import type { Settings } from '../types';
import { createAnthropicProvider } from './anthropic';
import { createOpenAIProvider } from './openai';
import type { Provider } from './types';

export function createProvider(settings: Settings): Provider {
  switch (settings.provider) {
    case 'anthropic':
      return createAnthropicProvider(settings);
    case 'openai-compatible':
      return createOpenAIProvider(settings);
  }
}

export type { Provider } from './types';
