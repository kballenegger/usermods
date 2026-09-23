// Subscription sign-in for ChatGPT (Sign in with ChatGPT) and xAI (SuperGrok / X Premium+).
// Both use the OAuth device-code grant, so no redirect URL and no local server are needed:
// the user opens a page, types a short code, and we poll for the token.
//
// Wire details come from the vendors' own CLIs (openai/codex and xAI's grok CLI), as reused by
// several open-source agents. Neither vendor publishes docs for this; see docs/guide.md.
//
// ---------------------------------------------------------------------------
// Shape: start, then single steps. Not a loop.
// ---------------------------------------------------------------------------
//
// `startXaiLogin` / `startChatgptLogin` return the device code and what the user needs to see; the
// caller writes that to storage (lib/pendinglogin.ts) and then calls `pollOnce` whenever it decides
// a poll is due. There is deliberately no `poll(signal)` that loops internally any more.
//
// The loop version could not survive Safari. It held the device code in a closure and slept inside
// an `await`, so the whole flow existed only as long as that promise chain and the worker under it.
// Safari's background is an event page the system suspends aggressively — on iOS, within seconds of
// the popup closing, which is exactly when the user switches to the verification tab. The suspend
// took the closure, the timer and the only copy of the device code with it, and the sign-in could
// not be resumed, only restarted with a code that no longer matched the page the user was on.
//
// A single step that takes its state as an argument is resumable by anything that can read storage:
// the background when it wakes, the popup when it reopens, either after the other died.

// .ts on the value import, and a type-only import below: the permission-error classification in
// this module is unit tested under node --experimental-strip-types, whose resolver does not guess
// extensions. Importing lib/oauth from node also has to stay free of top-level side effects, which
// it is — everything here is a function or a const string.
import { SAFARI_BUILD } from './buildflags.ts';
import type { PendingLogin, PollOutcome } from './pendinglogin';

export type OAuthKind = 'chatgpt' | 'xai';

export interface OAuthTokens {
  access: string;
  refresh: string;
  /** Epoch ms. */
  expiresAt: number;
  /** ChatGPT only: account id from the access token, sent as a header. */
  accountId?: string;
  /** Best-effort display label (email or plan). */
  label?: string;
}

/** What a vendor's device-code call returned, in the shape lib/pendinglogin.ts stores. */
export interface DeviceLogin {
  /** `device_code` (xAI) / `device_auth_id` (ChatGPT). */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  expiresAt: number;
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;

// ---------- Safari: telling a blocked host apart from a broken network ----------

/**
 * The hosts this flow talks to, and what a user would have to allow for each.
 *
 * Safari grants host access per site, and its default for a newly installed extension is "Ask" —
 * nothing is allowed until the user says so, per host, from the toolbar or from
 * Safari > Settings > Extensions. usermods asks for `<all_urls>`, which on Chrome means it has
 * every host the moment it is installed, and on Safari means it may have NONE of them.
 *
 * A fetch to a host the extension has not been granted does not fail with a status or a CORS
 * message. It rejects with the same opaque `TypeError: Load failed` / `Failed to fetch` that a
 * dead network gives, which sends the user to check their wifi for a permission problem. These
 * are the hosts to name in that case.
 */
export const AUTH_HOSTS: Readonly<Record<OAuthKind, readonly string[]>> = {
  chatgpt: ['auth.openai.com', 'chatgpt.com'],
  xai: ['auth.x.ai', 'cli-chat-proxy.grok.com'],
};

/**
 * Whether a thrown value is the opaque "the request never left" failure.
 *
 * WebKit words it `Load failed` or `The Internet connection appears to be offline.`; Chromium says
 * `Failed to fetch`. None of them carry a status, a response, or any hint of which of the two very
 * different causes it was — no network, or no permission for this host.
 */
export function isOpaqueFetchFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError') return false;
  return /load failed|failed to fetch|networkerror|connection appears to be offline/i.test(e.message);
}

/**
 * The sentence to show when a request to a vendor host never left the browser.
 *
 * It has to cover both causes without asserting either, because the platform genuinely does not
 * say which it was — so it names the check the user can actually make (is this host allowed?) and
 * where to make it, and mentions the network second. On Chrome, where `<all_urls>` is granted at
 * install and per-site permission is not a thing the user manages, the host advice would be noise,
 * so the message is the plain network one.
 */
export function fetchFailureMessage(kind: OAuthKind, safari: boolean): string {
  const hosts = AUTH_HOSTS[kind].join(' and ');
  if (!safari) return `Could not reach ${hosts}. Check your internet connection and try again.`;
  return (
    `Could not reach ${hosts}. Safari asks per website, so this usually means usermods is not allowed on ` +
    `${AUTH_HOSTS[kind][0]} yet. Open Safari's settings for usermods and set it to Allow on Every Website ` +
    `(iPhone and iPad: Settings > Apps > Safari > Extensions > usermods; Mac: Safari > Settings > Extensions > ` +
    `usermods > Edit Websites). If it is already allowed, check your internet connection.`
  );
}

// ---------- what the server actually said ----------

/**
 * How much of a server's explanation is worth putting in a status line.
 *
 * The same cap lib/modellist.ts uses, for the same reason: past a sentence or two it stops being an
 * explanation and starts being a wall, and a vendor edge that answers with a whole HTML page would
 * otherwise pour it into the UI.
 */
const MAX_DETAIL = 300;

/**
 * A short sentence out of an HTML error page.
 *
 * Cloudflare, regional blocks and vendor edges answer with a document, not JSON, and the one useful
 * sentence in it is the `<title>` ("Access denied", "Attention Required! | Cloudflare", "Error
 * 1020") or the first heading. Everything else is markup, script and boilerplate. Tags are stripped
 * rather than parsed: this runs in a service worker where DOMParser is not available, and a regex
 * that only ever DELETES markup cannot be tricked into producing markup.
 */
function htmlDetail(text: string): string {
  const pick = (re: RegExp): string => {
    const m = re.exec(text);
    if (!m?.[1]) return '';
    return m[1]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  };
  return pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || pick(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
}

/**
 * What the server said about a failed sign-in step, from its response body.
 *
 * The sign-in flow used to surface a bare status — "ChatGPT device-code request failed: 403" — while
 * the body of that 403 said exactly what had happened. The model-listing path already reads the body
 * (lib/modellist.ts `errorDetail`); this is the same job for the auth steps, with two differences
 * that matter here and not there:
 *
 *   - **HTML is read rather than discarded.** A model listing that answers HTML is a misconfigured
 *     base URL and the page says nothing useful. A SIGN-IN that answers HTML is usually an edge —
 *     Cloudflare, a regional block — and its title is the single most useful thing on screen.
 *   - **`error_description` comes first.** These are OAuth endpoints, and RFC 6749 puts the human
 *     sentence there; `error` beside it is a machine code like `invalid_grant`.
 *
 * Every shape either vendor has been seen to answer with is read: OAuth's
 * `{error_description}` / `{error}`, OpenAI's and xAI's `{error:{message}}`, a bare `{message}` or
 * `{detail}`, plain text, and an HTML page reduced to its title. A body that is none of those, or
 * empty, yields '' and the caller falls back to naming the status alone.
 *
 * It never returns anything that was not in the body, so it cannot invent a cause — and the bodies
 * it reads are error responses, which carry no token: the flows that DO return tokens are the ones
 * that succeeded, and this is only ever called on a failure. See `redactDetail`.
 */
export function authErrorDetail(bodyText: string): string {
  const text = (bodyText ?? '').trim();
  if (!text) return '';
  let detail = '';
  const looksHtml = /^\s*(<!doctype|<html|<head|<body|<\?xml)/i.test(text) || /<html[\s>]/i.test(text.slice(0, 2000));
  if (looksHtml) {
    detail = htmlDetail(text);
  } else {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
      const err = j.error;
      const nested = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
      detail =
        str(j.error_description) ||
        (nested ? str(nested.message) || str(nested.error_description) : '') ||
        str(j.message) ||
        str(j.detail) ||
        // The machine code last: `invalid_grant` alone is thin, but it beats a bare number.
        (nested ? str(nested.code) || str(nested.type) : str(err));
    } catch {
      // Not JSON. Plain text is the server talking, so it is shown — unless it is markup we did not
      // recognise above, which is noise.
      detail = /^\s*</.test(text) ? htmlDetail(text) : text;
    }
  }
  return redactDetail(detail);
}

/**
 * Tidy a detail for display, and make sure nothing secret rides along in it.
 *
 * The bodies this reads are failures, which do not carry tokens — but "does not today" is not a
 * property worth relying on for a string that goes on screen and into a bug report. Anything
 * shaped like a bearer token, a JWT, an OAuth code or a `?code=`/`token=` query value is replaced
 * before the string is capped, so a vendor that ever does echo one back cannot leak it through this
 * path. The device code and user code are not in these bodies at all (they are in the REQUEST), and
 * nothing here reads a request.
 */
function redactDetail(raw: string): string {
  let detail = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!detail) return '';
  detail = detail
    // A JWT: three base64url segments. This is what an access or id token looks like.
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    // `Bearer <something>`, and the vendors' key prefixes.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(sk|xai|oai)-[A-Za-z0-9._-]{8,}/gi, '[redacted]')
    // `code=…`, `token=…`, `device_code=…` in a URL or a form body echoed back at us.
    .replace(/\b((?:access_|refresh_|id_|device_|user_)?(?:code|token))=[^\s&"']{6,}/gi, '$1=[redacted]');
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail;
}

/**
 * The extra sentence a 403 from a vendor's edge has earned.
 *
 * A 403 on a sign-in step is almost never "you are not allowed to sign in" — the user has not
 * identified themselves yet, so there is nobody to deny. It is the vendor's edge refusing the
 * request before it reaches the API at all, and by far the most common reason is where the request
 * came from: OpenAI and xAI do not serve every country, and a corporate or campus network can be
 * refused the same way. The owner hit exactly this from Hong Kong and read it as a broken sign-in.
 *
 * So a 403 says what it usually means and what to try, and is careful to say "usually": the code
 * cannot tell a regional block from a blocked network from a genuinely refused client, and claiming
 * certainty would send someone to a VPN over a problem a VPN will not fix.
 *
 * ChatGPT's device-auth POLL is the one place a 403 means something else — OpenAI answers "not
 * approved yet" with it — and that path returns `pending` before it ever reaches here.
 */
export const REGION_HINT =
  'A 403 here usually means the provider is not serving your region or network rather than a problem with your account. Try a VPN or a different network.';

/**
 * The one-line failure a sign-in step shows: what we were doing, the status, what the server said,
 * and — on a 403 — what that usually means.
 *
 * `step` is the human name of the request ("ChatGPT sign-in", "xAI token refresh"), so the sentence
 * says which part of a multi-request flow gave up.
 */
export function authFailureMessage(step: string, status: number, bodyText: string): string {
  const detail = authErrorDetail(bodyText);
  const head = detail ? `${step} failed (${status}): ${detail}` : `${step} failed (${status}).`;
  return status === 403 ? `${head} ${REGION_HINT}` : head;
}

/**
 * Read a failed response's body once, without letting that read become the failure.
 *
 * A body can only be consumed once and `text()` can itself reject (a connection that died after the
 * headers). Either way the caller still has a status to report, so this answers '' rather than
 * throwing a second, less useful error over the first.
 */
export async function failureBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// ---------- storage ----------

const key = (k: OAuthKind) => `oauth:${k}`;

export async function loadTokens(kind: OAuthKind): Promise<OAuthTokens | null> {
  const r = await chrome.storage.local.get(key(kind));
  return (r[key(kind)] as OAuthTokens | undefined) ?? null;
}

export async function saveTokens(kind: OAuthKind, t: OAuthTokens | null): Promise<void> {
  if (t) await chrome.storage.local.set({ [key(kind)]: t });
  else await chrome.storage.local.remove(key(kind));
}

/** Returns a non-expired access token, refreshing if needed. Throws if signed out. */
export async function getValidTokens(kind: OAuthKind): Promise<OAuthTokens> {
  const t = await loadTokens(kind);
  if (!t) throw new Error(`Not signed in to ${kind === 'chatgpt' ? 'ChatGPT' : 'xAI'}. Sign in from Settings.`);
  if (Date.now() < t.expiresAt - REFRESH_SKEW_MS) return t;
  const fresh = kind === 'chatgpt' ? await refreshChatgpt(t) : await refreshXai(t);
  await saveTokens(kind, fresh);
  return fresh;
}

// ---------- helpers ----------

function jwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function expiresFrom(expiresIn: unknown, access: string): number {
  const n = Number(expiresIn);
  if (Number.isFinite(n) && n > 0) return Date.now() + n * 1000;
  const exp = Number(jwtPayload(access).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : Date.now() + 3600 * 1000;
}

/**
 * `fetch`, with the opaque failure turned into a sentence that names the likely cause.
 *
 * Every request in this file goes through it, so a host Safari has not granted is reported as a
 * permission to fix rather than as a network to blame, wherever in the flow it is hit.
 */
async function authFetch(kind: OAuthKind, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (isOpaqueFetchFailure(e)) throw new Error(fetchFailureMessage(kind, SAFARI_BUILD));
    throw e;
  }
}

// =====================================================================
// xAI (SuperGrok / X Premium+)
// =====================================================================

const XAI_ISSUER = 'https://auth.x.ai';
/** xAI's public OAuth client for coding agents (no secret; PKCE / device code only). */
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write';
/** The proxy admits a set of client versions; this label must stay within it. */
export const XAI_CLIENT_VERSION = '0.2.101';
export const XAI_PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1';

const xaiAuthHeaders = {
  'content-type': 'application/x-www-form-urlencoded',
  'x-grok-client-version': XAI_CLIENT_VERSION,
  'x-grok-client-surface': 'cli',
};

export async function startXaiLogin(): Promise<DeviceLogin> {
  const res = await authFetch('xai', `${XAI_ISSUER}/oauth2/device/code`, {
    method: 'POST',
    headers: xaiAuthHeaders,
    body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: 'usermods' }),
  });
  if (!res.ok) throw new Error(authFailureMessage('SuperGrok sign-in', res.status, await failureBody(res)));
  const d = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  };
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri_complete ?? d.verification_uri,
    intervalSec: Math.max(1, d.interval ?? 5),
    expiresAt: Date.now() + Math.max(d.expires_in, 60) * 1000,
  };
}

/** One poll of xAI's token endpoint for a stored device code. Never sleeps, never loops. */
async function pollXaiOnce(p: PendingLogin): Promise<PollOutcome> {
  let r: Response;
  try {
    r = await authFetch('xai', `${XAI_ISSUER}/oauth2/token`, {
      method: 'POST',
      headers: xaiAuthHeaders,
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: p.deviceCode,
        client_id: XAI_CLIENT_ID,
      }),
    });
  } catch (e) {
    // A failed poll is not a failed sign-in. The code is still live on the vendor's page and the
    // user is still looking at it, so this keeps the flow and tries again at the next tick. Only
    // an answer from the vendor, or the expiry, ends it.
    return { kind: 'retry', message: e instanceof Error ? e.message : String(e) };
  }
  if (r.ok) {
    try {
      return { kind: 'success', tokens: xaiTokensFrom((await r.json()) as Record<string, unknown>) };
    } catch (e) {
      return { kind: 'fatal', message: e instanceof Error ? e.message : String(e) };
    }
  }
  // Read the body ONCE, as text, and parse it here: the RFC error code steers the flow, and the
  // same bytes are what `authFailureMessage` turns into a sentence when the code is not one we
  // know. Reading it twice is not possible, and reading only the JSON threw away the case where the
  // body is an edge's HTML page rather than an OAuth error at all.
  const body = await failureBody(r);
  let code = '';
  try {
    code = String((JSON.parse(body) as { error?: unknown }).error ?? '');
  } catch {
    /* not JSON: an edge page or plain text. authFailureMessage reads it below. */
  }
  switch (code) {
    case 'authorization_pending':
      return { kind: 'pending' };
    case 'slow_down':
      return { kind: 'slow_down' };
    case 'access_denied':
      return { kind: 'denied', message: 'The SuperGrok sign-in was declined on the xAI page.' };
    case 'expired_token':
      return { kind: 'expired' };
    default:
      // A 5xx is the vendor having a bad minute, not a decision about this sign-in.
      if (r.status >= 500) return { kind: 'retry', message: `xAI answered ${r.status}.` };
      return { kind: 'fatal', message: authFailureMessage('SuperGrok sign-in', r.status, body) };
  }
}

function xaiTokensFrom(p: Record<string, unknown>): OAuthTokens {
  const access = String(p.access_token ?? '');
  const refresh = String(p.refresh_token ?? '');
  if (!access || !refresh) throw new Error('xAI sign-in did not return tokens.');
  const id = typeof p.id_token === 'string' ? jwtPayload(p.id_token) : {};
  return { access, refresh, expiresAt: expiresFrom(p.expires_in, access), label: typeof id.email === 'string' ? id.email : undefined };
}

async function refreshXai(t: OAuthTokens): Promise<OAuthTokens> {
  const r = await authFetch('xai', `${XAI_ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: XAI_CLIENT_ID, refresh_token: t.refresh }),
  });
  if (!r.ok) {
    const body = await failureBody(r);
    let code = '';
    try {
      code = String((JSON.parse(body) as { error?: unknown }).error ?? '');
    } catch {
      /* see pollXaiOnce: the body may be an edge page rather than an OAuth error. */
    }
    if (code === 'invalid_grant' || code === 'invalid_client') {
      await saveTokens('xai', null);
      throw new Error('Your xAI session expired. Sign in again from Settings.');
    }
    throw new Error(authFailureMessage('xAI token refresh', r.status, body));
  }
  const p = (await r.json()) as Record<string, unknown>;
  const next = xaiTokensFrom({ ...p, refresh_token: p.refresh_token ?? t.refresh });
  return { ...next, label: next.label ?? t.label };
}

/** Headers the xAI CLI proxy expects on inference requests. */
export function xaiProxyHeaders(model: string, access: string): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    'x-grok-client-identifier': 'usermods',
    'x-grok-client-version': XAI_CLIENT_VERSION,
    'x-grok-client-mode': 'interactive',
    // Marks an OAuth (subscription) session for the proxy's auth middleware.
    'x-xai-token-auth': 'xai-grok-cli',
    'x-authenticateresponse': 'authenticate-response',
    'x-grok-model-override': model,
  };
}

// =====================================================================
// ChatGPT (Sign in with ChatGPT)
// =====================================================================

const OAI_ISSUER = 'https://auth.openai.com';
/** The public "Sign in with ChatGPT" client, shared by every third-party harness. */
const OAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_CODEX_BASE = 'https://chatgpt.com/backend-api/codex';

export async function startChatgptLogin(): Promise<DeviceLogin> {
  const res = await authFetch('chatgpt', `${OAI_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: OAI_CLIENT_ID }),
  });
  if (!res.ok) throw new Error(authFailureMessage('ChatGPT sign-in', res.status, await failureBody(res)));
  const d = (await res.json()) as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string | number };
  return {
    deviceCode: d.device_auth_id,
    userCode: d.user_code ?? d.usercode ?? '',
    verificationUri: `${OAI_ISSUER}/codex/device`,
    intervalSec: Math.max(1, Number(d.interval) || 5),
    // OpenAI's usercode call does not say; 15 minutes is what the Codex CLI assumes.
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
}

/** One poll of ChatGPT's device-auth endpoint, then the code exchange when it is approved. */
async function pollChatgptOnce(p: PendingLogin): Promise<PollOutcome> {
  let r: Response;
  try {
    r = await authFetch('chatgpt', `${OAI_ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_auth_id: p.deviceCode, user_code: p.userCode }),
    });
  } catch (e) {
    return { kind: 'retry', message: e instanceof Error ? e.message : String(e) };
  }
  // OpenAI answers "not approved yet" with a status rather than an RFC error body. This is the one
  // place a 403 is NOT the regional refusal REGION_HINT describes, which is why it returns here,
  // before authFailureMessage can offer that advice over an ordinary "keep waiting".
  if (r.status === 403 || r.status === 404) return { kind: 'pending' };
  if (r.status === 429) return { kind: 'slow_down' };
  if (r.status >= 500) return { kind: 'retry', message: `ChatGPT answered ${r.status}.` };
  if (!r.ok) return { kind: 'fatal', message: authFailureMessage('ChatGPT sign-in', r.status, await failureBody(r)) };
  try {
    const code = (await r.json()) as { authorization_code: string; code_verifier: string };
    return { kind: 'success', tokens: await exchangeChatgptCode(code.authorization_code, code.code_verifier) };
  } catch (e) {
    return { kind: 'fatal', message: e instanceof Error ? e.message : String(e) };
  }
}

// =====================================================================
// The one entry point the background polls through
// =====================================================================

/**
 * Poll the vendor once for a pending sign-in, and report what happened.
 *
 * The caller decides WHEN (lib/pendinglogin.ts `shouldPoll`) and what to do with the answer
 * (`applyOutcome`); this only knows how to ask each vendor. Expiry is checked here as well as by
 * the caller, because the record may have been sitting in storage across a long suspend and
 * spending a request to be told what the clock already knows is pointless.
 */
export async function pollOnce(p: PendingLogin): Promise<PollOutcome> {
  if (Date.now() >= p.expiresAt) return { kind: 'expired' };
  return p.kind === 'chatgpt' ? pollChatgptOnce(p) : pollXaiOnce(p);
}

async function exchangeChatgptCode(code: string, verifier: string): Promise<OAuthTokens> {
  const r = await authFetch('chatgpt', `${OAI_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${OAI_ISSUER}/deviceauth/callback`,
      client_id: OAI_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!r.ok) throw new Error(authFailureMessage('ChatGPT token exchange', r.status, await failureBody(r)));
  return chatgptTokensFrom((await r.json()) as Record<string, unknown>);
}

function chatgptTokensFrom(p: Record<string, unknown>, prev?: OAuthTokens): OAuthTokens {
  const access = String(p.access_token ?? '');
  const refresh = String(p.refresh_token ?? prev?.refresh ?? '');
  if (!access || !refresh) throw new Error('ChatGPT sign-in did not return tokens.');
  const claims = jwtPayload(access);
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as { chatgpt_account_id?: string; chatgpt_plan_type?: string };
  const profile = (claims['https://api.openai.com/profile'] ?? {}) as { email?: string };
  const idClaims = typeof p.id_token === 'string' ? jwtPayload(p.id_token) : {};
  const email = profile.email ?? (typeof idClaims.email === 'string' ? idClaims.email : undefined);
  return {
    access,
    refresh,
    expiresAt: expiresFrom(p.expires_in, access),
    accountId: auth.chatgpt_account_id ?? prev?.accountId,
    label: [email, auth.chatgpt_plan_type].filter(Boolean).join(' · ') || prev?.label,
  };
}

async function refreshChatgpt(t: OAuthTokens): Promise<OAuthTokens> {
  const r = await authFetch('chatgpt', `${OAI_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: OAI_CLIENT_ID, refresh_token: t.refresh }),
  });
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) {
      await saveTokens('chatgpt', null);
      throw new Error('Your ChatGPT session expired. Sign in again from Settings.');
    }
    throw new Error(authFailureMessage('ChatGPT token refresh', r.status, await failureBody(r)));
  }
  return chatgptTokensFrom((await r.json()) as Record<string, unknown>, t);
}

/** Headers the ChatGPT Codex backend expects. */
export function chatgptHeaders(t: OAuthTokens): Record<string, string> {
  return {
    authorization: `Bearer ${t.access}`,
    ...(t.accountId ? { 'chatgpt-account-id': t.accountId } : {}),
    'openai-beta': 'responses=experimental',
    // Third-party harnesses identify themselves here; the backend treats non-Codex values as third party.
    originator: 'usermods',
  };
}
