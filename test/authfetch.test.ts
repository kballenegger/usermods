// Telling a Safari permission refusal apart from a broken network (lib/oauth.ts).
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
import { AUTH_HOSTS, fetchFailureMessage, isOpaqueFetchFailure } from '../lib/oauth.ts';

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
