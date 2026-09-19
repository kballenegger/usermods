// Listing the models an endpoint serves: the request, the response, and what to do when it fails.
//
// Pure, so every line is unit tested (test/modellist.test.ts). The background supplies the one
// thing that is not pure — the sign-in headers of a subscription provider — and does the fetch.
//
// Each backend lists differently:
//
//   anthropic           GET {base}/v1/models?limit=100        { data: [{ id }] }
//   openai-compatible   GET {base}/models                     { data: [{ id }] }  (Ollama, LM Studio,
//                                                             OpenRouter and OpenAI all agree)
//   xai (subscription)  GET {proxy}/models                    { data: [{ id }] }
//   chatgpt             GET {codex}/models?client_version=…   { models: [{ slug, visibility, priority }] }
//
// The ChatGPT row is the one that is not like the others, and it is why "Fetch models" answered 400
// straight after a successful sign-in: the Codex backend REQUIRES `client_version`, and answers a
// request without it with a 400. The open-source Codex CLI is the reference:
//
//   codex-rs/codex-api/src/endpoint/models.rs        append_client_version_query(): `models` +
//                                                    `?client_version=<version>` (or `&` when the
//                                                    URL already has a query)
//   codex-rs/models-manager/src/lib.rs               client_version_to_whole(): MAJOR.MINOR.PATCH,
//                                                    pre-release suffix dropped
//   codex-rs/protocol/src/openai_models.rs           ModelsResponse { models: Vec<ModelInfo> };
//                                                    ModelInfo { slug, display_name, visibility:
//                                                    list|hide|none, priority, … }
//   codex-rs/models-manager/models.json              the catalog bundled with the CLI; every entry
//                                                    has a `minimal_client_version`, so the version
//                                                    sent decides which models come back
//   codex-rs/model-provider/src/bearer_auth_provider.rs   Authorization + ChatGPT-Account-ID
//
// .ts extensions and type-only imports of ./types: this module is unit tested under
// node --experimental-strip-types, whose resolver does not guess extensions.
import type { ProviderKind } from './types';

/**
 * The Codex CLI release this build describes itself as when it asks the ChatGPT backend for models.
 *
 * The backend filters the catalog by it (each model carries a `minimal_client_version`), so an old
 * value hides new models rather than failing. Keep it at a current `rust-v*` release of openai/codex
 * whenever the fallback list below is refreshed.
 */
export const CHATGPT_CLIENT_VERSION = '0.155.1';

/** What a listing is made against. `baseUrl` may be empty: each kind has a default. */
export interface ModelListTarget {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
}

/** Default bases, restated here (not imported) so this module stays a leaf the node runner can load. */
const DEFAULT_BASE: Record<ProviderKind, string> = {
  anthropic: 'https://api.anthropic.com',
  'openai-compatible': 'https://api.openai.com/v1',
  chatgpt: 'https://chatgpt.com/backend-api/codex',
  xai: 'https://cli-chat-proxy.grok.com/v1',
};

/** `base` + `path`, with `query` appended whether or not the base already carries a query string. */
function join(base: string, path: string, query = ''): string {
  const [root = '', existing = ''] = base.split('?');
  const url = `${root.replace(/\/+$/, '')}${path}`;
  const qs = [existing, query].filter(Boolean).join('&');
  return qs ? `${url}?${qs}` : url;
}

/**
 * The URL and headers of a model listing.
 *
 * `auth` is the sign-in headers of a subscription provider (lib/oauth's chatgptHeaders /
 * xaiProxyHeaders), passed in by the background so this module never imports lib/oauth — which must
 * stay out of the store bundle. It is ignored for the key-based kinds.
 */
export function modelsRequest(target: ModelListTarget, auth: Record<string, string> = {}): { url: string; headers: Record<string, string> } {
  const base = target.baseUrl.trim() || DEFAULT_BASE[target.kind];
  switch (target.kind) {
    case 'anthropic':
      return {
        url: join(base, '/v1/models', 'limit=100'),
        headers: { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' },
      };
    case 'openai-compatible':
      return { url: join(base, '/models'), headers: target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {} };
    case 'chatgpt': {
      // The inference headers, minus the Responses beta flag: the CLI does not send it to /models,
      // and this request is meant to look like the CLI's.
      const headers = { ...auth, accept: 'application/json' };
      delete (headers as Record<string, string>)['openai-beta'];
      return { url: join(base, '/models', `client_version=${encodeURIComponent(CHATGPT_CLIENT_VERSION)}`), headers };
    }
    case 'xai': {
      // The proxy's inference headers name the model being called. A listing calls none, and an
      // empty override is not the same as no override, so the header is dropped rather than blanked.
      const headers = { ...auth, accept: 'application/json' };
      delete (headers as Record<string, string>)['x-grok-model-override'];
      return { url: join(base, '/models'), headers };
    }
  }
}

interface ListedModel {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

/**
 * Model ids out of a listing response, whichever of the shapes above it has.
 *
 * Tolerant on purpose: an "OpenAI-compatible" server is whatever someone wrote, so `data`, `models`
 * and a bare array are all read, and an entry is taken by `id`, then `slug`, then `name` (Ollama's
 * native shape). A Codex catalog entry marked `visibility: "hide"` or `"none"` is an internal model
 * (a reviewer, a preview alias) the CLI's own picker leaves out, and so does this.
 *
 * Ordering: a catalog that ranks its models (`priority`, lowest first) keeps that order, because it
 * puts the current flagship on top; everything else is sorted by id.
 */
export function parseModelIds(body: unknown): string[] {
  const b = body as { data?: unknown; models?: unknown } | null;
  const list: ListedModel[] = Array.isArray(body)
    ? (body as ListedModel[])
    : Array.isArray(b?.data)
      ? (b!.data as ListedModel[])
      : Array.isArray(b?.models)
        ? (b!.models as ListedModel[])
        : [];
  const seen = new Set<string>();
  const entries: Array<{ id: string; priority: number | null }> = [];
  for (const m of list) {
    const raw = typeof m === 'string' ? m : (m?.id ?? m?.slug ?? m?.name);
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const id = raw.trim();
    if (typeof m === 'object' && (m.visibility === 'hide' || m.visibility === 'none')) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, priority: typeof m === 'object' && typeof m.priority === 'number' ? m.priority : null });
  }
  const ranked = entries.some((e) => e.priority !== null);
  entries.sort((a, b) => {
    if (ranked) {
      const d = (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
      if (d) return d;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return entries.map((e) => e.id);
}

const MAX_DETAIL = 300;

/**
 * What the server said about a failed listing, from the response body.
 *
 * "Could not list models: 400" told the user nothing they could act on, while the body of that 400
 * said exactly what was missing. Every common error envelope is read — OpenAI's `{error:{message}}`,
 * Anthropic's the same, FastAPI's `{detail}`, a bare `{message}` or `{error:"…"}` — and anything
 * else is shown as the text it is, trimmed, with an HTML error page reduced to nothing rather than
 * poured into a status line.
 */
export function errorDetail(bodyText: string): string {
  const text = bodyText.trim();
  if (!text) return '';
  let detail = '';
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const err = j.error;
    const pick = (v: unknown): string => (typeof v === 'string' ? v : '');
    detail =
      (err && typeof err === 'object' ? pick((err as Record<string, unknown>).message) : pick(err)) ||
      pick(j.message) ||
      (typeof j.detail === 'string' ? j.detail : j.detail ? JSON.stringify(j.detail) : '');
  } catch {
    detail = /^\s*</.test(text) ? '' : text;
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail;
}

/** The one-line failure the user reads: the status, and the server's own explanation when it gave one. */
export function listFailureMessage(status: number, bodyText: string): string {
  const detail = errorDetail(bodyText);
  return detail ? `Could not list models (${status}): ${detail}` : `Could not list models (${status}).`;
}

/**
 * Models offered when a subscription provider's listing fails, so the picker is never empty after a
 * successful sign-in. These are the `visibility: "list"` slugs of the catalog bundled with the Codex
 * CLI at CHATGPT_CLIENT_VERSION (codex-rs/models-manager/models.json), and the xAI ids this project
 * has shipped as presets. A built-in list goes stale, which is why the UI marks it as a fallback and
 * always lets the user type an id instead.
 *
 * Only the subscription kinds have one. A key-based endpoint that cannot list is an endpoint whose
 * models nobody here can guess — a local server, a proxy — and inventing names for it would be worse
 * than saying it could not be listed.
 */
export const FALLBACK_MODELS: Readonly<Record<'chatgpt' | 'xai', readonly string[]>> = {
  chatgpt: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  xai: ['grok-4.6', 'grok-4', 'grok-code-fast-1'],
};

export function fallbackModels(kind: ProviderKind): string[] {
  return kind === 'chatgpt' || kind === 'xai' ? [...FALLBACK_MODELS[kind]] : [];
}

/** The outcome of one listing: what to show, and whether it came from the server. */
export interface ModelListResult {
  models: string[];
  /** True when `models` is the built-in list, because the server's could not be had. */
  fallback: boolean;
  /** Why the server's list could not be had. Present with `fallback`, and on an outright failure. */
  error?: string;
}

/** Shown beside a fallback list, after the reason. */
export const FALLBACK_NOTE = 'Showing a built-in list instead, which may be out of date. You can also type a model id.';

/**
 * Turn a listing attempt into what the UI shows. `attempt` does the I/O and either returns the ids
 * or throws; a subscription kind that throws (or lists nothing) answers with the built-in list and
 * the reason, and every other kind rethrows.
 */
export async function listWithFallback(kind: ProviderKind, attempt: () => Promise<string[]>): Promise<ModelListResult> {
  const builtIn = fallbackModels(kind);
  try {
    const models = await attempt();
    if (models.length || !builtIn.length) return { models, fallback: false };
    return { models: builtIn, fallback: true, error: 'The backend returned no models.' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (!builtIn.length) throw e instanceof Error ? e : new Error(error);
    return { models: builtIn, fallback: true, error };
  }
}
