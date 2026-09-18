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
  /**
   * How many tokens of conversation to send the model before compacting (lib/agent/compact.ts).
   * Optional so a profile saved before this existed reads as the default.
   */
  contextBudget?: number;
}

/**
 * Default context budget, in estimated tokens. Well under the 200k window of the models this ships
 * with, so a long chat compacts before any provider refuses it, and low enough that the resend cost
 * of a long session stays sane.
 */
export const DEFAULT_CONTEXT_BUDGET = 120_000;

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  baseUrl: '',
  apiKey: '',
  model: 'claude-opus-5',
  autoNameChats: true,
  /**
   * Follow the OS by default.
   *
   * This differs deliberately from the Volt OS design system, whose own default is dark. The design
   * system describes a full-screen dashboard someone chooses to look at; this is a side panel that
   * sits against whatever website the user is already on, all day. A panel that is charcoal beside
   * a white page is not "on brand", it is a lamp in the corner of the screen. Following the OS is
   * what people expect from a browser panel, and someone running a dark desktop still gets Volt OS
   * exactly as designed.
   *
   * Dark remains the fallback: `system` resolves to dark whenever the OS expresses no preference
   * (see tokens.css — only `prefers-color-scheme: light` overrides, so no-preference stays dark).
   *
   * This is the default for NEW installs only. An existing user's saved choice is never rewritten;
   * lib/settings.ts pins the old default for profiles that predate this change.
   */
  theme: 'system',
  contextBudget: DEFAULT_CONTEXT_BUDGET,
};

/** The three choices, in the order the compact ◐ toggle cycles them. */
export const THEME_CYCLE: readonly ThemeChoice[] = ['dark', 'light', 'system'];

/** What the toggle calls each choice, in its tooltip and its accessible name. */
export const THEME_LABEL: Record<ThemeChoice, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

/**
 * The next choice in the cycle: Dark → Light → System → Dark. A value outside the cycle (which the
 * types forbid, but stored data can still hold) starts it from the beginning.
 */
export function nextTheme(current: ThemeChoice): ThemeChoice {
  const i = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length] ?? 'dark';
}

/**
 * Which theme a stored profile should wear.
 *
 * The default changed from 'dark' to 'system' (see DEFAULT_SETTINGS.theme). Merging the new default
 * into an old profile would silently restyle someone who never asked for it, so a profile that
 * predates the change keeps the old default instead.
 *
 * The test is whether a settings object was ever stored at all. Settings are written whole
 * (saveSettings persists the full merged object), so any stored profile has been through the
 * Settings screen and carries an explicit `theme` — unless it was written before `theme` existed,
 * which is exactly the case this pins to 'dark'. A fresh install has nothing stored and follows
 * the OS.
 *
 * It lives here rather than in settings.ts so it sits beside the default it is defending, and so a
 * test can reach it without pulling in chrome.storage.
 */
export function resolveTheme(stored: Partial<Settings> | undefined): ThemeChoice {
  if (!stored) return DEFAULT_SETTINGS.theme; // fresh install: follow the OS
  const t = stored.theme;
  if (t === 'system' || t === 'dark' || t === 'light') return t; // an explicit choice, kept
  return 'dark'; // an existing profile from before the theme setting: unchanged, as it looked
}

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
  /**
   * Set when the model proposed without a successful run_script and said why. Shown on the
   * proposal card so the user knows this one was never run on a real page.
   */
  untestedReason?: string;
}

// Events streamed from the background agent loop to the side panel over a Port.
//
// The port is only a transport: one panel carries the events of every chat that is running, so
// every event says which chat it belongs to. The agent loop emits AgentEventBody and the
// background stamps `chatId` on at its single post() chokepoint, so no emitter can forget it.
export type AgentEventBody =
  | { type: 'text'; delta: string }
  /**
   * What the run is doing right now, for the side panel's live activity line. Emitted before each
   * model call and each tool execution, and once with 'idle' when the run is over.
   */
  | {
      type: 'status';
      phase: 'model' | 'tool' | 'idle';
      /** Tool name, for phase 'tool'. */
      tool?: string;
      /** Human detail: the script's description, the selector, or 'waiting for model'. */
      detail?: string;
      /** Agent-loop iteration, 1-based. */
      iteration?: number;
    }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; summary: string; isError: boolean }
  | { type: 'proposal'; proposal: ModProposal }
  /** A sent message has entered the conversation (started a turn, or was injected mid-run). */
  | { type: 'accepted'; id: string }
  /** A queued message was dropped because the run was stopped; the panel gets its text back. */
  | { type: 'unqueued'; id: string }
  /**
   * The turn ended on its own terms rather than by finishing: the step cap was reached. Not an
   * error — the conversation is intact and a reply continues it — so the panel shows it as a
   * muted note rather than a red row.
   */
  | { type: 'stopped'; reason: 'max_steps'; steps: number }
  | { type: 'done' }
  /**
   * A chat was renamed by the model after a turn finished, so the switcher can follow along. Like
   * every other body it carries no chatId of its own: the background stamps the chat it belongs to
   * at postAgentEvent(), and the panel renames that chat.
   */
  | { type: 'chat_title'; title: string }
  /**
   * The model history was compacted before a provider call: `tier` says which tier did it and the
   * two numbers are estimated tokens before and after. The panel renders a muted note; the
   * transcript the user reads is never rewritten, only the history the model sees.
   */
  | { type: 'compacted'; tier: 'elided' | 'summarised'; before: number; after: number }
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
