// The output limit an OpenAI-compatible request carries, and what to do when a server refuses it.
//
// chat/completions makes the limit optional, and servers fill the gap differently. Some give the
// reply the rest of the context window; others cap it at a few thousand tokens. A thinking model on
// a 4096 cap can spend every token reasoning and answer nothing (finish_reason "length", zero
// content). So every request names a limit, set per connection, defaulting to 16384.
//
// Two hosts are the exception when the box is left empty: OpenAI's own API and OpenRouter give an
// omitted limit the model's full output, so the default there is to send nothing. A cap on those
// would only cut a reasoning model short (its thinking counts against the limit).
//
// The field name differs too. OpenAI's own API takes `max_completion_tokens` and its reasoning models
// reject `max_tokens` with a 400. Everything else that speaks the protocol (vLLM, llama.cpp, Ollama,
// LM Studio, OpenRouter) reads `max_tokens`. Pure, no I/O; tested in test/outputlimit.test.ts.

/** What a connection with no stored limit (every connection from an older build) sends. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/** The largest value the setting accepts. Well past any model's real output limit. */
export const MAX_OUTPUT_TOKENS_CEILING = 1_000_000;

/** A stored value that is missing, corrupt or out of range reads as the default. */
export function resolveMaxOutputTokens(value: unknown): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_MAX_OUTPUT_TOKENS;
  const i = Math.floor(n);
  return i >= 1 && i <= MAX_OUTPUT_TOKENS_CEILING ? i : DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Hosts that give a request with no limit the model's whole output allowance. */
const FULL_OUTPUT_HOSTS = new Set(['api.openai.com', 'openrouter.ai']);

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Whether an empty Max output tokens box means "send no limit" for this base URL. */
export function omitsDefaultLimit(baseUrl: string): boolean {
  return FULL_OUTPUT_HOSTS.has(hostOf(baseUrl));
}

/**
 * The limit a request to this base URL carries, or null for none. A value the user set always goes.
 * An unset one (missing, 0 or unusable) is the default, except on hosts that already give the model
 * its full output when the field is left out.
 */
export function outputLimitFor(baseUrl: string, stored: unknown): number | null {
  const n = typeof stored === 'string' && stored.trim() ? Number(stored) : stored;
  const set = typeof n === 'number' && Number.isFinite(n) && Math.floor(n) >= 1 && Math.floor(n) <= MAX_OUTPUT_TOKENS_CEILING;
  if (set) return Math.floor(n);
  return omitsDefaultLimit(baseUrl) ? null : DEFAULT_MAX_OUTPUT_TOKENS;
}

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

/** `max_completion_tokens` for OpenAI's own API, `max_tokens` for every other base URL. */
export function maxTokensFieldFor(baseUrl: string): MaxTokensField {
  return hostOf(baseUrl) === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
}

const FIELD = String.raw`(?:max_tokens|max_completion_tokens|max_new_tokens)`;

/**
 * The value is past a fixed maximum the server states. DeepSeek: "Invalid max_tokens value, the valid
 * range of max_tokens is [1, 8192]". OpenAI: "Invalid 'max_completion_tokens': integer above maximum
 * value. Expected a value <= 8192". These say "invalid" too, so they are checked before UNSUPPORTED:
 * the server takes the field, just not this number, and remembering it as unsupported would drop the
 * limit for good and bring back the server's short default.
 */
const OUT_OF_RANGE = [
  new RegExp(String.raw`\b${FIELD}\b[^]{0,120}?(?:valid range|above (?:the )?maximum|maximum value|expected a value|<=|less than or equal|at most|must be (?:between|in))`, 'i'),
];

/** The server does not take the field at all. Remembered, like a refused reasoning field. */
const UNSUPPORTED = [
  new RegExp(String.raw`\b(?:unrecognized|unknown|unsupported|unexpected|invalid|extra)\b[^.?!]{0,60}?\b${FIELD}\b`, 'i'),
  new RegExp(String.raw`\b${FIELD}\b[^.?!]{0,80}?\b(?:is not|isn't|not)\b[^.?!]{0,40}?\b(?:supported|permitted|allowed|recognized|recognised|expected)\b`, 'i'),
];

/**
 * The limit plus the prompt is more than the model's window. vLLM words it as "'max_tokens' ... is
 * too large" or "you requested N tokens (X in the messages, Y in the completion)". Sending again
 * without the field lets the server size the reply to what is left. Not remembered: the next turn
 * may well fit, and dropping the field for good would bring back the short default cap.
 */
const TOO_LARGE = [
  new RegExp(String.raw`\b${FIELD}\b[^.?!]{0,60}?\b(?:too large|too big|too high|exceeds?|must be (?:less|at most|<=?))`, 'i'),
  /\bin the completion\b/i,
];

/**
 * Did this 4xx refuse the output-limit field? 'unsupported' when the server does not take it,
 * 'too-large' when the value does not fit the window with this prompt, null for anything else.
 * A 5xx, a 413 or a 429 is never this.
 */
export function outputLimitRejection(status: number | undefined, body: string | undefined): 'unsupported' | 'too-large' | null {
  if (typeof status !== 'number' || status < 400 || status >= 500 || status === 413 || status === 429) return null;
  const text = (body ?? '').slice(0, 4000);
  if (!text) return null;
  if (OUT_OF_RANGE.some((re) => re.test(text))) return 'too-large';
  if (UNSUPPORTED.some((re) => re.test(text))) return 'unsupported';
  if (TOO_LARGE.some((re) => re.test(text))) return 'too-large';
  return null;
}

/**
 * The largest limit a refusal says the server accepts, when it says so plainly ("[1, 8192]",
 * "<= 8192", "at most 8192", "less than or equal to 8192"). The adapter retries with this number
 * rather than with no limit, since no limit can mean a short server default. null when the body
 * names no such ceiling; a context-window figure ("maximum context length is 32768") is not one.
 */
export function outputLimitCeiling(body: string | undefined): number | null {
  const text = (body ?? '').slice(0, 4000);
  const m =
    /\[\s*\d+\s*,\s*(\d+)\s*\]/.exec(text) ??
    /(?:<=|less than or equal to|at most)\s*(\d+)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/** Where endpoint+model pairs that refuse the field live in chrome.storage.local. */
export const OUTPUT_LIMIT_STORAGE_KEY = 'outputlimit:unsupported';
