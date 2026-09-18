// Shared types used across the background worker, content script and side panel.

/** A saved userscript. `source` is the canonical full userscript text, header included. */
export interface Mod {
  id: string;
  name: string;
  description: string;
  version: string;
  /** Chrome match patterns, e.g. "*://*.example.com/*". */
  matches: string[];
  excludeMatches: string[];
  /** Glob-style @include / @exclude lines that are not valid match patterns. */
  includeGlobs: string[];
  excludeGlobs: string[];
  runAt: 'document_start' | 'document_end' | 'document_idle';
  /** MAIN when the script needs page globals (@grant none / unsafeWindow); otherwise the isolated user-script world. */
  world: 'USER_SCRIPT' | 'MAIN';
  allFrames: boolean;
  grants: string[];
  /** @require scripts, fetched at install time and prepended to the code. */
  requires: Array<{ url: string; code: string }>;
  /** @resource entries, fetched at install time. */
  resources: Array<{ name: string; url: string; mime: string; text: string; base64: string }>;
  /** Where the script came from, for updates. */
  downloadUrl?: string;
  /** Full userscript source including the ==UserScript== header. */
  source: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What the install screen shows before the user commits. */
export interface ScriptPreview {
  source: string;
  name: string;
  description: string;
  version: string;
  matches: string[];
  includeGlobs: string[];
  grants: string[];
  requires: string[];
  resources: string[];
  world: Mod['world'];
  runAt: Mod['runAt'];
  downloadUrl?: string;
  /** Header lines we could not honour. */
  warnings: string[];
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
  /** A sent message has entered the conversation (started a turn, or was injected mid-run). */
  | { type: 'accepted'; id: string }
  /** A queued message was dropped because the run was stopped; the panel gets its text back. */
  | { type: 'unqueued'; id: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * One row of the side-panel transcript. Stored as-is in chrome.storage.local, so every member
 * must stay JSON-serializable.
 */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; refs?: ElementRef[]; queued?: boolean }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; summary?: string; isError?: boolean }
  | { kind: 'proposal'; proposal: ModProposal; saved?: boolean }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

/** A user message travelling from the side panel to the agent. */
export interface UserTurn {
  id: string;
  text: string;
  refs?: ElementRef[];
}

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
