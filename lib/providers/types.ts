import type { Msg, Part, Settings, ToolDef } from '../types';

export interface StreamCallbacks {
  onText: (delta: string) => void;
}

export interface ProviderResponse {
  /** Assistant content parts (text and tool calls). */
  content: Part[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
}

export interface Provider {
  chat(args: {
    system: string;
    messages: Msg[];
    tools: ToolDef[];
    signal?: AbortSignal;
    callbacks: StreamCallbacks;
  }): Promise<ProviderResponse>;
}

export type ProviderFactory = (settings: Settings) => Provider;
