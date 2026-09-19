// What a provider adapter throws when a model request fails.
//
// The adapters used to throw a bare `Error("503 Service Unavailable: …")`, which left the agent
// loop with nothing but a string to decide whether the failure was worth retrying. This carries
// the facts instead: the HTTP status when there was one, how long the server asked us to wait, and
// what kind of failure it was when there was no status at all (a connection that never opened, a
// stream that stopped before its terminal event, a provider saying it is overloaded mid-stream).
// lib/agent/retry.ts reads these fields; nothing parses the message.
//
// The message itself is unchanged from what the adapters used to produce, because it is what the
// user reads in the chat when retrying does not help.

export type ProviderErrorKind =
  /** The server answered with a non-2xx status. `status` is set. */
  | 'http'
  /** The request never got an answer: DNS, TLS, a refused or reset connection, being offline. */
  | 'network'
  /** The response began and then stopped before the event that ends a reply. */
  | 'stream'
  /** The provider reported, inside a 200 stream, that it is overloaded or failed internally. */
  | 'overloaded'
  /** The provider reported, inside a 200 stream, an error that retrying will not fix. */
  | 'rejected';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  /** From Retry-After / retry-after-ms, already in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { kind: ProviderErrorKind; status?: number; retryAfterMs?: number; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = opts.kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Anything with a `get(name)`: a fetch Headers object, or the one the Anthropic SDK hands back. */
interface HeaderBag {
  get(name: string): string | null | undefined;
}

/**
 * How long the server asked us to wait, in milliseconds, or undefined when it did not say.
 *
 * `retry-after-ms` wins when present (Anthropic and OpenAI both send it, and it is the precise
 * one). `Retry-After` is either a number of seconds or an HTTP date; a date in the past, or
 * anything unparseable, reads as "did not say" rather than as zero.
 */
export function parseRetryAfter(headers: HeaderBag | null | undefined, now: number = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return at > now ? at - now : undefined;
}

/** The error for a non-2xx fetch response. Reads the body for the message, as the adapters did. */
export async function httpError(res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => '');
  return new ProviderError(`${res.status} ${res.statusText}: ${body.slice(0, 500)}`.trim(), {
    kind: 'http',
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers),
  });
}

/** The error for a stream that closed (or broke) before the event that ends a reply. */
export function streamIncomplete(cause?: unknown): ProviderError {
  return new ProviderError('The connection dropped before the model finished replying.', { kind: 'stream', cause });
}

/** Was this thrown because the run's AbortSignal fired? Stop must never look like a failure. */
export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: unknown }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/**
 * `fetch`, but a failure to get any response at all comes back as a ProviderError of kind
 * 'network' rather than the browser's bare TypeError("Failed to fetch"). An abort passes through
 * untouched.
 */
export async function fetchOrNetworkError(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (isAbortError(e) || init.signal?.aborted) throw e;
    throw new ProviderError(`Could not reach the model provider (${e instanceof Error ? e.message : String(e)}).`, { kind: 'network', cause: e });
  }
}

/**
 * Read a streamed body to its end, handing each chunk to `onChunk`. A read that fails part-way (the
 * connection was reset, the machine went offline) becomes a 'stream' ProviderError; an abort passes
 * through untouched.
 */
export async function readStream(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, onChunk: (text: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw e;
      throw streamIncomplete(e);
    }
    if (chunk.done) return;
    onChunk(decoder.decode(chunk.value, { stream: true }));
  }
}
