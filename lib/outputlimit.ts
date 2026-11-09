// The output limit an OpenAI-compatible request carries, and what to do when a server refuses it.
//
// chat/completions makes the limit optional, and servers fill the gap differently. Some give the
// reply the rest of the context window; others cap it at a few thousand tokens. A thinking model on
// a 4096 cap can spend every token reasoning and answer nothing (finish_reason "length", zero
// content). So every request names a limit, set per connection, defaulting to 16384.
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

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

/** `max_completion_tokens` for OpenAI's own API, `max_tokens` for every other base URL. */
export function maxTokensFieldFor(baseUrl: string): MaxTokensField {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return 'max_tokens';
  }
  return host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
}

const FIELD = String.raw`(?:max_tokens|max_completion_tokens|max_new_tokens)`;

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
  if (UNSUPPORTED.some((re) => re.test(text))) return 'unsupported';
  if (TOO_LARGE.some((re) => re.test(text))) return 'too-large';
  return null;
}

/** Where endpoint+model pairs that refuse the field live in chrome.storage.local. */
export const OUTPUT_LIMIT_STORAGE_KEY = 'outputlimit:unsupported';
