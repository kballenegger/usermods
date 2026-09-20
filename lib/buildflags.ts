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
declare const __SAFARI_BUILD__: boolean | undefined;

/** True in a Chrome Web Store build. Constant-folded at build time. */
export const STORE_BUILD: boolean = typeof __STORE_BUILD__ === 'undefined' ? false : __STORE_BUILD__;

/**
 * True in a Safari build (`npm run build:safari`).
 *
 * The Safari build ships API-key providers only, for the same kind of reason the store build does
 * and a different one on top. The subscription sign-ins are device-code flows against endpoints the
 * vendors do not document, and neither flow has been exercised on Safari or on iOS. Shipping a
 * sign-in button that has never been run on the platform it is on would be a worse answer than
 * saying plainly that this build does not have it yet.
 */
export const SAFARI_BUILD: boolean = typeof __SAFARI_BUILD__ === 'undefined' ? false : __SAFARI_BUILD__;

/**
 * Whether subscription sign-in is off in this build, for either reason.
 *
 * Everything that means "this build has no subscriptions" reads this rather than STORE_BUILD, so a
 * third variant would not need every call site found again. STORE_BUILD stays for the two places
 * that mean the store specifically.
 */
export const SUBSCRIPTIONS_OFF: boolean = STORE_BUILD || SAFARI_BUILD;

// ---------- pure logic (tested in test/buildflags.test.ts) ----------

// Type-only, so this module stays importable by the node test runner, which resolves no
// extensionless relative specifiers.
import type { ProviderKind } from './types';

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
export function providerAvailable(kind: string, subscriptionsOff: boolean = SUBSCRIPTIONS_OFF): boolean {
  return !(subscriptionsOff && isSubscriptionProvider(kind));
}

/**
 * Why a provider is unavailable, phrased for the user. One message for every surface (the
 * provider factory, the oauth RPCs, Settings) so the explanation never depends on where you hit it.
 */
export function unavailableProviderMessage(kind: string, safariBuild: boolean = SAFARI_BUILD): string {
  const vendor = kind === 'chatgpt' ? 'ChatGPT' : kind === 'xai' ? 'SuperGrok / xAI' : kind;
  if (safariBuild) {
    return `${vendor} subscription sign-in is not available in the Safari build of usermods yet. Choose a provider with an API key in Settings.`;
  }
  return `${vendor} subscription sign-in is not available in the Chrome Web Store build of usermods. Choose a provider with an API key in Settings, or install the GitHub build, which includes it.`;
}

// A profile saved by a build that had subscriptions keeps its subscription connection when it is
// opened in a store build: nothing is rewritten. The connection simply reads as unavailable
// (connectionStatus in lib/connections.ts), is left out of the in-chat model picker, and Settings
// says why — so going back to the GitHub build finds everything as it was.
