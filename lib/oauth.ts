// Subscription sign-in for ChatGPT (Sign in with ChatGPT) and xAI (SuperGrok / X Premium+).
// Both use the OAuth device-code grant, so no redirect URL and no local server are needed:
// the user opens a page, types a short code, and we poll for the token.
//
// Wire details come from the vendors' own CLIs (openai/codex and xAI's grok CLI), as reused by
// several open-source agents. Neither vendor publishes docs for this; see README.

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

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  poll: (signal: AbortSignal) => Promise<OAuthTokens>;
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;

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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  const res = await fetch(`${XAI_ISSUER}/oauth2/device/code`, {
    method: 'POST',
    headers: xaiAuthHeaders,
    body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: 'usermods' }),
  });
  if (!res.ok) throw new Error(`xAI device-code request failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  const d = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  };
  let interval = Math.max(1, d.interval ?? 5);
  const expiresAt = Date.now() + Math.max(d.expires_in, 60) * 1000;
  return {
    userCode: d.user_code,
    verificationUri: d.verification_uri_complete ?? d.verification_uri,
    expiresAt,
    async poll(signal) {
      for (;;) {
        await sleep(interval * 1000, signal);
        if (Date.now() > expiresAt) throw new Error('The xAI sign-in code expired. Start again.');
        const r = await fetch(`${XAI_ISSUER}/oauth2/token`, {
          method: 'POST',
          headers: xaiAuthHeaders,
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: d.device_code,
            client_id: XAI_CLIENT_ID,
          }),
          signal,
        });
        if (r.ok) return xaiTokensFrom((await r.json()) as Record<string, unknown>);
        const err = (await r.json().catch(() => ({}))) as { error?: string };
        if (err.error === 'authorization_pending') continue;
        if (err.error === 'slow_down') {
          interval += 5;
          continue;
        }
        if (err.error === 'access_denied') throw new Error('xAI sign-in was denied.');
        if (err.error === 'expired_token') throw new Error('The xAI sign-in code expired. Start again.');
        throw new Error(`xAI sign-in failed: ${err.error ?? r.status}`);
      }
    },
  };
}

function xaiTokensFrom(p: Record<string, unknown>): OAuthTokens {
  const access = String(p.access_token ?? '');
  const refresh = String(p.refresh_token ?? '');
  if (!access || !refresh) throw new Error('xAI sign-in did not return tokens.');
  const id = typeof p.id_token === 'string' ? jwtPayload(p.id_token) : {};
  return { access, refresh, expiresAt: expiresFrom(p.expires_in, access), label: typeof id.email === 'string' ? id.email : undefined };
}

async function refreshXai(t: OAuthTokens): Promise<OAuthTokens> {
  const r = await fetch(`${XAI_ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: XAI_CLIENT_ID, refresh_token: t.refresh }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    if (err.error === 'invalid_grant' || err.error === 'invalid_client') {
      await saveTokens('xai', null);
      throw new Error('Your xAI session expired. Sign in again from Settings.');
    }
    throw new Error(`xAI token refresh failed: ${err.error ?? r.status}`);
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
  const res = await fetch(`${OAI_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: OAI_CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`ChatGPT device-code request failed: ${res.status}`);
  const d = (await res.json()) as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string | number };
  const userCode = d.user_code ?? d.usercode ?? '';
  const interval = Math.max(1, Number(d.interval) || 5);
  const expiresAt = Date.now() + 15 * 60 * 1000;
  return {
    userCode,
    verificationUri: `${OAI_ISSUER}/codex/device`,
    expiresAt,
    async poll(signal) {
      for (;;) {
        await sleep(interval * 1000, signal);
        if (Date.now() > expiresAt) throw new Error('The ChatGPT sign-in code expired. Start again.');
        const r = await fetch(`${OAI_ISSUER}/api/accounts/deviceauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device_auth_id: d.device_auth_id, user_code: userCode }),
          signal,
        });
        if (r.status === 403 || r.status === 404) continue; // not approved yet
        if (!r.ok) throw new Error(`ChatGPT sign-in failed: ${r.status}`);
        const code = (await r.json()) as { authorization_code: string; code_verifier: string };
        return exchangeChatgptCode(code.authorization_code, code.code_verifier);
      }
    },
  };
}

async function exchangeChatgptCode(code: string, verifier: string): Promise<OAuthTokens> {
  const r = await fetch(`${OAI_ISSUER}/oauth/token`, {
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
  if (!r.ok) throw new Error(`ChatGPT token exchange failed: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
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
  const r = await fetch(`${OAI_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: OAI_CLIENT_ID, refresh_token: t.refresh }),
  });
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) {
      await saveTokens('chatgpt', null);
      throw new Error('Your ChatGPT session expired. Sign in again from Settings.');
    }
    throw new Error(`ChatGPT token refresh failed: ${r.status}`);
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
