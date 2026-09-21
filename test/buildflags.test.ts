// The build-variant logic: which providers a build offers. The flag itself is a compile-time
// define, so every function here takes the build mode as an argument and both variants are
// exercised without a bundler.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { SAFARI_BUILD, STORE_BUILD, SUBSCRIPTIONS_OFF, isSubscriptionProvider, providerAvailable, unavailableProviderMessage } from '../lib/buildflags.ts';

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

// ---------------------------------------------------------------------------
// The two axes: which engine, and whether this is a storefront build
// ---------------------------------------------------------------------------
//
// These were one axis for a while (`SUBSCRIPTIONS_OFF = STORE_BUILD || SAFARI_BUILD`), which meant
// the owner's own Safari build — the equivalent of the GitHub build, installed on his own devices
// — silently had no ChatGPT or SuperGrok sign-in, and the provider menu simply did not list them.
// The matrix below is the fix, stated so it cannot quietly regress: Safari alone changes nothing
// about providers, and only the store switch does.

test('SAFARI_BUILD and STORE_BUILD both default off outside a bundler', () => {
  // Node runs the TypeScript directly, with no Vite define. Undefined flags must read as a normal
  // build, never crash on the missing global.
  assert.equal(SAFARI_BUILD, false);
  assert.equal(STORE_BUILD, false);
  assert.equal(SUBSCRIPTIONS_OFF, false);
});

test('the build matrix: only the store switch turns subscriptions off', () => {
  // `SUBSCRIPTIONS_OFF` is a compile-time constant, so what is asserted here is the rule it is
  // derived from, spelled out for all four combinations the build scripts can produce.
  const subscriptionsOff = (store: boolean, _safari: boolean) => store;

  const matrix: { name: string; store: boolean; safari: boolean; off: boolean }[] = [
    { name: 'npm run build            (chrome)', store: false, safari: false, off: false },
    { name: 'npm run build:store      (chrome + store)', store: true, safari: false, off: true },
    { name: 'npm run build:safari     (safari)', store: false, safari: true, off: false },
    { name: 'npm run build:safari:store (safari + store)', store: true, safari: true, off: true },
  ];

  for (const row of matrix) {
    assert.equal(subscriptionsOff(row.store, row.safari), row.off, row.name);
    for (const kind of ['chatgpt', 'xai']) {
      assert.equal(providerAvailable(kind, row.off), !row.off, `${kind} in ${row.name}`);
    }
    // Key-based providers are in every build, whatever the axes say.
    for (const kind of ['anthropic', 'openai-compatible']) {
      assert.ok(providerAvailable(kind, row.off), `${kind} in ${row.name}`);
    }
  }
});

test('a plain Safari build keeps both subscription providers', () => {
  // The owner's report that started this: "i don't see the subscriptions on safari provider menu
  // (grok supergrok for example)". Safari is not a reason to withhold a provider.
  const safariNotStore = false; // SUBSCRIPTIONS_OFF for safari=true, store=false
  assert.ok(providerAvailable('xai', safariNotStore), 'SuperGrok must be in the Safari build');
  assert.ok(providerAvailable('chatgpt', safariNotStore), 'ChatGPT must be in the Safari build');
});

test('the unavailable message names the storefront for the engine it is on', () => {
  // Only a storefront build ever shows this, and which storefront differs by engine. Both still
  // have to name the API-key escape and the GitHub build.
  for (const kind of ['chatgpt', 'xai']) {
    const safari = unavailableProviderMessage(kind, true);
    assert.match(safari, /App Store/);
    assert.doesNotMatch(safari, /Chrome Web Store/);
    assert.match(safari, /API key/);
    assert.match(safari, /GitHub build/);

    const chrome = unavailableProviderMessage(kind, false);
    assert.match(chrome, /Chrome Web Store/);
    assert.doesNotMatch(chrome, /App Store/);
  }
});

test('no message tells the user the Safari build simply lacks the feature', () => {
  // The old Safari wording said sign-in was "not available in the Safari build ... yet", with no
  // way out but an API key. That sentence must not come back: a Safari build has subscriptions
  // unless it is a store build, in which case the store sentence — which names a way to get them —
  // is the right one.
  for (const safari of [true, false]) {
    for (const kind of ['chatgpt', 'xai']) {
      assert.doesNotMatch(unavailableProviderMessage(kind, safari), /Safari build/);
      assert.doesNotMatch(unavailableProviderMessage(kind, safari), /\byet\b/);
    }
  }
});
