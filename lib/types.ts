// Shared types used across the background worker, content script and side panel.

/** A saved userscript. `source` is the canonical full userscript text, header included. */
export interface Mod {
  id: string;
  name: string;
  description: string;
  /** Chrome match patterns, e.g. "*://*.example.com/*". */
  matches: string[];
  /** Full userscript source including the ==UserScript== header. */
  source: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'chatgpt' | 'xai';

export interface Settings {
  provider: ProviderKind;
  /** Optional base URL override. For openai-compatible this is required (e.g. http://localhost:11434/v1). */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  baseUrl: '',
  apiKey: '',
  model: 'claude-opus-5',
};

// Provider-neutral conversation format. Adapters translate to each API's wire shape.
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: Part[]; isError?: boolean }
  /** A provider-specific item replayed verbatim by the provider that produced it (e.g. reasoning items). */
  | { type: 'opaque'; provider: string; item: unknown };

export interface Msg {
  role: 'user' | 'assistant';
  content: Part[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A mod the model has drafted for the user to try or save. */
export interface ModProposal {
  name: string;
  description: string;
  matches: string[];
  /** Script body without the userscript header. */
  code: string;
}

// Events streamed from the background agent loop to the side panel over a Port.
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; summary: string; isError: boolean }
  | { type: 'proposal'; proposal: ModProposal }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** An element the user picked on the page. */
export interface PickedElement {
  selector: string;
  html: string;
  /** Short human label, e.g. `button "Subscribe"`. */
  label: string;
}

/** A picked element bound to an @token the user typed in their message. */
export interface ElementRef extends PickedElement {
  token: string;
}

// Messages between the side panel / background and the content script.
export type ContentRequest =
  | { type: 'snapshot'; selector?: string; maxChars?: number }
  | { type: 'query'; selector: string; limit?: number }
  | { type: 'styles'; selector: string; properties?: string[] }
  | { type: 'pick' }
  | { type: 'ping' };

export type ContentEvent = { type: 'picked'; element: PickedElement } | { type: 'pick-cancelled' };
