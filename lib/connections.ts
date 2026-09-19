// Connected providers, and which model a chat talks to.
//
// usermods used to hold ONE provider in Settings: `provider, baseUrl, apiKey, model`, overwritten by
// whichever preset was clicked last. Using a second model meant retyping the first one's key to get
// back. Now there is a list of CONNECTIONS — each its own endpoint, credentials, Images setting and
// cached model list — and the model is chosen in the conversation, per chat, from every connection
// that is connected.
//
// Storage, all in chrome.storage.local, all on this device, exactly where the single provider was:
//
//   'connections'  { v: 1, list: Connection[] }   endpoints, API keys, cached model lists
//   'modelChoice'  ModelSelection | null          the last model the user picked; a new chat's default
//   'chats'[].model ModelSelection                the model each chat talks to (lib/chats.ts)
//   'settings'     the global preferences          theme, auto-naming, context budget, panel scope
//   'oauth:<kind>' subscription sign-in tokens     unchanged (lib/oauth.ts)
//
// Everything that talks to a model still takes a `Settings` — the adapters, the titler, the
// compaction summariser, the vision memory key. effectiveSettings() builds one from the global
// preferences plus the connection and model a chat resolved to, so none of them had to learn what a
// connection is, and "the model" has exactly one meaning everywhere: the chat's selection.
//
// The top half of this file is pure and unit tested (test/connections.test.ts); the storage half at
// the bottom is the only part that touches chrome. `.ts` extensions and type-only imports of
// ./types, because the node test runner resolves neither extensionless specifiers nor WXT aliases.
import { isSubscriptionProvider, providerAvailable, STORE_BUILD } from './buildflags.ts';
import type { ImagesSetting, ProviderKind, Settings } from './types';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** What a connection's last model listing returned. */
export interface ModelCache {
  ids: string[];
  /** Date.now() of the listing. */
  fetchedAt: number;
  /** True when `ids` is the built-in list, because the server's could not be had (lib/modellist.ts). */
  fallback?: boolean;
  /** Why the server's list could not be had. */
  error?: string;
}

export interface Connection {
  /** Stable for the life of the connection; chats refer to it. */
  id: string;
  kind: ProviderKind;
  /** What the user calls it. Unique within the list, so the picker's groups are never ambiguous. */
  label: string;
  /** Empty means the kind's default endpoint. Unused by the subscription kinds. */
  baseUrl: string;
  /** Empty for a keyless local endpoint, and always for the subscription kinds (they sign in). */
  apiKey: string;
  /**
   * Whether pictures are sent to this endpoint (lib/providers/vision.ts). Per connection, because it
   * is a fact about an endpoint: a text-only model on localhost and GPT on api.openai.com need
   * different answers at the same time. Only read for 'openai-compatible'.
   */
  images?: ImagesSetting;
  /**
   * Model ids offered whether or not a listing has them: the preset's default, the model a migrated
   * profile was using, and anything the user typed into the picker. This is what makes an endpoint
   * that cannot list models usable at all.
   */
  extraModels?: string[];
  /** The cached listing. Absent until the first fetch. */
  models?: ModelCache;
}

export interface ConnectionsState {
  v: 1;
  list: Connection[];
}

/** A model, and the connection that serves it. */
export interface ModelSelection {
  connectionId: string;
  model: string;
  /**
   * The connection's label when this was picked. A snapshot, used for exactly one thing: naming the
   * provider in "the provider this chat was using was removed" after the connection itself is gone.
   */
  label?: string;
}

/** Which subscription kinds are signed in right now. Asked of the background (lib/oauth storage). */
export interface SignedIn {
  chatgpt: boolean;
  xai: boolean;
}

export const NOT_SIGNED_IN: SignedIn = { chatgpt: false, xai: false };
export const EMPTY_CONNECTIONS: ConnectionsState = { v: 1, list: [] };

/** A cached listing older than this is refreshed the next time the picker opens. */
export const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Presets: the "Add provider" choices
// ---------------------------------------------------------------------------

export interface ProviderPreset {
  /** The button's text, and the new connection's label. */
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** A model offered from the start, before any listing. Empty where nobody could guess one. */
  model: string;
}

export const KEY_PRESETS: readonly ProviderPreset[] = [
  { label: 'Anthropic', kind: 'anthropic', baseUrl: '', model: 'claude-opus-5' },
  { label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  { label: 'xAI Grok', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' },
  { label: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5' },
  { label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: '' },
  { label: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: '' },
];

export const CUSTOM_PRESETS: readonly ProviderPreset[] = [
  { label: 'Custom Anthropic API', kind: 'anthropic', baseUrl: 'http://localhost:', model: '' },
  { label: 'Custom OpenAI API', kind: 'openai-compatible', baseUrl: 'http://localhost:', model: '' },
];

/**
 * The subscription presets, behind the compile-time flag so a store bundle carries neither the
 * entries nor their labels — a filter at runtime would leave both in the file.
 */
export const SUBSCRIPTION_PRESETS: readonly ProviderPreset[] = STORE_BUILD
  ? []
  : [
      { label: 'ChatGPT subscription', kind: 'chatgpt', baseUrl: '', model: '' },
      { label: 'SuperGrok subscription', kind: 'xai', baseUrl: '', model: 'grok-4.6' },
    ];

/** The presets a build offers, in the order the Add provider row shows them. */
export function presetsFor(storeBuild: boolean = STORE_BUILD): ProviderPreset[] {
  const subs = storeBuild ? [] : SUBSCRIPTION_PRESETS;
  return [...KEY_PRESETS, ...subs, ...CUSTOM_PRESETS];
}

/**
 * Whether one more connection of this kind can be added. Key-based kinds: always — two custom
 * OpenAI endpoints is the normal case. Subscription kinds: one each, because the sign-in is stored
 * per vendor (`oauth:chatgpt`), so a second "ChatGPT" row would be the same account twice.
 */
export function canAdd(kind: ProviderKind, list: readonly Connection[], storeBuild: boolean = STORE_BUILD): boolean {
  if (!providerAvailable(kind, storeBuild)) return false;
  return !(isSubscriptionProvider(kind) && list.some((c) => c.kind === kind));
}

// ---------------------------------------------------------------------------
// CRUD, as pure state transitions
// ---------------------------------------------------------------------------

/** `label`, or `label 2`, `label 3`… — whichever the list does not have yet. */
export function uniqueLabel(label: string, list: readonly Connection[], exceptId?: string): string {
  const base = label.trim() || 'Provider';
  const taken = new Set(list.filter((c) => c.id !== exceptId).map((c) => c.label.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** A new connection from a preset. `id` is passed in so this stays pure. */
export function connectionFromPreset(preset: ProviderPreset, list: readonly Connection[], id: string): Connection {
  return {
    id,
    kind: preset.kind,
    label: uniqueLabel(preset.label, list),
    baseUrl: preset.baseUrl,
    apiKey: '',
    ...(preset.model ? { extraModels: [preset.model] } : {}),
  };
}

export function addConnection(state: ConnectionsState, conn: Connection): ConnectionsState {
  if (state.list.some((c) => c.id === conn.id)) return state;
  return { v: 1, list: [...state.list, conn] };
}

/** What Settings may change on a connection. `id` and `kind` are fixed for its life. */
export type ConnectionPatch = Partial<Pick<Connection, 'label' | 'baseUrl' | 'apiKey' | 'images' | 'extraModels' | 'models'>>;

/**
 * Apply a patch to one connection. An unknown id is a no-op (the connection was removed in another
 * view while this one was still typing). Moving the endpoint drops the cached listing: it described
 * a different server, and offering its models against the new one would be offering models that may
 * not exist there.
 */
export function updateConnection(state: ConnectionsState, id: string, patch: ConnectionPatch): ConnectionsState {
  let changed = false;
  const list = state.list.map((c) => {
    if (c.id !== id) return c;
    changed = true;
    const next: Connection = { ...c, ...patch };
    if (patch.label !== undefined) next.label = uniqueLabel(patch.label, state.list, id);
    if (patch.extraModels !== undefined) next.extraModels = dedupe(patch.extraModels);
    if (patch.baseUrl !== undefined && patch.baseUrl.trim() !== c.baseUrl.trim() && patch.models === undefined) delete next.models;
    return next;
  });
  return changed ? { v: 1, list } : state;
}

export function removeConnection(state: ConnectionsState, id: string): ConnectionsState {
  const list = state.list.filter((c) => c.id !== id);
  return list.length === state.list.length ? state : { v: 1, list };
}

/** Remember a model id the user typed, so the picker offers it next time. */
export function rememberModel(state: ConnectionsState, id: string, model: string): ConnectionsState {
  const conn = state.list.find((c) => c.id === id);
  const m = model.trim();
  if (!conn || !m || offeredModels(conn).includes(m)) return state;
  return updateConnection(state, id, { extraModels: [...(conn.extraModels ?? []), m] });
}

// ---------------------------------------------------------------------------
// Connectedness
// ---------------------------------------------------------------------------

/**
 * Hosted APIs that answer nothing without a key. A base URL alone counts as connected — that is
 * what a local server or a proxy in front of a subscription looks like — except for these, where
 * "connected" with no key would only mean a 401 on the first message.
 */
const KEY_REQUIRED_HOSTS = new Set(['api.anthropic.com', 'api.openai.com', 'api.x.ai', 'openrouter.ai']);

function hostOf(url: string): string {
  // "http://localhost:" is what the Custom presets start from: a URL waiting for its port. It
  // parses, but it is not an endpoint yet.
  if (/:\/*$/.test(url.trim())) return '';
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return '';
  }
}

export type ConnectionStatus = 'connected' | 'needs-key' | 'signed-out' | 'unavailable';

/**
 * Whether a connection has what it needs to be talked to:
 *   a subscription kind  — signed in (and the build includes it at all);
 *   a key-based kind     — a key, or a base URL that is not one of the hosted APIs above.
 * A key-based connection with neither a key nor a base URL points at the vendor's hosted default,
 * which needs a key.
 */
export function connectionStatus(conn: Connection, signedIn: SignedIn, storeBuild: boolean = STORE_BUILD): ConnectionStatus {
  if (!providerAvailable(conn.kind, storeBuild)) return 'unavailable';
  if (isSubscriptionProvider(conn.kind)) return signedIn[conn.kind] ? 'connected' : 'signed-out';
  if (conn.apiKey.trim()) return 'connected';
  const host = hostOf(conn.baseUrl);
  return host && !KEY_REQUIRED_HOSTS.has(host) ? 'connected' : 'needs-key';
}

export function isConnected(conn: Connection, signedIn: SignedIn, storeBuild: boolean = STORE_BUILD): boolean {
  return connectionStatus(conn, signedIn, storeBuild) === 'connected';
}

/** The status line under a connection in Settings. */
export function statusText(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'needs-key':
      return 'Needs an API key';
    case 'signed-out':
      return 'Not signed in';
    case 'unavailable':
      return 'Not available in this build';
  }
}

// ---------------------------------------------------------------------------
// Models offered
// ---------------------------------------------------------------------------

/** Every model a connection offers: the user's own and the preset's first, then the listing. */
export function offeredModels(conn: Connection): string[] {
  return dedupe([...(conn.extraModels ?? []), ...(conn.models?.ids ?? [])]);
}

/** Whether the cached listing should be refreshed: never fetched, a fallback, or older than the TTL. */
export function modelsStale(conn: Connection, now: number = Date.now(), ttl: number = MODELS_TTL_MS): boolean {
  const m = conn.models;
  if (!m) return true;
  if (m.fallback || m.error) return true;
  return now - m.fetchedAt > ttl;
}

export interface PickerGroup {
  connection: Connection;
  /** The models of this connection that match the filter. */
  models: string[];
  /** How many it offers in all, so an empty filtered group can be told from an empty connection. */
  total: number;
}

/**
 * What the in-chat picker lists: one group per CONNECTED connection, in Settings order, each with
 * the models that match `filter` (case-insensitive, every whitespace-separated term must appear in
 * the model id or the connection label). A connection that is not connected is not listed at all —
 * not greyed out — which is also what keeps the subscription kinds out of a store build's picker.
 */
export function pickerGroups(state: ConnectionsState, signedIn: SignedIn, filter = '', storeBuild: boolean = STORE_BUILD): PickerGroup[] {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return state.list
    .filter((c) => isConnected(c, signedIn, storeBuild))
    .map((connection) => {
      const all = offeredModels(connection);
      const label = connection.label.toLowerCase();
      const models = terms.length ? all.filter((m) => terms.every((t) => m.toLowerCase().includes(t) || label.includes(t))) : all;
      return { connection, models, total: all.length };
    });
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type SelectionProblem = 'none' | 'no-providers' | 'removed' | 'unavailable' | 'signed-out' | 'needs-key' | 'no-model';

export type ResolvedSelection =
  | { ok: true; connection: Connection; model: string; selection: ModelSelection }
  | { ok: false; problem: SelectionProblem; message: string };

/**
 * What the composer and the background say when a chat cannot be sent as it stands. One set of
 * sentences for both, so the error row of a run that was started anyway reads the same as the line
 * that was under the composer beforehand.
 */
export function problemMessage(problem: SelectionProblem, label = ''): string {
  const named = label ? `“${label}”` : 'that provider';
  switch (problem) {
    case 'no-providers':
      return 'Connect a provider in Settings to start: an API key, a local server, or a subscription sign-in.';
    case 'none':
      return 'Pick a model for this chat.';
    case 'removed':
      return `The provider this chat was using${label ? ` (${label})` : ''} was removed. Pick another model to continue.`;
    case 'unavailable':
      return `${label || 'That provider'} is not available in this build of usermods. Pick another model to continue.`;
    case 'signed-out':
      return `You are signed out of ${named}. Sign in again in Settings, or pick another model.`;
    case 'needs-key':
      return `${label || 'That provider'} has no API key. Add one in Settings, or pick another model.`;
    case 'no-model':
      return `Pick a model for ${named}.`;
  }
}

/**
 * Turn a selection into the connection and model to call, or into the reason it cannot be.
 *
 * It never substitutes. A selection whose connection was removed, signed out or lost its key is a
 * PROBLEM the user is told about, not a cue to quietly use some other provider: which company reads
 * the page is the one thing in this product that must never change without being asked.
 */
export function resolveSelection(
  selection: ModelSelection | null | undefined,
  state: ConnectionsState,
  signedIn: SignedIn,
  storeBuild: boolean = STORE_BUILD,
): ResolvedSelection {
  if (!selection || !selection.connectionId) {
    const anyConnected = state.list.some((c) => isConnected(c, signedIn, storeBuild));
    const problem: SelectionProblem = anyConnected ? 'none' : 'no-providers';
    return { ok: false, problem, message: problemMessage(problem) };
  }
  const connection = state.list.find((c) => c.id === selection.connectionId);
  if (!connection) return { ok: false, problem: 'removed', message: problemMessage('removed', selection.label) };
  const status = connectionStatus(connection, signedIn, storeBuild);
  if (status !== 'connected') return { ok: false, problem: status, message: problemMessage(status, connection.label) };
  const model = selection.model.trim();
  if (!model) return { ok: false, problem: 'no-model', message: problemMessage('no-model', connection.label) };
  return { ok: true, connection, model, selection: { connectionId: connection.id, model, label: connection.label } };
}

/**
 * The model a NEW chat starts on: the last one the user picked, if it can still be used; otherwise
 * the first model of the first connected connection; otherwise nothing. This is a default for a
 * chat that has never had a selection — it is not a fallback for one whose selection broke.
 */
export function defaultSelection(
  state: ConnectionsState,
  last: ModelSelection | null | undefined,
  signedIn: SignedIn,
  storeBuild: boolean = STORE_BUILD,
): ModelSelection | null {
  const lastResolved = resolveSelection(last, state, signedIn, storeBuild);
  if (lastResolved.ok) return lastResolved.selection;
  for (const c of state.list) {
    if (!isConnected(c, signedIn, storeBuild)) continue;
    const first = offeredModels(c)[0];
    if (first) return { connectionId: c.id, model: first, label: c.label };
  }
  return null;
}

/** A chat's selection: its own if it has one, else the default a new chat would get. */
export function selectionForChat(
  chat: { model?: ModelSelection } | null | undefined,
  state: ConnectionsState,
  last: ModelSelection | null | undefined,
  signedIn: SignedIn,
  storeBuild: boolean = STORE_BUILD,
): ModelSelection | null {
  return chat?.model?.connectionId ? chat.model : defaultSelection(state, last, signedIn, storeBuild);
}

export function sameSelection(a: ModelSelection | null | undefined, b: ModelSelection | null | undefined): boolean {
  return !!a && !!b && a.connectionId === b.connectionId && a.model === b.model;
}

/**
 * The `Settings` every model-facing function takes, for one resolved selection: the global
 * preferences, with the provider fields filled from the connection and the model from the chat.
 */
export function effectiveSettings(prefs: Settings, connection: Connection, model: string): Settings {
  return {
    ...prefs,
    provider: connection.kind,
    baseUrl: connection.baseUrl.trim(),
    apiKey: connection.apiKey.trim(),
    model,
    images: connection.images,
  };
}

// ---------------------------------------------------------------------------
// Migration from the single-provider Settings
// ---------------------------------------------------------------------------

/** The id of the connection a legacy profile becomes. Fixed, so two contexts migrating at the same
 *  moment (the panel and the background both read on startup) write the same thing. */
export const LEGACY_CONNECTION_ID = 'legacy';

const LEGACY_FIELDS = ['provider', 'baseUrl', 'apiKey', 'model', 'images'] as const;
const KINDS: readonly ProviderKind[] = ['anthropic', 'openai-compatible', 'chatgpt', 'xai'];

/** What to call a connection nobody named: the preset it matches, else its host, else its kind. */
export function labelFor(kind: ProviderKind, baseUrl: string): string {
  if (kind === 'chatgpt') return 'ChatGPT subscription';
  if (kind === 'xai') return 'SuperGrok subscription';
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (kind === 'anthropic' && !url) return 'Anthropic';
  const preset = KEY_PRESETS.find((p) => p.kind === kind && p.baseUrl && p.baseUrl.replace(/\/+$/, '') === url);
  if (preset) return preset.label;
  const host = hostOf(url);
  if (host) return host;
  return kind === 'anthropic' ? 'Anthropic' : 'OpenAI';
}

export function isConnectionsState(v: unknown): v is ConnectionsState {
  return !!v && typeof v === 'object' && (v as ConnectionsState).v === 1 && Array.isArray((v as ConnectionsState).list);
}

/** A stored state with anything malformed dropped, so one bad row cannot take the list down. */
export function sanitizeConnections(v: unknown): ConnectionsState {
  if (!isConnectionsState(v)) return EMPTY_CONNECTIONS;
  const list = v.list.filter(
    (c): c is Connection =>
      !!c && typeof c === 'object' && typeof c.id === 'string' && !!c.id && KINDS.includes(c.kind) && typeof c.label === 'string',
  );
  return {
    v: 1,
    list: list.map((c) => ({ ...c, baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : '', apiKey: typeof c.apiKey === 'string' ? c.apiKey : '' })),
  };
}

export interface LegacyMigration {
  connections: ConnectionsState;
  /** The stored settings object with the provider fields taken out; every other key untouched. */
  settings: Record<string, unknown>;
  /** The legacy model, as the last choice, so the first new chat starts where the user already was. */
  choice: ModelSelection | null;
}

/**
 * Turn a stored single-provider `settings` object into one connection.
 *
 * Returns null when there is nothing to do, which is every call after the first:
 *   - a 'connections' state is already stored (idempotent: the list is the truth from then on, and
 *     provider fields reappearing under 'settings' — an older build, a test seeding the old shape —
 *     are not merged in a second time);
 *   - nothing was ever stored, or what is stored holds no provider field (a fresh install, or a
 *     profile that only ever saved a theme). Nothing is written for those, so a fresh install stays
 *     fresh until the user adds a provider.
 *
 * Lossless: kind, base URL, key, model and the Images setting all carry over, including for a
 * profile that never got a key (it becomes a connection that says "Needs an API key") and for a
 * subscription profile (the sign-in itself lives in lib/oauth storage and is not touched). The
 * provider fields are then REMOVED from 'settings', so the API key exists in one place: removing the
 * connection removes the key, rather than leaving a copy in a field nothing reads any more.
 */
export function migrateLegacySettings(storedSettings: unknown, storedConnections: unknown): LegacyMigration | null {
  if (isConnectionsState(storedConnections)) return null;
  if (!storedSettings || typeof storedSettings !== 'object') return null;
  const s = storedSettings as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() : '');
  if (!LEGACY_FIELDS.some((k) => s[k] !== undefined)) return null;

  const kind: ProviderKind = KINDS.includes(s.provider as ProviderKind) ? (s.provider as ProviderKind) : 'anthropic';
  // A profile that never chose a model was running on the old built-in default; keep it running.
  const model = str('model') || (kind === 'anthropic' && s.model === undefined ? 'claude-opus-5' : '');
  const subscription = isSubscriptionProvider(kind);
  const connection: Connection = {
    id: LEGACY_CONNECTION_ID,
    kind,
    label: labelFor(kind, str('baseUrl')),
    baseUrl: str('baseUrl'),
    apiKey: subscription ? '' : str('apiKey'),
    ...(s.images === 'auto' || s.images === 'send' || s.images === 'never' ? { images: s.images } : {}),
    ...(model ? { extraModels: [model] } : {}),
  };
  const settings: Record<string, unknown> = { ...s };
  for (const k of LEGACY_FIELDS) delete settings[k];
  return {
    connections: { v: 1, list: [connection] },
    settings,
    choice: model ? { connectionId: connection.id, model, label: connection.label } : null,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const CONNECTIONS_KEY = 'connections';
export const MODEL_CHOICE_KEY = 'modelChoice';
const SETTINGS_KEY = 'settings';

/**
 * The stored connections, migrating a legacy profile on the way if there is one. The three keys the
 * migration touches are written in ONE set() call, so there is no moment at which the key has left
 * 'settings' and not yet arrived in 'connections'.
 */
export async function loadConnections(): Promise<ConnectionsState> {
  const r = await chrome.storage.local.get([CONNECTIONS_KEY, SETTINGS_KEY]);
  const migration = migrateLegacySettings(r[SETTINGS_KEY], r[CONNECTIONS_KEY]);
  if (!migration) return sanitizeConnections(r[CONNECTIONS_KEY]);
  await chrome.storage.local.set({
    [CONNECTIONS_KEY]: migration.connections,
    [SETTINGS_KEY]: migration.settings,
    ...(migration.choice ? { [MODEL_CHOICE_KEY]: migration.choice } : {}),
  });
  return migration.connections;
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Change the stored connections. The list is re-read immediately before the write and the change
 * applied to THAT, never to the state a view happened to be holding: Settings autosaves a key being
 * typed while the background writes a model listing into the same list, and a whole-list write from
 * a stale copy would undo whichever landed first. Writes from one context are also serialised.
 */
export function mutateConnections(fn: (state: ConnectionsState) => ConnectionsState): Promise<ConnectionsState> {
  const run = async () => {
    const current = await loadConnections();
    const next = fn(current);
    if (next !== current) await chrome.storage.local.set({ [CONNECTIONS_KEY]: next });
    return next;
  };
  const p = writeChain.then(run, run);
  writeChain = p.catch(() => {});
  return p;
}

export async function loadModelChoice(): Promise<ModelSelection | null> {
  const r = await chrome.storage.local.get(MODEL_CHOICE_KEY);
  const c = r[MODEL_CHOICE_KEY] as Partial<ModelSelection> | undefined;
  return c && typeof c.connectionId === 'string' && typeof c.model === 'string' ? (c as ModelSelection) : null;
}

export async function saveModelChoice(selection: ModelSelection): Promise<void> {
  await chrome.storage.local.set({ [MODEL_CHOICE_KEY]: selection });
}
