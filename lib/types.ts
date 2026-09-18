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
  /** Raw @connect values (e.g. "api.example.com", "*", "self", "localhost"), enforced for GM_xmlhttpRequest. */
  connect: string[];
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
  /** Raw @connect values the script asks for. */
  connect: string[];
  requires: string[];
  resources: string[];
  world: Mod['world'];
  runAt: Mod['runAt'];
  downloadUrl?: string;
  /** Header lines we could not honour. */
  warnings: string[];
}

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'chatgpt' | 'xai';

/** Which palette the UI wears. 'system' follows the OS; the other two are deliberate choices. */
export type ThemeChoice = 'system' | 'dark' | 'light';

export interface Settings {
  provider: ProviderKind;
  /** Optional base URL override. For openai-compatible this is required (e.g. http://localhost:11434/v1). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Let the model name chats after the first turn. Off keeps the truncated first message.
   * Optional so a profile saved before this existed reads as the default (on).
   */
  autoNameChats?: boolean;
  theme: ThemeChoice;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  baseUrl: '',
  apiKey: '',
  model: 'claude-opus-5',
  autoNameChats: true,
  // Dark is the design system's default, so it is this extension's default too.
  theme: 'dark',
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
//
// The port is only a transport: one panel carries the events of every chat that is running, so
// every event says which chat it belongs to. The agent loop emits AgentEventBody and the
// background stamps `chatId` on at its single post() chokepoint, so no emitter can forget it.
export type AgentEventBody =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; summary: string; isError: boolean }
  | { type: 'proposal'; proposal: ModProposal }
  /** A sent message has entered the conversation (started a turn, or was injected mid-run). */
  | { type: 'accepted'; id: string }
  /** A queued message was dropped because the run was stopped; the panel gets its text back. */
  | { type: 'unqueued'; id: string }
  | { type: 'done' }
  /**
   * A chat was renamed by the model after a turn finished, so the switcher can follow along. Like
   * every other body it carries no chatId of its own: the background stamps the chat it belongs to
   * at postAgentEvent(), and the panel renames that chat.
   */
  | { type: 'chat_title'; title: string }
  | { type: 'error'; message: string };

/** An event as it travels over the port: a body plus the chat it belongs to. */
export type AgentEvent = AgentEventBody & { chatId: string };

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
