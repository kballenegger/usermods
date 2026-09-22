// What a failed sign-in step tells the user (lib/oauth.ts). Two failures, two answers.
//
// The first half is the request that never left the browser: telling a Safari permission refusal
// apart from a broken network. The second half, further down, is the request that DID leave and
// came back with a status — where the server's own body said what was wrong and the user was shown
// a bare number instead.
//
// ---------------------------------------------------------------------------
// Telling a Safari permission refusal apart from a broken network
// ---------------------------------------------------------------------------
//
// Safari grants host access per site, and a newly installed extension has been granted nothing:
// `<all_urls>` in the manifest is a request, not a grant, the way it is on Chrome. A fetch to a
// host the user has not allowed does NOT fail with a status, a CORS message, or anything else that
// names the cause — it rejects with the same opaque TypeError a dead network gives. So the only
// honest thing the code can do is recognise that shape and name the check the user can actually
// make, which is what these pin.
//
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTH_HOSTS, authErrorDetail, authFailureMessage, fetchFailureMessage, isOpaqueFetchFailure, REGION_HINT } from '../lib/oauth.ts';

test('the opaque failures every engine throws are recognised', () => {
  // WebKit's wording, on the desktop and on iOS respectively, then Chromium's. All three are the
  // same event as far as the page is concerned: the request never left.
  for (const message of [
    'Load failed',
    'The Internet connection appears to be offline.',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource.',
  ]) {
    assert.ok(isOpaqueFetchFailure(new TypeError(message)), message);
  }
});

test('an abort is not a network failure', () => {
  // A cancelled sign-in must not be reported to the user as a permission problem.
  const abort = new Error('The operation was aborted.');
  abort.name = 'AbortError';
  assert.ok(!isOpaqueFetchFailure(abort));
});

test('an ordinary error is left alone', () => {
  assert.ok(!isOpaqueFetchFailure(new Error('xAI sign-in failed: 403')));
  assert.ok(!isOpaqueFetchFailure(new Error('ChatGPT token exchange failed: 400')));
  assert.ok(!isOpaqueFetchFailure('Load failed'), 'a bare string is not an Error');
  assert.ok(!isOpaqueFetchFailure(null));
});

test('the vendor hosts are the ones the flow actually reaches', () => {
  // Both the auth issuer and the backend the tokens are then used against: a user who allows only
  // the first gets a sign-in that works and a chat that does not.
  assert.deepEqual([...AUTH_HOSTS.chatgpt], ['auth.openai.com', 'chatgpt.com']);
  assert.deepEqual([...AUTH_HOSTS.xai], ['auth.x.ai', 'cli-chat-proxy.grok.com']);
});

test('on Safari the message names the host to allow and where to allow it', () => {
  // "Failed to fetch" sends someone to check their wifi for a permission problem. This is the
  // whole point of the classification: say what to press.
  for (const kind of ['chatgpt', 'xai'] as const) {
    const m = fetchFailureMessage(kind, true);
    for (const host of AUTH_HOSTS[kind]) assert.match(m, new RegExp(host.replace(/\./g, '\\.')), `${kind} names ${host}`);
    assert.match(m, /Allow on Every Website/, 'the exact setting, in the words Safari uses');
    // Both platforms, because the same build runs on all three devices and the panes are named
    // differently on each.
    assert.match(m, /Settings > Apps > Safari > Extensions/, 'the iPhone and iPad path');
    assert.match(m, /Safari > Settings > Extensions/, 'the Mac path');
    // And the network is still mentioned, because the platform genuinely does not say which it was.
    assert.match(m, /internet connection/i);
  }
});

test('on Chrome the host advice is left out', () => {
  // Chrome grants `<all_urls>` at install and gives the user no per-site control over it, so
  // telling them to go and allow a host would be advice they cannot follow.
  for (const kind of ['chatgpt', 'xai'] as const) {
    const m = fetchFailureMessage(kind, false);
    assert.match(m, /internet connection/i);
    assert.doesNotMatch(m, /Allow on Every Website/);
    assert.doesNotMatch(m, /Settings > Apps/);
  }
});

test('neither message is the raw platform string', () => {
  // The failure mode being fixed: the user seeing "Load failed" or "Failed to fetch" and having
  // nothing to act on.
  for (const safari of [true, false]) {
    for (const kind of ['chatgpt', 'xai'] as const) {
      const m = fetchFailureMessage(kind, safari);
      assert.doesNotMatch(m, /^Load failed/);
      assert.doesNotMatch(m, /Failed to fetch/);
      assert.ok(m.length > 40, 'a sentence, not a code');
    }
  }
});

// ---------------------------------------------------------------------------
// What the server said: the body of a failed sign-in step, turned into a sentence
// ---------------------------------------------------------------------------
//
// Every sign-in step used to surface a bare status — "ChatGPT device-code request failed: 403" —
// while the body of that 403 said exactly what had happened. The model-listing path already reads
// the body (lib/modellist.ts `errorDetail`); these pin the same job for the auth steps, plus the
// one piece of advice a 403 has earned: the owner hit a vendor edge refusing his region from Hong
// Kong and read it as a broken sign-in.

test('an OAuth error body is read, with the human sentence preferred over the machine code', () => {
  // RFC 6749 puts the sentence in error_description and a code like `invalid_grant` in `error`.
  assert.equal(authErrorDetail('{"error":"invalid_grant","error_description":"The device code has expired."}'), 'The device code has expired.');
  // OpenAI's and xAI's nested shape.
  assert.equal(authErrorDetail('{"error":{"message":"You are not allowed to use this client.","type":"invalid_request_error"}}'), 'You are not allowed to use this client.');
  // A bare message, and FastAPI's detail.
  assert.equal(authErrorDetail('{"message":"Rate limited."}'), 'Rate limited.');
  assert.equal(authErrorDetail('{"detail":"Missing client_version."}'), 'Missing client_version.');
  // Nothing better than the code? Then the code, which still beats a bare number.
  assert.equal(authErrorDetail('{"error":"access_denied"}'), 'access_denied');
});

test('a plain-text body is the server talking, so it is shown', () => {
  assert.equal(authErrorDetail('upstream connect error or disconnect/reset before headers'), 'upstream connect error or disconnect/reset before headers');
  // Whitespace is collapsed: a status line is one line.
  assert.equal(authErrorDetail('  too   many\n  requests \n'), 'too many requests');
});

test('an HTML block page is reduced to its one useful sentence, not poured into the UI', () => {
  // This is the Cloudflare / regional-block case, and the reason HTML is read here rather than
  // discarded the way a model listing discards it: the title is the most useful thing on screen.
  const cloudflare = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>
    <style>body{font-family:sans-serif}</style></head><body><h1>Sorry, you have been blocked</h1>
    <p>You are unable to access chatgpt.com</p><script>var a=1;</script></body></html>`;
  assert.equal(authErrorDetail(cloudflare), 'Attention Required! | Cloudflare');
  assert.doesNotMatch(authErrorDetail(cloudflare), /[<>]/, 'no markup ever reaches the UI');
  assert.doesNotMatch(authErrorDetail(cloudflare), /font-family|var a=1/, 'and no style or script text either');
  // No title: the first heading does the job.
  assert.equal(authErrorDetail('<html><body><h1>Error 1020 Access denied</h1></body></html>'), 'Error 1020 Access denied');
  assert.match(authErrorDetail('<html><body><h1>Access &amp; denied</h1></body></html>'), /Access & denied/, 'entities are decoded');
  // Nothing readable in the markup at all: better to say nothing than to show tags.
  assert.equal(authErrorDetail('<html><body><div><span></span></div></body></html>'), '');
});

test('an empty or unusable body yields nothing, and the caller falls back to the status', () => {
  assert.equal(authErrorDetail(''), '');
  assert.equal(authErrorDetail('   \n  '), '');
  assert.equal(authErrorDetail('{}'), '');
  assert.equal(authErrorDetail('{"error":{}}'), '');
  assert.equal(authErrorDetail(null as unknown as string), '');
});

test('an oversized body is capped, so one bad response cannot become the whole screen', () => {
  const long = authErrorDetail(JSON.stringify({ error_description: 'x'.repeat(5000) }));
  assert.ok(long.length <= 300, `capped at 300, got ${long.length}`);
  assert.match(long, /…$/, 'and it says it was cut');
  // A megabyte of HTML is capped by the same rule, after being reduced to a title.
  const huge = `<html><head><title>${'blocked '.repeat(2000)}</title></head><body>${'x'.repeat(100000)}</body></html>`;
  assert.ok(authErrorDetail(huge).length <= 300);
});

test('nothing that looks like a credential survives into the message', () => {
  // These bodies are failures and carry no tokens today. "Does not today" is not a property worth
  // relying on for a string that goes on screen and into a bug report.
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk';
  const withJwt = authErrorDetail(`{"error_description":"Bad token ${jwt}"}`);
  const withKey = authErrorDetail('{"error_description":"sent Bearer sk-proj-abcdef1234567890"}');
  assert.doesNotMatch(withJwt, /eyJ/);
  assert.doesNotMatch(withKey, /abcdef1234567890/);
  assert.doesNotMatch(authErrorDetail('{"error_description":"redirect to /cb?code=AUTHCODE1234567890abcdef"}'), /AUTHCODE1234567890/);
  assert.doesNotMatch(authErrorDetail('{"error_description":"device_code=DEV1234567890XYZ was rejected"}'), /DEV1234567890XYZ/);
  for (const m of [withJwt, withKey]) {
    assert.match(m, /redacted/, 'and it says something was removed rather than silently mangling the sentence');
  }
});

test('the failure line names the step, the status and what the server said', () => {
  assert.equal(authFailureMessage('ChatGPT sign-in', 400, '{"error":{"message":"client_version is required"}}'), 'ChatGPT sign-in failed (400): client_version is required');
  // A body with nothing in it still produces a sentence, not a bare number.
  assert.equal(authFailureMessage('xAI token refresh', 500, ''), 'xAI token refresh failed (500).');
  assert.match(authFailureMessage('SuperGrok sign-in', 401, '{}'), /^SuperGrok sign-in failed \(401\)\./);
});

test('a 403 says what it usually means, and what to try', () => {
  // The owner's actual failure, from Hong Kong: a vendor edge that does not serve the region,
  // reported as a bare "403" with nothing to act on.
  const m = authFailureMessage('ChatGPT sign-in', 403, '<html><head><title>Access denied</title></head></html>');
  assert.match(m, /Access denied/, 'the server is still quoted');
  assert.match(m, /region or network/i, 'and the likely cause is named');
  assert.match(m, /VPN|different network/i, 'with something to try');
  assert.match(m, /usually/i, 'hedged, because the code genuinely cannot tell which it was');
  assert.ok(m.endsWith(REGION_HINT), 'the advice comes after the server’s own words, not instead of them');
  // The advice rides on the 403 specifically, not on every failure.
  for (const status of [400, 401, 404, 429, 500]) {
    assert.doesNotMatch(authFailureMessage('ChatGPT sign-in', status, '{}'), /VPN/, `${status} must not suggest a VPN`);
  }
  // It is there whether or not the body said anything.
  assert.match(authFailureMessage('SuperGrok sign-in', 403, ''), /VPN/);
});

test('the 403 message is never the raw status alone', () => {
  const m = authFailureMessage('SuperGrok sign-in', 403, '');
  assert.ok(m.length > 60, 'a sentence someone can act on, not a code');
  assert.match(m, /403/, 'and the status is still there for a bug report');
});
