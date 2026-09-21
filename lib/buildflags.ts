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
 * True in a Safari build (`npm run build:safari`, `npm run build:safari:store`).
 *
 * This says WHICH BROWSER, and nothing about which providers. Safari's differences are real —
 * no `userScripts`, no sidebar, `localhost` is the phone, a background that is suspended
 * aggressively — and the code that works around each of those reads this flag. Subscription
 * sign-in is not one of them any more; see SUBSCRIPTIONS_OFF.
 */
export const SAFARI_BUILD: boolean = typeof __SAFARI_BUILD__ === 'undefined' ? false : __SAFARI_BUILD__;

/**
 * Whether subscription sign-in is off in this build.
 *
 * Exactly one thing turns it off: the store switch (`USERMODS_STORE=1`), which is set for a build
 * destined for a vendor's storefront — the Chrome Web Store today, the App Store if usermods is
 * ever submitted there. The reason is the listing, not the engine: signing in with a ChatGPT or
 * SuperGrok account uses endpoints the vendors do not document or licence for third parties, which
 * is a poor fit for a listing that has to state exactly what it talks to.
 *
 * It was briefly `STORE_BUILD || SAFARI_BUILD`, which conflated "this is a storefront build" with
 * "this is Safari" and left the owner's own Safari build — the equivalent of the GitHub build, the
 * one he installs on his own devices — without the subscription he actually uses. A Safari build
 * and a store build are two independent axes, so `USERMODS_STORE=1 wxt build -b safari` is the
 * combination that means "Safari, for the App Store", and it is the only Safari build without
 * subscriptions.
 *
 * Everything that means "this build has no subscriptions" reads this rather than STORE_BUILD, so a
 * further variant would not need every call site found again.
 */
export const SUBSCRIPTIONS_OFF: boolean = STORE_BUILD;

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
 *
 * Only a storefront build ever says this, so the sentence names the storefront the user would have
 * installed from — which differs by engine, and is the only thing SAFARI_BUILD decides here. Both
 * name the same two ways out: use an API key, or install the build from GitHub.
 */
export function unavailableProviderMessage(kind: string, safariBuild: boolean = SAFARI_BUILD): string {
  const vendor = kind === 'chatgpt' ? 'ChatGPT' : kind === 'xai' ? 'SuperGrok / xAI' : kind;
  const store = safariBuild ? 'App Store' : 'Chrome Web Store';
  return `${vendor} subscription sign-in is not available in the ${store} build of usermods. Choose a provider with an API key in Settings, or install the GitHub build, which includes it.`;
}

// A profile saved by a build that had subscriptions keeps its subscription connection when it is
// opened in a store build: nothing is rewritten. The connection simply reads as unavailable
// (connectionStatus in lib/connections.ts), is left out of the in-chat model picker, and Settings
// says why — so going back to the GitHub build finds everything as it was.
