// Retrying a model request that failed for a reason that will probably pass.
//
// The owner's report was "lost connections lead to retrying the prompt entirely". The loop made one
// request per step and any failure at all (a dropped stream, a 503, a rate limit, thirty seconds of
// no Wi-Fi) threw straight out of the run. This module is the policy that stands between a blip
// and the user: which failures are worth another attempt, how long to wait, and when to give up.
//
// It wraps the MODEL REQUEST only. Tool execution is never retried from here: tools have side
// effects on the page, and a run_script that may or may not have run is not something to run again
// on a guess.
//
// Everything that touches a clock, a random number or the network state is injected, so the whole
// policy is tested without waiting for it (test/retry.test.ts).
//
// The .ts extension on the import is load-bearing, as in lib/transcript.ts: `npm test` runs this
// through node --experimental-strip-types, whose ESM resolver does not guess extensions.
import { ProviderError, isAbortError } from '../providers/errors.ts';

/** Why an attempt is being retried. Drives the activity line's wording (lib/activity.ts). */
export type RetryReason = 'network' | 'stream' | 'rate_limit' | 'overloaded' | 'server';

export interface Classification {
  retryable: boolean;
  /** Set when retryable. */
  reason?: RetryReason;
  status?: number;
  retryAfterMs?: number;
}

/**
 * Statuses that mean "not now" rather than "no". 408 and 425 are the server asking for the same
 * request again; 429 is a rate limit; 500/502/503/504 are the provider or something in front of it
 * falling over; 529 is Anthropic's "overloaded". Everything else in the 4xx range is a statement
 * about the request itself (a bad key, a missing model, a history the API rejects), and sending it
 * again gets the same answer five more times.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/**
 * What a browser (and node, for the tests) says when a request got no answer at all. Chrome:
 * "Failed to fetch" before the response, "network error" once the body is streaming. Safari: "Load
 * failed". Firefox: "NetworkError when attempting to fetch resource." node: "fetch failed",
 * "terminated". These are only consulted for errors that did NOT come from an adapter — an adapter
 * throws a ProviderError, which says what it is.
 */
const NETWORK_MESSAGE = /failed to fetch|network ?error|load failed|fetch failed|^terminated$|connection (?:error|reset|closed)|econnreset|econnrefused|socket hang up/i;

/** Decide whether one failed model request is worth another attempt. Pure. */
export function classifyError(e: unknown): Classification {
  // Stop. Never a failure, never retried.
  if (isAbortError(e)) return { retryable: false };

  if (e instanceof ProviderError) {
    switch (e.kind) {
      case 'network':
        return { retryable: true, reason: 'network' };
      case 'stream':
        return { retryable: true, reason: 'stream' };
      case 'overloaded':
        return { retryable: true, reason: 'overloaded' };
      case 'rejected':
        return { retryable: false };
      case 'http':
        return classifyStatus(e.status, e.retryAfterMs);
    }
  }

  // Not from an adapter: an error object from somewhere else that still knows its status…
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return classifyStatus(status, undefined);

  // …or a bare network failure. The cause chain is walked because wrappers (the Anthropic SDK's
  // stream, undici) keep the original error there and put their own words on top.
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    if (NETWORK_MESSAGE.test(cur.message)) return { retryable: true, reason: 'network' };
    cur = (cur as { cause?: unknown }).cause;
  }

  // Invalid settings, a refusal, a bug: whatever it is, it is not the weather.
  return { retryable: false };
}

function classifyStatus(status: number | undefined, retryAfterMs: number | undefined): Classification {
  if (status === undefined || !RETRYABLE_STATUS.has(status)) return { retryable: false, ...(status === undefined ? {} : { status }) };
  const reason: RetryReason = status === 429 ? 'rate_limit' : status === 529 ? 'overloaded' : 'server';
  return { retryable: true, reason, status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

// ---------------------------------------------------------------------------
// Context-length failures
// ---------------------------------------------------------------------------
//
// "It breaks in long sessions." One proven way it does: contextBudget defaults to 120,000 tokens
// for EVERY provider, and the Settings screen says so outright ("One budget for every provider: set
// it for the smallest context window you use"). Point a chat at a model with a 32k window and the
// history sails past that window long before it reaches 70% of 120,000, which is where compaction
// first runs. The provider answers 400, classifyError says "not the weather", and the run dies —
// with the compactor watching, holding a history it was never asked to shrink.
//
// A context overflow is not retryable as-is (sending the same thing again gets the same 400), but
// it IS retryable after compaction, which is a different request. That is a third category, and
// the loop acts on it: compact hard, send once more, remember a smaller budget for this connection
// and model, and say so in the transcript.
//
// It has to be recognised from the message, because there is no status or code that means it
// everywhere. Every phrasing below is one a real backend sends:
//
//   OpenAI / OpenAI-compatible  "This model's maximum context length is 8192 tokens. However, your
//                               messages resulted in 9101 tokens", code "context_length_exceeded"
//   Azure OpenAI                "maximum context length", code "context_length_exceeded"
//   Anthropic                   "prompt is too long: 215000 tokens > 200000 maximum"
//   llama.cpp / LM Studio       "the request exceeds the available context size", "context window"
//   Ollama                      "maximum context length", "too many tokens"
//   vLLM / TGI                  "longer than the maximum ... length", "input validation error:
//                               `inputs` must have less than N tokens"
//   Google / Gemini-compatible  "input token count exceeds the maximum"
//
// Deliberately NOT matched: "max_tokens" on its own, which is about the REPLY length and is a
// setting, not an overflow; and "rate limit ... tokens per minute", which is a 429 and already has
// its own handling. Both would send the loop compacting for no reason.
const CONTEXT_LENGTH_MESSAGE = new RegExp(
  [
    'context[ _]?length[ _]?exceeded',
    'maximum context length',
    "model's maximum context",
    'context window',
    'exceeds? the available context',
    'prompt is too long',
    'too many tokens',
    'reduce the length of the messages',
    'input token count exceeds',
    'longer than the maximum',
    'must have less than \\d+ tokens',
    'exceeds the maximum (?:allowed )?(?:input |prompt )?(?:tokens|length)',
  ].join('|'),
  'i',
);

/** The phrasings that LOOK like an overflow but are about something else. Checked first. */
const NOT_CONTEXT_OVERFLOW = /rate[ _]?limit|tokens per (?:minute|day)|max_tokens must|max_completion_tokens/i;

/**
 * Does this error mean "your conversation is longer than this model's window"?
 *
 * Pure, and message-based by necessity — see the note above. Only ever consulted for a failure that
 * is NOT otherwise retryable, so a 429 whose body happens to mention a context window is still
 * handled as a rate limit.
 */
export function isContextLengthError(e: unknown): boolean {
  const status = e instanceof ProviderError ? e.status : (e as { status?: unknown } | null)?.status;
  // A 5xx is the server falling over, whatever its body says; an overflow is always the request's
  // own fault, which providers report as a 4xx (400 almost everywhere, 413 on a few gateways).
  if (typeof status === 'number' && (status < 400 || status >= 500)) return false;
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    const msg = cur.message;
    if (CONTEXT_LENGTH_MESSAGE.test(msg) && !NOT_CONTEXT_OVERFLOW.test(msg)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** How many times a failed request is tried again. Five: 1s, 2s, 4s, 8s, 16s. */
  maxRetries: number;
  /** The first wait. Each later one doubles it. */
  baseDelayMs: number;
  /** No computed backoff waits longer than this… */
  maxDelayMs: number;
  /** …but a server that asks for longer is obeyed, up to here. */
  retryAfterCapMs: number;
  /** The wait is spread by ± this fraction, so a fleet of panels does not retry in lockstep. */
  jitter: number;
  /** How long to sit out `navigator.onLine === false` before trying anyway. */
  offlineCapMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 16_000,
  retryAfterCapMs: 60_000,
  jitter: 0.25,
  offlineCapMs: 120_000,
};

/**
 * The storage key the background reads an override from. It exists for the browser smoke flow,
 * which cannot spend 31 seconds per scenario waiting out real backoff.
 *
 * It is a chrome.storage.local key, which is the point: only the extension's own contexts can write
 * there. A web page cannot, a userscript in the USER_SCRIPT world cannot (its GM values live under
 * their own per-mod keys, written by the background), and nothing in the UI sets it.
 */
export const RETRY_POLICY_KEY = 'debug:retryPolicy';

/**
 * A stored override, sanitised. Only finite numbers within sane bounds are taken, field by field;
 * anything else keeps the default, so a corrupt value cannot switch retrying off or make it spin.
 */
export function resolvePolicy(raw: unknown, base: RetryPolicy = DEFAULT_RETRY_POLICY): RetryPolicy {
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const num = (key: keyof RetryPolicy, min: number, max: number): number => {
    const v = r[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : base[key];
  };
  return {
    maxRetries: Math.floor(num('maxRetries', 0, 10)),
    baseDelayMs: num('baseDelayMs', 1, 60_000),
    maxDelayMs: num('maxDelayMs', 1, 120_000),
    retryAfterCapMs: num('retryAfterCapMs', 1, 300_000),
    jitter: num('jitter', 0, 1),
    offlineCapMs: num('offlineCapMs', 1, 600_000),
  };
}

/**
 * How long to wait before retry number `retry` (1-based).
 *
 * Exponential from the base, capped, then jittered. A Retry-After is a floor, not a suggestion: the
 * server knows when its limit resets and a request sent earlier is a request wasted, so the wait is
 * whichever is longer — but never longer than retryAfterCapMs, because a server asking for ten
 * minutes is better answered by giving up and letting the user press Resume when they are ready.
 */
export function backoffDelay(retry: number, policy: RetryPolicy, random: () => number, retryAfterMs?: number): number {
  const nominal = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry - 1));
  const spread = 1 + policy.jitter * (random() * 2 - 1);
  const backoff = Math.round(nominal * spread);
  if (retryAfterMs === undefined) return backoff;
  return Math.max(backoff, Math.min(retryAfterMs, policy.retryAfterCapMs));
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface RetryDeps {
  /** Resolve after `ms`, or reject with an AbortError the moment `signal` fires. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** In [0, 1). */
  random(): number;
  /** navigator.onLine, where there is one. */
  isOnline(): boolean;
  /** Resolve when the machine is back online or `capMs` has passed; reject on abort. */
  waitForOnline(capMs: number, signal: AbortSignal): Promise<void>;
}

/** What the runner reports before it sleeps, so the panel can say what is happening. */
export interface RetryNotice {
  /** Which retry this is, 1-based. */
  attempt: number;
  max: number;
  delayMs: number;
  reason: RetryReason;
  status?: number;
}

export interface RetryOptions {
  policy?: RetryPolicy;
  signal: AbortSignal;
  deps?: Partial<RetryDeps>;
  /** Every failed attempt, retryable or not, before anything else happens. */
  onAttemptFailed?(error: unknown, classification: Classification): void;
  /** About to wait `notice.delayMs` and then try again. */
  onRetry?(notice: RetryNotice): void;
  /** The machine is offline; waiting for it to come back (at most `capMs`). No attempt is spent. */
  onOffline?(capMs: number): void;
  /** A wait is over and the request is about to be made again. */
  onResume?(): void;
}

function abortError(): Error {
  return new DOMException('The run was stopped.', 'AbortError');
}

/** A timer that Stop can cut short. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wait for the `online` event on whatever global this is (a service worker has one), with a cap. */
function waitForOnlineEvent(capMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const target = globalThis as unknown as Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener?.('online', onOnline);
      signal.removeEventListener('abort', onAbort);
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(onOnline, capMs);
    target.addEventListener?.('online', onOnline);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_DEPS: RetryDeps = {
  sleep: abortableSleep,
  random: Math.random,
  // `navigator.onLine` is only ever a hint, and only its `false` is trustworthy: false means there
  // is no network interface at all, true means there might be one. So false is worth waiting on
  // and true proves nothing, which is exactly how it is used here.
  isOnline: () => (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? true : navigator.onLine),
  waitForOnline: waitForOnlineEvent,
};

/**
 * Run `attempt` until it succeeds, fails for good, or runs out of retries.
 *
 * Throws what the last attempt threw, untouched, so the caller sees the provider's own words. An
 * abort — during a request, a backoff sleep or an offline wait — rejects with an AbortError at
 * once: Stop must not have to sit out a 16 second timer.
 */
export async function withRetry<T>(attempt: (retry: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const deps: RetryDeps = { ...DEFAULT_DEPS, ...options.deps };
  const { signal } = options;

  for (let retry = 0; ; retry++) {
    if (signal.aborted) throw abortError();

    // Being offline is not a failed attempt, it is a reason not to make one. Burning five tries in
    // thirty seconds against a laptop with its lid half shut would turn every commute into a
    // Resume click; waiting for the interface to come back costs nothing.
    if (!deps.isOnline()) {
      options.onOffline?.(policy.offlineCapMs);
      await deps.waitForOnline(policy.offlineCapMs, signal);
      if (signal.aborted) throw abortError();
      options.onResume?.();
    }

    try {
      return await attempt(retry);
    } catch (e) {
      if (signal.aborted || isAbortError(e)) throw e;
      const c = classifyError(e);
      options.onAttemptFailed?.(e, c);
      if (!c.retryable || retry >= policy.maxRetries) throw e;
      const delayMs = backoffDelay(retry + 1, policy, deps.random, c.retryAfterMs);
      options.onRetry?.({ attempt: retry + 1, max: policy.maxRetries, delayMs, reason: c.reason!, ...(c.status === undefined ? {} : { status: c.status }) });
      await deps.sleep(delayMs, signal);
      options.onResume?.();
    }
  }
}
