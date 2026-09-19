// The build-variant logic: which providers a build offers. The flag itself is a compile-time
// define, so every function here takes the build mode as an argument and both variants are
// exercised without a bundler.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { STORE_BUILD, isSubscriptionProvider, providerAvailable, unavailableProviderMessage } from '../lib/buildflags.ts';

// What a store build does with a subscription connection saved by the GitHub build — keeps it,
// marks it unavailable, leaves it out of the picker — is tested with the rest of the connection
// rules in test/connections.test.ts.

test('the flag defaults to off where __STORE_BUILD__ was never defined', () => {
  // Node runs the TypeScript directly, with no Vite define. An undefined flag must read as a
  // normal build, never crash on the missing global.
  assert.equal(STORE_BUILD, false);
});

test('the subscription providers are exactly chatgpt and xai', () => {
  assert.ok(isSubscriptionProvider('chatgpt'));
  assert.ok(isSubscriptionProvider('xai'));
  assert.ok(!isSubscriptionProvider('anthropic'));
  assert.ok(!isSubscriptionProvider('openai-compatible'));
});

test('a store build offers the key-based providers and withholds the subscriptions', () => {
  for (const kind of ['anthropic', 'openai-compatible']) {
    assert.ok(providerAvailable(kind, true), `${kind} must survive the store build`);
    assert.ok(providerAvailable(kind, false));
  }
  for (const kind of ['chatgpt', 'xai']) {
    assert.ok(!providerAvailable(kind, true), `${kind} must be absent from the store build`);
    assert.ok(providerAvailable(kind, false), `${kind} must remain in the default build`);
  }
});

test('the unavailable message names the vendor and both ways out', () => {
  for (const [kind, vendor] of [['chatgpt', 'ChatGPT'], ['xai', 'SuperGrok']] as const) {
    const m = unavailableProviderMessage(kind);
    assert.match(m, new RegExp(vendor));
    assert.match(m, /Chrome Web Store/);
    // The user must learn both escapes: use an API key here, or get the other build.
    assert.match(m, /API key/);
    assert.match(m, /GitHub build/);
  }
});
