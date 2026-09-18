// Compile-time build variants.
//
// The GitHub build is the full extension. The Chrome Web Store build ("npm run build:store")
// omits the two subscription providers — signing in with a ChatGPT or SuperGrok account uses
// endpoints the vendors do not document or licence for third parties, which is a poor fit for a
// listing that has to state exactly what it talks to. Everything else is identical.
//
// The flag is a Vite `define`, so `__STORE_BUILD__` is substituted literally and the dead branch
// (including the dynamic import of lib/oauth) is dropped by the bundler. Nothing reads an env var
// at runtime.

declare const __STORE_BUILD__: boolean | undefined;

/** True in a Chrome Web Store build. Constant-folded at build time. */
export const STORE_BUILD: boolean = typeof __STORE_BUILD__ === 'undefined' ? false : __STORE_BUILD__;

// ---------- pure logic (tested in test/buildflags.test.ts) ----------

// Type-only, so this module stays importable by the node test runner, which resolves no
// extensionless relative specifiers. The one value it would need is spelled out below.
import type { ProviderKind, Settings } from './types';

// The subscription backends' default endpoints. They live here rather than in lib/oauth so that
// callers can name a default base URL without importing the auth module, which must stay out of
// the store bundle. They are plain endpoint strings; the credentials to reach them are in oauth.
export const CHATGPT_CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
export const XAI_PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1';

/** Provider kinds that sign in with a subscription instead of an API key. */
export const SUBSCRIPTION_PROVIDERS: readonly ProviderKind[] = ['chatgpt', 'xai'];

export function isSubscriptionProvider(kind: string): kind is 'chatgpt' | 'xai' {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(kind);
}

/** Whether a provider kind can be used in this build. */
export function providerAvailable(kind: string, storeBuild: boolean = STORE_BUILD): boolean {
  return !(storeBuild && isSubscriptionProvider(kind));
}

/**
 * Why a provider is unavailable, phrased for the user. One message for every surface (the
 * provider factory, the oauth RPCs, Settings) so the explanation never depends on where you hit it.
 */
export function unavailableProviderMessage(kind: string): string {
  const vendor = kind === 'chatgpt' ? 'ChatGPT' : kind === 'xai' ? 'SuperGrok / xAI' : kind;
  return `${vendor} subscription sign-in is not available in the Chrome Web Store build of usermods. Choose a provider with an API key in Settings, or install the GitHub build, which includes it.`;
}

/**
 * The settings a store build should show for a profile saved by a build that had subscriptions.
 * Upgrading must not strand the user on a provider this build cannot talk to, so the provider
 * falls back to the default and the key/model fields are cleared of the subscription's values —
 * a subscription profile has no API key and often a vendor-only model id.
 *
 * Returns null when the stored settings are already usable, so callers can leave them untouched.
 */
export function migrateSettingsForBuild(s: Settings, storeBuild: boolean = STORE_BUILD): Settings | null {
  if (providerAvailable(s.provider, storeBuild)) return null;
  return { ...s, ...FALLBACK_PROVIDER, baseUrl: '', apiKey: '' };
}

/**
 * Where a dropped provider lands. Kept in step with DEFAULT_SETTINGS in ./types, which cannot be
 * imported for a value here without breaking the node test runner; the test asserts they agree.
 */
export const FALLBACK_PROVIDER: { provider: ProviderKind; model: string } = {
  provider: 'anthropic',
  model: 'claude-opus-5',
};
