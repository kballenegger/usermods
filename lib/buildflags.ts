// Compile-time build variants.
//
// The GitHub build is the full extension. The Chrome Web Store build ("npm run build:store") is the
// same extension since 0.1.2, subscription sign-in included. The one build without subscriptions is
// the App Store variant of Safari ("npm run build:safari:store"), which nothing ships today.
//
// The flag is a Vite `define`, so `__STORE_BUILD__` is substituted literally and the dead branch
// (including the dynamic import of lib/oauth) is dropped by the bundler. Nothing reads an env var
// at runtime.

declare const __STORE_BUILD__: boolean | undefined;
declare const __SAFARI_BUILD__: boolean | undefined;
declare const __ACT__: boolean | undefined;

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
 * Only the App Store variant of Safari turns it off. The Chrome Web Store build had it off until
 * 0.1.2, because signing in with a ChatGPT or SuperGrok account uses endpoints the vendors do not
 * document or licence for third parties. The owner chose to submit it with the sign-in and see
 * whether it is approved. If it is not, `STORE_BUILD` alone here puts the old rule back.
 *
 * It was briefly `STORE_BUILD || SAFARI_BUILD`, which conflated "this is a storefront build" with
 * "this is Safari" and left the owner's own Safari build — the equivalent of the GitHub build, the
 * one he installs on his own devices — without the subscription he actually uses.
 *
 * Everything that means "this build has no subscriptions" reads this rather than STORE_BUILD, so a
 * further variant would not need every call site found again.
 */
export const SUBSCRIPTIONS_OFF: boolean = STORE_BUILD && SAFARI_BUILD;

/**
 * Whether operating pages (the act tool, the allow questions, the driving bar) is left out of this
 * build. See docs/specs/browser-use.md, section 5.9.
 *
 * Acting is true only in a build that is neither a storefront build nor a Safari build: a store
 * has not tested the single-purpose claim, and Safari has its own phase, because its model scripts
 * share the content script's world. So unlike SUBSCRIPTIONS_OFF this reads both axes, through
 * actEnabled below, which wxt.config.ts calls to set the define.
 *
 * It removes the code and not only the controls: everything behind it is reached through
 * `if (!ACT_OFF)` so the bundler drops it, and a flag-off package holds no dormant agent.
 */
export const ACT_OFF: boolean = typeof __ACT__ === 'undefined' ? false : !__ACT__;

/** The rule behind __ACT__, for both axes: on only when the build is neither store nor Safari. */
export function actEnabled(store: boolean, safari: boolean): boolean {
  return !store && !safari;
}

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
