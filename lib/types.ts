// Shared types used across the background worker, content script and side panel.
import type { AttachedImage, ImageThumb } from './images';
import type { WaitCondition } from './agent/wait';
import type { ImagesSetting } from './providers/vision';
import type { ReasoningField, ThinkingLevel } from './thinking';

export type { AttachedImage, ImageThumb, ImagesSetting, ReasoningField, ThinkingLevel };

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
  /**
   * Where the user has shared this mod, remembered after they pressed the site's own save button
   * (lib/share.ts). Optional and additive: mods saved before sharing existed simply have none, and
   * nothing about running a mod reads it.
   */
  share?: ModShare;
}

/** A mod's published copies. Each is recorded only once the site itself has saved it. */
export interface ModShare {
  gist?: {
    /** https://gist.github.com/<user>/<id> */
    url: string;
    user: string;
    id: string;
    /** The .user.js file inside the gist. */
    fileName: string;
    /** The sha-less raw URL, which always serves the latest revision: the install link. */
    rawUrl: string;
    savedAt: number;
  };
  greasyFork?: {
    /** https://greasyfork.org/<locale>/scripts/<id>-<slug> */
    url: string;
    id: string;
    savedAt: number;
  };
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

/**
 * Where the side panel opens. 'tab' puts it on the one tab you opened it from — Chrome hides it
 * again on every other tab; 'window' is Chrome's window-wide panel, which follows you everywhere
 * until you close it. See lib/sidepanel.ts for how each is configured.
 */
export type SidePanelScope = 'tab' | 'window';

/**
 * What every model-facing function takes: the adapters, the titler, the compaction summariser.
 *
 * It is no longer what is STORED. The provider half (`provider`, `baseUrl`, `apiKey`, `model`,
 * `images`) comes from the connection and model a chat resolved to, and the rest are the global
 * preferences (`Prefs`, below); effectiveSettings() in lib/connections.ts puts the two together for
 * one run. A profile saved by a build that stored all of this under 'settings' is migrated into a
 * connection the first time it is read (migrateLegacySettings, same file).
 */
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
  /**
   * Where the toolbar icon (and the dashboard's Open button) puts the panel.
   *
   * Optional, and a profile that predates it reads as 'tab' — see resolveScope in lib/sidepanel.ts
   * for why this one does NOT pin old profiles to the old behaviour the way the theme does.
   */
  sidePanelScope?: SidePanelScope;
  /**
   * Look for newer versions of installed mods (lib/updates.ts): at most once a day per mod, and
   * never installing anything — a newer version is only offered. Optional; absent reads as on.
   */
  checkUpdates?: boolean;
  /**
   * Whether screenshots and attachments are sent to an OpenAI-compatible endpoint as pictures.
   *
   * Only this one provider needs the setting: the Anthropic and Responses backends accept images
   * from every model they serve, while "OpenAI-compatible" is whatever the user typed into Base
   * URL and may be a text-only model that answers a picture with a 400. 'auto' sends and learns
   * from that 400 (lib/providers/vision.ts); 'send' always sends; 'never' never does.
   *
   * Optional so a profile saved before this existed reads as 'auto'.
   */
  images?: ImagesSetting;
  /**
   * How much the model thinks before it answers, on the neutral scale every provider's own knob is
   * mapped onto (lib/thinking.ts). Filled per run from the chat's own setting by effectiveSettings,
   * exactly as `model` is. Absent means 'default': the adapter sends no reasoning field at all, so
   * a chat that has never been touched behaves as it did before the setting existed.
   */
  thinking?: ThinkingLevel;
  /**
   * Which reasoning field this OpenAI-compatible endpoint takes, from the connection. Only read by
   * lib/providers/openai.ts; 'auto' guesses from the model id. See lib/thinking.ts.
   */
  reasoningField?: ReasoningField;
  /** Extra top-level request fields for this connection, already parsed and validated. */
  customFields?: Record<string, unknown>;
}

/** The global preferences: the part of `Settings` stored under 'settings', none of it about a provider. */
export type Prefs = Pick<Settings, 'autoNameChats' | 'theme' | 'contextBudget' | 'sidePanelScope' | 'checkUpdates'>;

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
  /**
   * On the tab you opened it from, not on every tab. A panel that follows you onto every other tab
   * is Chrome's default shape, not a considered one: usermods is scoped to the page you are on —
   * its chats, its mods — so a panel sitting over an unrelated tab is showing you the wrong site's
   * everything. 'window' is one setting away for anyone who wants the old behaviour back.
   */
  sidePanelScope: 'tab',
  /**
   * Send images, and find out the hard way when the endpoint will not take them — once, and then
   * remember. The alternative defaults are both worse: 'send' makes a text-only local model fail
   * every screenshot with a 400 the user has to decode, and 'never' would silently blind a vision
   * model that works perfectly, which is the bug this setting exists to fix.
   */
  images: 'auto',
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
//
// `image` carries only png/jpeg: every attachment is re-encoded to one of those in the panel
// (entrypoints/sidepanel/images.ts) before it becomes a Part, so a WebP or GIF the user attached
// never reaches a backend that may not take it.
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: Part[]; isError?: boolean }
  /**
   * A provider-specific item replayed verbatim by the provider that produced it (e.g. reasoning
   * items) — and only by it. `provider` is the adapter's tag and `model` the model that wrote the
   * item; since the model can change mid-conversation, an adapter replays an item only when both
   * match and otherwise rebuilds the turn from its neutral parts (lib/providers/responses.ts
   * toInput). `model` is absent on histories stored before it was recorded.
   */
  | { type: 'opaque'; provider: string; model?: string; item: unknown };

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
   * Which connection and model this run talks to, posted once at the start of every run (a fresh
   * turn, a queued message's turn, a Resume). The panel uses it for two things: the transcript
   * records it, so a small marker can say where the model changed (lib/transcript.ts), and the
   * composer compares it with the chat's current selection to say "applies from the next turn"
   * while a run that started on another model is still going.
   */
  /** `thinking` rides along on the same event: the two are resolved together at the top of a run,
   *  and one event keeps the transcript's model and thinking markers in step. */
  | { type: 'model'; connectionId: string; label: string; model: string; thinking?: ThinkingLevel }
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
      /**
       * Set while the model request is being retried (lib/agent/retry.ts): the request failed for a
       * reason that will probably pass, and the loop is waiting before it asks again. `until` is a
       * Date.now() timestamp so the panel can count the wait down on its own clock; `offline` means
       * no attempt has been spent yet and the loop is waiting for the machine to come back online.
       * The next ordinary status event (without this field) is what returns the line to normal.
       */
      retry?: {
        reason: 'network' | 'stream' | 'rate_limit' | 'overloaded' | 'server' | 'offline';
        /** Which retry this is, 1-based, and how many there are. 0 of N while merely offline. */
        attempt: number;
        max: number;
        until: number;
        status?: number;
      };
    }
  /**
   * The model request failed part-way through its reply and is being made again (or has failed for
   * good). `chars` of assistant text were streamed to the panel for that attempt and are not part
   * of the conversation: the panel takes them back off the end of the transcript, so the retry's
   * own stream does not read as the same sentence twice.
   */
  | { type: 'text_discard'; chars: number }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; summary: string; isError: boolean }
  | { type: 'proposal'; proposal: ModProposal }
  /**
   * The chat's draft mod gained a version. Emitted after the background has stored it, so the panel
   * can re-read the artifact and show the new version as current. Like every other body it carries
   * no chatId: postAgentEvent() stamps the chat this belongs to, and the panel routes on that, so a
   * draft can never be applied to the chat that happens to be on screen.
   */
  | { type: 'artifact'; version: number }
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
  /**
   * Something the user should know that is not an error and not the model talking: so far, that the
   * configured OpenAI-compatible model turned out not to accept images, so the request was sent
   * again without them. It lands in the transcript as a muted note row, and is stored like any
   * other row so it survives a reload — a fact about the endpoint the user needs when they wonder
   * why the model is describing the page instead of looking at it.
   */
  | { type: 'note'; text: string }
  /**
   * `resumable` means the run stopped with its progress saved and can be continued from exactly
   * where it was, without the user sending anything (the panel's Resume button; see lib/runstate.ts).
   */
  | { type: 'error'; message: string; resumable?: boolean };

/** An event as it travels over the port: a body plus the chat it belongs to. */
export type AgentEvent = AgentEventBody & { chatId: string };

/**
 * One row of the side-panel transcript. Stored as-is in chrome.storage.local, so every member
 * must stay JSON-serializable.
 */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; refs?: ElementRef[]; images?: ImageThumb[]; queued?: boolean }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; summary?: string; isError?: boolean }
  /**
   * A proposal, as history. `version` is the artifact version this proposal became, so a card in
   * the transcript can say "v2" and its button can select that version in the artifact panel
   * rather than acting on its own copy of the code. Absent on cards written before drafts existed.
   *
   * There is deliberately no `saved` here. Whether a card is the version that is installed is read
   * from the artifact (see proposalCardState), because it changes every time the draft does — a
   * boolean written onto the row at save time went on claiming "saved" after the model had proposed
   * something else, which is the bug that made a fresh proposal look like it was already installed.
   * `saved` on a transcript restored from an older build is simply ignored.
   */
  | { kind: 'proposal'; proposal: ModProposal; version?: number }
  | { kind: 'note'; text: string }
  /**
   * The model the turns after it were produced by, until the next one of these: which connection
   * and model each assistant turn came from, as a row. Written only when it differs from the row of
   * this kind before it, so a chat that never changes model holds exactly one, at its first run.
   */
  | { kind: 'model'; connectionId: string; label: string; model: string; thinking?: ThinkingLevel }
  | { kind: 'error'; text: string };

/** A user message travelling from the side panel to the agent. */
export interface UserTurn {
  id: string;
  text: string;
  refs?: ElementRef[];
  /**
   * Images the user pasted, dropped or picked, already decoded, downscaled and re-encoded by the
   * panel (see lib/images.ts for the policy). They become `image` parts at the FRONT of the
   * rendered user message, because every provider expects the picture before the words about it.
   */
  images?: AttachedImage[];
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
  /**
   * Watch the DOM until a condition is true (lib/waitdom.ts). `id` is how the wait is cancelled:
   * Stop sends a 'wait-cancel' carrying the same id, because a content-script message cannot be
   * aborted from the background once it is in flight.
   */
  | { type: 'wait'; id: string; condition: WaitCondition; timeoutMs: number }
  | { type: 'wait-cancel'; id: string }
  /** Turn on the wait module's leftover-observer counter. Test flag only; see lib/waitdom.ts. */
  | { type: 'wait-debug' }
  /**
   * Open (or drop) a keepalive port back to the background, for as long as a run is driving this
   * tab. Safari only; see lib/keepalive.ts for the mechanism and lib/keepalive-holder.ts for this
   * end of it. The background is the only thing that ever sends this, and it sends `hold: false`
   * when the run ends — the port itself also carries a `release`, so a holder hears about the end
   * of a run whichever of the two channels is still up.
   */
  | { type: 'keepalive'; hold: boolean }
  /**
   * Sharing (lib/sharecontroller.ts): fill the gist or Greasy Fork form in this tab, show the hint
   * bubble, or list the .user.js files a just-saved gist holds. Sent only by the background, only
   * to a tab a share opened.
   */
  | { type: 'share-fill'; req: import('./sharefill').FillRequest }
  | { type: 'share-hint'; hint: ShareHintSpec }
  | { type: 'share-files' }
  | { type: 'ping' };

/** A hint bubble, as the background asks for it. The content script finds the anchor itself. */
export interface ShareHintSpec {
  text: string;
  extra?: string;
  /** Which of the site's buttons to point at. */
  anchor: 'gist-submit' | 'greasyfork-submit' | 'none';
  /** Put this on the clipboard (and offer a Copy button); `text`/`textNotCopied` say which happened. */
  copy?: string;
  textNotCopied?: string;
  /** Offer "Share as a new gist" (a deleted gist's edit page). */
  offerNewGist?: boolean;
  testId?: string;
}

export type ContentEvent = { type: 'picked'; element: PickedElement } | { type: 'pick-cancelled' };
