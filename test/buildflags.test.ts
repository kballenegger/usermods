// The build-variant logic: which providers a build offers, and what happens to a profile saved by
// a build that offered more. The flag itself is a compile-time define, so every function here takes
// the build mode as an argument and both variants are exercised without a bundler.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FALLBACK_PROVIDER,
  STORE_BUILD,
  isSubscriptionProvider,
  migrateSettingsForBuild,
  providerAvailable,
  unavailableProviderMessage,
} from '../lib/buildflags.ts';
import { DEFAULT_SETTINGS, type Settings } from '../lib/types.ts';

test('the migration fallback stays in step with DEFAULT_SETTINGS', () => {
  // buildflags cannot import DEFAULT_SETTINGS for a value (the node runner resolves no
  // extensionless specifiers), so it restates the fallback. This is the guard against drift.
  assert.equal(FALLBACK_PROVIDER.provider, DEFAULT_SETTINGS.provider);
  assert.equal(FALLBACK_PROVIDER.model, DEFAULT_SETTINGS.model);
});

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

// ---------- upgrading into a store build ----------

const chatgptProfile: Settings = { provider: 'chatgpt', baseUrl: '', apiKey: '', model: 'gpt-5-codex' };

test('a stored subscription profile is migrated to a usable provider in a store build', () => {
  const migrated = migrateSettingsForBuild(chatgptProfile, true);
  assert.ok(migrated, 'a subscription profile must be migrated');
  assert.equal(migrated.provider, DEFAULT_SETTINGS.provider);
  assert.ok(providerAvailable(migrated.provider, true), 'the result must be a provider this build can create');
  // The vendor-only model id and base URL would be nonsense against the new provider.
  assert.equal(migrated.model, DEFAULT_SETTINGS.model);
  assert.equal(migrated.baseUrl, '');
  assert.equal(migrated.apiKey, '');
});

test('migration is a no-op for a profile the build can already use', () => {
  const keyed: Settings = { provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', apiKey: 'sk-local', model: 'qwen' };
  assert.equal(migrateSettingsForBuild(keyed, true), null);
  assert.equal(migrateSettingsForBuild(keyed, false), null);
});

test('a default build leaves a subscription profile exactly as it was', () => {
  assert.equal(migrateSettingsForBuild(chatgptProfile, false), null);
  assert.equal(migrateSettingsForBuild({ ...chatgptProfile, provider: 'xai' }, false), null);
});

test('migration does not mutate the settings it was given', () => {
  const before = { ...chatgptProfile };
  migrateSettingsForBuild(chatgptProfile, true);
  assert.deepEqual(chatgptProfile, before);
});
