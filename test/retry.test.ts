// The retry policy around the model request: which failures are worth another attempt, how long to
// wait, and that Stop ends a wait at once. Nothing here sleeps: the clock, the dice and the network
// state are all injected (lib/agent/retry.ts).
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RETRY_POLICY, abortableSleep, backoffDelay, classifyError, isContextLengthError, resolvePolicy, withRetry, type RetryNotice } from '../lib/agent/retry.ts';
import { ProviderError, parseRetryAfter, streamIncomplete } from '../lib/providers/errors.ts';
import { toProviderError } from '../lib/providers/anthropic.ts';
import Anthropic from '@anthropic-ai/sdk';

const http = (status: number, retryAfterMs?: number) => new ProviderError(`${status} nope`, { kind: 'http', status, retryAfterMs });
const abort = () => new DOMException('stopped', 'AbortError');

// ---------- the classifier ----------

test('the classifier table: what is retried and what is not', () => {
  const table: Array<[string, unknown, boolean, string?]> = [
    // Retryable: the network, a cut-off stream, and "not now" statuses.
    ['fetch TypeError (Chrome)', new TypeError('Failed to fetch'), true, 'network'],
    ['stream TypeError (Chrome)', new TypeError('network error'), true, 'network'],
    ['fetch TypeError (Safari)', new TypeError('Load failed'), true, 'network'],
    ['fetch TypeError (node)', new TypeError('fetch failed'), true, 'network'],
    ['a wrapped network error', new Error('boom', { cause: new TypeError('Failed to fetch') }), true, 'network'],
    ['adapter: network', new ProviderError('x', { kind: 'network' }), true, 'network'],
    ['adapter: stream ended early', streamIncomplete(), true, 'stream'],
    ['adapter: overloaded mid-stream', new ProviderError('Overloaded', { kind: 'overloaded' }), true, 'overloaded'],
    ['408', http(408), true, 'server'],
    ['425', http(425), true, 'server'],
    ['429', http(429), true, 'rate_limit'],
    ['500', http(500), true, 'server'],
    ['502', http(502), true, 'server'],
    ['503', http(503), true, 'server'],
    ['504', http(504), true, 'server'],
    ['529', http(529), true, 'overloaded'],
    ['a foreign error that knows its status', Object.assign(new Error('x'), { status: 503 }), true, 'server'],
    // Not retryable: the request is wrong, the user pressed Stop, or it is not a provider problem.
    ['400', http(400), false],
    ['401', http(401), false],
    ['403', http(403), false],
    ['404', http(404), false],
    ['409', http(409), false],
    ['422', http(422), false],
    ['adapter: rejected mid-stream', new ProviderError('invalid prompt', { kind: 'rejected' }), false],
    ['Stop (DOM AbortError)', abort(), false],
    ['Stop (SDK)', Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }), false],
    ['no usable model', new Error('Connect a provider in Settings to start: an API key, a local server, or a subscription sign-in.'), false],
    ['a plain bug', new TypeError("Cannot read properties of undefined (reading 'x')"), false],
    ['not an error at all', 'nope', false],
  ];
  for (const [name, err, retryable, reason] of table) {
    const c = classifyError(err);
    assert.equal(c.retryable, retryable, name);
    if (reason) assert.equal(c.reason, reason, name);
  }
});

test('a Retry-After survives classification', () => {
  assert.equal(classifyError(http(429, 7000)).retryAfterMs, 7000);
  assert.equal(classifyError(http(503)).retryAfterMs, undefined);
});

test('the Anthropic SDK errors become structured errors, by class rather than by message', () => {
  const headers = new Headers({ 'retry-after': '3' });
  const rate = toProviderError(Anthropic.APIError.generate(429, { error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, headers));
  assert.ok(rate instanceof ProviderError);
  assert.equal(rate.status, 429);
  assert.equal(rate.retryAfterMs, 3000);
  assert.deepEqual(classifyError(rate), { retryable: true, reason: 'rate_limit', status: 429, retryAfterMs: 3000 });

  const auth = toProviderError(Anthropic.APIError.generate(401, { error: { type: 'authentication_error', message: 'bad key' } }, undefined, new Headers()));
  assert.equal(classifyError(auth).retryable, false);

  const conn = toProviderError(new Anthropic.APIConnectionError({ message: 'Connection error.' }));
  assert.equal(classifyError(conn).reason, 'network');

  // An `error` event inside a 200 stream: no status, the type on the error.
  const overloaded = toProviderError(new Anthropic.APIError(undefined, { error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers(), 'overloaded_error' as never));
  assert.equal(classifyError(overloaded).reason, 'overloaded');
  const invalid = toProviderError(new Anthropic.APIError(undefined, { error: { type: 'invalid_request_error', message: 'no' } }, undefined, new Headers(), 'invalid_request_error' as never));
  assert.equal(classifyError(invalid).retryable, false);

  // A body that broke mid-read arrives as a bare AnthropicError wrapping the reader's error.
  const broken = Object.assign(new Anthropic.AnthropicError('network error'), { cause: new TypeError('network error') });
  assert.equal(classifyError(toProviderError(broken)).reason, 'stream');
  // …but the SDK refusing to make the request at all is not a dropped stream.
  assert.equal(classifyError(toProviderError(new Anthropic.AnthropicError('Could not resolve authentication method.'))).retryable, false);

  // Stop passes straight through, whatever it looks like.
  const stopped = abort();
  assert.equal(toProviderError(stopped), stopped);
});

// ---------- Retry-After parsing ----------

test('Retry-After: seconds, milliseconds, a date, and nonsense', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(parseRetryAfter(h({ 'retry-after': '12' })), 12_000);
  assert.equal(parseRetryAfter(h({ 'retry-after': '1.5' })), 1500);
  assert.equal(parseRetryAfter(h({ 'retry-after-ms': '250', 'retry-after': '9' })), 250, 'the precise header wins');
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter(h({ 'retry-after': 'Thu, 01 Jan 2026 00:00:30 GMT' }), now), 30_000);
  assert.equal(parseRetryAfter(h({ 'retry-after': 'Thu, 01 Jan 2025 00:00:00 GMT' }), now), undefined, 'a date in the past is no instruction');
  assert.equal(parseRetryAfter(h({ 'retry-after': 'soon' })), undefined);
  assert.equal(parseRetryAfter(h({ 'retry-after': '0' })), undefined);
  assert.equal(parseRetryAfter(h({})), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});

// ---------- backoff ----------

const mid = () => 0.5; // no jitter either way

test('backoff doubles from one second: 1s, 2s, 4s, 8s, 16s, and five attempts', () => {
  assert.equal(DEFAULT_RETRY_POLICY.maxRetries, 5);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffDelay(n, DEFAULT_RETRY_POLICY, mid)), [1000, 2000, 4000, 8000, 16_000]);
  assert.equal(backoffDelay(9, DEFAULT_RETRY_POLICY, mid), 16_000, 'capped');
});

test('jitter spreads a wait by a quarter either way and no further', () => {
  assert.equal(backoffDelay(3, DEFAULT_RETRY_POLICY, () => 0), 3000);
  assert.equal(backoffDelay(3, DEFAULT_RETRY_POLICY, () => 0.999999), 5000);
});

test('Retry-After is a floor, capped at a minute', () => {
  assert.equal(backoffDelay(1, DEFAULT_RETRY_POLICY, mid, 7000), 7000, 'the server asked for longer than the backoff');
  assert.equal(backoffDelay(5, DEFAULT_RETRY_POLICY, mid, 2000), 16_000, 'the backoff is already longer');
  assert.equal(backoffDelay(1, DEFAULT_RETRY_POLICY, mid, 600_000), 60_000, 'ten minutes is answered with the cap');
});

test('a stored policy override is sanitised field by field', () => {
  assert.deepEqual(resolvePolicy(undefined), DEFAULT_RETRY_POLICY);
  assert.deepEqual(resolvePolicy('fast'), DEFAULT_RETRY_POLICY);
  const p = resolvePolicy({ baseDelayMs: 50, maxRetries: 2.9, jitter: 'lots', maxDelayMs: -1, offlineCapMs: Infinity });
  assert.equal(p.baseDelayMs, 50);
  assert.equal(p.maxRetries, 2);
  assert.equal(p.jitter, DEFAULT_RETRY_POLICY.jitter);
  assert.equal(p.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs);
  assert.equal(p.offlineCapMs, DEFAULT_RETRY_POLICY.offlineCapMs);
  assert.equal(resolvePolicy({ maxRetries: 1000 }).maxRetries, DEFAULT_RETRY_POLICY.maxRetries, 'cannot be made to spin');
});

// ---------- the runner ----------

/** A sleep that records what it was asked for and returns at once. */
function fakeClock() {
  const slept: number[] = [];
  return { slept, deps: { sleep: async (ms: number) => void slept.push(ms), random: mid, isOnline: () => true } };
}

test('fails N times then succeeds: the waits are the backoff schedule and the result comes back', async () => {
  const clock = fakeClock();
  const notices: RetryNotice[] = [];
  let resumed = 0;
  let calls = 0;
  const out = await withRetry(
    async () => {
      if (++calls <= 3) throw http(503);
      return 'ok';
    },
    { signal: new AbortController().signal, deps: clock.deps, onRetry: (n) => notices.push(n), onResume: () => resumed++ },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 4);
  assert.deepEqual(clock.slept, [1000, 2000, 4000]);
  assert.deepEqual(notices.map((n) => [n.attempt, n.max, n.delayMs, n.reason, n.status]), [
    [1, 5, 1000, 'server', 503],
    [2, 5, 2000, 'server', 503],
    [3, 5, 4000, 'server', 503],
  ]);
  assert.equal(resumed, 3, 'the line goes back to normal after every wait');
});

test('gives up after five retries and throws what the provider said', async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new ProviderError('Could not reach the model provider (Failed to fetch).', { kind: 'network' });
    }, { signal: new AbortController().signal, deps: clock.deps }),
    /Could not reach the model provider/,
  );
  assert.equal(calls, 6, 'one attempt and five retries');
  assert.deepEqual(clock.slept, [1000, 2000, 4000, 8000, 16_000]);
});

test('a failure that is not retryable is thrown at once, with no wait', async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw http(401);
  }, { signal: new AbortController().signal, deps: clock.deps }), /401/);
  assert.equal(calls, 1);
  assert.deepEqual(clock.slept, []);
});

test('Retry-After is honoured by the runner', async () => {
  const clock = fakeClock();
  let calls = 0;
  await withRetry(async () => {
    if (++calls === 1) throw http(429, 9000);
    return 1;
  }, { signal: new AbortController().signal, deps: clock.deps });
  assert.deepEqual(clock.slept, [9000]);
});

test('every failed attempt is reported, including the last, so partial output can be discarded', async () => {
  const clock = fakeClock();
  const failed: boolean[] = [];
  await assert.rejects(withRetry(async () => {
    throw streamIncomplete();
  }, { signal: new AbortController().signal, deps: clock.deps, policy: { ...DEFAULT_RETRY_POLICY, maxRetries: 2 }, onAttemptFailed: (_e, c) => failed.push(c.retryable) }));
  assert.deepEqual(failed, [true, true, true]);
});

test('Stop during a backoff sleep ends it immediately, with a REAL timer', async () => {
  const ac = new AbortController();
  let calls = 0;
  const started = Date.now();
  const p = withRetry(async () => {
    calls++;
    throw http(503);
  }, { signal: ac.signal, deps: { random: mid, isOnline: () => true }, policy: { ...DEFAULT_RETRY_POLICY, baseDelayMs: 30_000, maxDelayMs: 30_000 }, onRetry: () => setTimeout(() => ac.abort(), 5) });
  await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError');
  assert.equal(calls, 1, 'no further attempt after Stop');
  assert.ok(Date.now() - started < 2000, 'the 30s sleep did not run its course');
});

test('abortableSleep rejects at once on an already-aborted signal and cleans up after itself', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(abortableSleep(10_000, ac.signal), (e: unknown) => (e as Error).name === 'AbortError');
  await abortableSleep(1, new AbortController().signal);
});

test('an abort thrown by the request itself is never retried', async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw abort();
  }, { signal: new AbortController().signal, deps: clock.deps }), (e: unknown) => (e as Error).name === 'AbortError');
  assert.equal(calls, 1);
});

test('offline: waits for the connection instead of burning attempts', async () => {
  const clock = fakeClock();
  let online = false;
  const waits: number[] = [];
  const offline: number[] = [];
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    return 'ok';
  }, {
    signal: new AbortController().signal,
    deps: { ...clock.deps, isOnline: () => online, waitForOnline: async (cap) => { waits.push(cap); online = true; } },
    onOffline: (cap) => offline.push(cap),
  });
  assert.equal(out, 'ok');
  assert.equal(calls, 1, 'no attempt was spent while offline');
  assert.deepEqual(waits, [DEFAULT_RETRY_POLICY.offlineCapMs]);
  assert.deepEqual(offline, [DEFAULT_RETRY_POLICY.offlineCapMs]);
  assert.deepEqual(clock.slept, []);
});

test('Stop while waiting to come back online ends the wait', async () => {
  const ac = new AbortController();
  const p = withRetry(async () => 'never', {
    signal: ac.signal,
    deps: { isOnline: () => false, random: mid },
    policy: { ...DEFAULT_RETRY_POLICY, offlineCapMs: 60_000 },
    onOffline: () => setTimeout(() => ac.abort(), 5),
  });
  await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError');
});

// ---------------------------------------------------------------------------
// "It breaks in long sessions": the provider's window is smaller than the budget
// ---------------------------------------------------------------------------
//
// contextBudget defaults to 120,000 tokens for EVERY provider, and compaction first runs at 70% of
// it. A model with a 32k window therefore overflows long before anything shrinks the history, and
// the 400 that comes back is — correctly — not retryable as-is. isContextLengthError is what tells
// the loop that this particular 400 becomes retryable once the history is smaller.
//
// There is no status or code that means "too long" everywhere, so this reads the message. Every
// string below is one a real backend sends.

test('a context overflow is recognised from every phrasing a real backend sends', () => {
  const overflows = [
    // OpenAI and every OpenAI-compatible gateway that copies its wording.
    "400 Bad Request: {\"error\":{\"message\":\"This model's maximum context length is 8192 tokens. However, your messages resulted in 9101 tokens. Please reduce the length of the messages.\",\"code\":\"context_length_exceeded\"}}",
    // Azure OpenAI.
    '400 Bad Request: {"error":{"code":"context_length_exceeded","message":"maximum context length"}}',
    // Anthropic.
    '400 Bad Request: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}',
    // llama.cpp / LM Studio, which is exactly the local-model case the default budget breaks on.
    '400 Bad Request: the request exceeds the available context size, try increasing it',
    // Ollama.
    '400 Bad Request: {"error":"too many tokens for the context window"}',
    // vLLM and TGI.
    '400 Bad Request: This model\'s maximum context length is 4096 tokens. However, you requested 5000 tokens, which is longer than the maximum',
    '422 Unprocessable Entity: Input validation error: `inputs` must have less than 4096 tokens',
    // Gemini-compatible endpoints.
    '400 Bad Request: The input token count exceeds the maximum number of tokens allowed',
  ];
  for (const message of overflows) {
    assert.equal(isContextLengthError(new ProviderError(message, { kind: 'http', status: 400 })), true, message.slice(0, 60));
  }
});

test('failures that only LOOK like an overflow are not treated as one', () => {
  // Compacting in response to any of these would throw away the conversation for nothing.
  const notOverflows: Array<[string, number]> = [
    // A token rate limit. Mentions tokens, is a 429, already has its own handling.
    ['429 Too Many Requests: Rate limit reached for gpt-4 in organization org-x on tokens per minute (TPM)', 429],
    // A reply-length setting, not the conversation's size.
    ['400 Bad Request: max_tokens must be less than or equal to 4096', 400],
    ['400 Bad Request: max_completion_tokens is too large', 400],
    // The ordinary failures.
    ['401 Unauthorized: invalid api key', 401],
    ['404 Not Found: model "gpt-9" does not exist', 404],
    // A server falling over is never the request's own fault, whatever its body happens to say.
    ['503 Service Unavailable: upstream context window pool exhausted', 503],
    ['500 Internal Server Error: maximum context length', 500],
  ];
  for (const [message, status] of notOverflows) {
    assert.equal(isContextLengthError(new ProviderError(message, { kind: 'http', status })), false, message.slice(0, 60));
  }
});

test('an overflow is found through a wrapper error\'s cause chain', () => {
  // The Anthropic SDK and undici both wrap, putting their own words on top — the same reason
  // classifyError walks the chain for network failures.
  const inner = new Error('prompt is too long: 215000 tokens > 200000 maximum');
  const outer = new Error('Request failed', { cause: inner });
  assert.equal(isContextLengthError(outer), true);
});

test('an overflow stays out of the ordinary retry policy', () => {
  // It must NOT be retryable in the plain sense: sending the identical request again gets the
  // identical 400, five more times, with backoff between each. The loop handles it separately,
  // after compacting, which is a different request.
  const e = new ProviderError("400: This model's maximum context length is 8192 tokens", { kind: 'http', status: 400 });
  assert.equal(classifyError(e).retryable, false);
  assert.equal(isContextLengthError(e), true);
});

test('a plain network blip is not mistaken for an overflow', () => {
  assert.equal(isContextLengthError(new ProviderError('Failed to fetch', { kind: 'network' })), false);
  assert.equal(isContextLengthError(streamIncomplete()), false);
  assert.equal(isContextLengthError(abort()), false);
  assert.equal(isContextLengthError(null), false);
  assert.equal(isContextLengthError('a string'), false);
});
