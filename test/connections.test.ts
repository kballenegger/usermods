// Connected providers and per-chat model selection: the migration from the single-provider
// Settings, the list's CRUD, what counts as connected, how a selection resolves (and refuses to
// fall back), what the picker lists, model-list caching, and the store build's exclusions.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_CONNECTIONS,
  KEY_PRESETS,
  LEGACY_CONNECTION_ID,
  MODELS_TTL_MS,
  NOT_SIGNED_IN,
  addConnection,
  canAdd,
  connectionFromPreset,
  connectionStatus,
  defaultSelection,
  effectiveSettings,
  isConnected,
  labelFor,
  migrateLegacySettings,
  modelsStale,
  offeredModels,
  pickerGroups,
  presetsFor,
  problemMessage,
  rememberModel,
  removeConnection,
  resolveSelection,
  sameSelection,
  sanitizeConnections,
  selectionForChat,
  statusText,
  uniqueLabel,
  updateConnection,
  type Connection,
  type ConnectionsState,
} from '../lib/connections.ts';
import { DEFAULT_SETTINGS } from '../lib/types.ts';

const conn = (over: Partial<Connection> & { id: string }): Connection => ({ kind: 'openai-compatible', label: over.id, baseUrl: '', apiKey: '', ...over });
const state = (...list: Connection[]): ConnectionsState => ({ v: 1, list });
const SIGNED_IN = { chatgpt: true, xai: true };

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

const LEGACY = {
  provider: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-123',
  model: 'anthropic/claude-opus-5',
  images: 'never',
  theme: 'light',
  autoNameChats: false,
  contextBudget: 60_000,
  sidePanelScope: 'window',
};

test('a single-provider profile becomes one connection, losing nothing', () => {
  const m = migrateLegacySettings(LEGACY, undefined);
  assert.ok(m);
  assert.deepEqual(m.connections, {
    v: 1,
    list: [
      {
        id: LEGACY_CONNECTION_ID,
        kind: 'openai-compatible',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-123',
        images: 'never',
        extraModels: ['anthropic/claude-opus-5'],
      },
    ],
  });
  // The model the user was on is the last choice, so their next chat starts where they already were.
  assert.deepEqual(m.choice, { connectionId: LEGACY_CONNECTION_ID, model: 'anthropic/claude-opus-5', label: 'OpenRouter' });
});

test('the global preferences stay under settings, and the key leaves it', () => {
  const m = migrateLegacySettings(LEGACY, undefined)!;
  assert.deepEqual(m.settings, { theme: 'light', autoNameChats: false, contextBudget: 60_000, sidePanelScope: 'window' });
  // One copy of the key: removing the connection must remove the key.
  assert.ok(!JSON.stringify(m.settings).includes('sk-or-123'));
});

test('unknown keys under settings survive the migration untouched', () => {
  const m = migrateLegacySettings({ ...LEGACY, futureThing: { a: 1 } }, undefined)!;
  assert.deepEqual(m.settings.futureThing, { a: 1 });
});

test('the migration does not mutate what it was given', () => {
  const before = structuredClone(LEGACY);
  migrateLegacySettings(LEGACY, undefined);
  assert.deepEqual(LEGACY, before);
});

test('idempotent: once a connections state is stored, nothing migrates again', () => {
  const first = migrateLegacySettings(LEGACY, undefined)!;
  assert.equal(migrateLegacySettings(first.settings, first.connections), null);
  // Even if the old shape reappears under settings (an older build, a test seeding it), the list
  // that exists is the truth — it is not merged into a second time.
  assert.equal(migrateLegacySettings(LEGACY, first.connections), null);
  // An EMPTY list is still a list: the user removed every provider, and they stay removed.
  assert.equal(migrateLegacySettings(LEGACY, EMPTY_CONNECTIONS), null);
});

test('two contexts migrating at once write the same thing', () => {
  assert.deepEqual(migrateLegacySettings(LEGACY, undefined), migrateLegacySettings(LEGACY, undefined));
});

test('nothing stored, or only preferences stored, migrates nothing and writes nothing', () => {
  assert.equal(migrateLegacySettings(undefined, undefined), null);
  assert.equal(migrateLegacySettings(null, undefined), null);
  assert.equal(migrateLegacySettings('garbage', undefined), null);
  assert.equal(migrateLegacySettings({ theme: 'dark' }, undefined), null);
  assert.equal(migrateLegacySettings({ theme: 'dark', sidePanelScope: 'tab', contextBudget: 1 }, undefined), null);
});

test('old stored shapes: a profile from before images, before themes, with a bare provider', () => {
  const m = migrateLegacySettings({ provider: 'anthropic', baseUrl: '', apiKey: 'sk-ant-1', model: 'claude-sonnet-4-6' }, undefined)!;
  assert.deepEqual(m.connections.list, [
    { id: LEGACY_CONNECTION_ID, kind: 'anthropic', label: 'Anthropic', baseUrl: '', apiKey: 'sk-ant-1', extraModels: ['claude-sonnet-4-6'] },
  ]);
  assert.deepEqual(m.settings, {});
  // A profile with a key but no provider field at all predates the provider select: Anthropic.
  const bare = migrateLegacySettings({ apiKey: 'sk-ant-2' }, undefined)!;
  assert.equal(bare.connections.list[0]!.kind, 'anthropic');
  assert.equal(bare.connections.list[0]!.apiKey, 'sk-ant-2');
  // …and it was running on the built-in default model, so it keeps running on it.
  assert.deepEqual(bare.choice, { connectionId: LEGACY_CONNECTION_ID, model: 'claude-opus-5', label: 'Anthropic' });
});

test('a profile that never got a key still migrates: a connection that says what it needs', () => {
  const m = migrateLegacySettings({ provider: 'anthropic', baseUrl: '', apiKey: '', model: 'claude-opus-5', theme: 'system' }, undefined)!;
  assert.equal(connectionStatus(m.connections.list[0]!, NOT_SIGNED_IN, false), 'needs-key');
});

test('an explicitly empty model stays empty: there is no last choice to invent', () => {
  const m = migrateLegacySettings({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' }, undefined)!;
  assert.equal(m.choice, null);
  assert.equal(m.connections.list[0]!.label, 'Ollama');
  assert.equal(m.connections.list[0]!.extraModels, undefined);
});

test('a subscription profile migrates to a subscription connection and carries no key', () => {
  const m = migrateLegacySettings({ provider: 'chatgpt', baseUrl: '', apiKey: 'stale', model: 'gpt-5.5' }, undefined)!;
  assert.deepEqual(m.connections.list[0]!, { id: LEGACY_CONNECTION_ID, kind: 'chatgpt', label: 'ChatGPT subscription', baseUrl: '', apiKey: '', extraModels: ['gpt-5.5'] });
});

test('an unrecognised provider or images value is not carried over as is', () => {
  const m = migrateLegacySettings({ provider: 'gemini', apiKey: 'k', model: 'x', images: 'sometimes' }, undefined)!;
  assert.equal(m.connections.list[0]!.kind, 'anthropic');
  assert.equal(m.connections.list[0]!.images, undefined);
});

test('labels: a preset by its base URL, anything else by its host', () => {
  assert.equal(labelFor('openai-compatible', 'https://api.openai.com/v1/'), 'OpenAI');
  assert.equal(labelFor('openai-compatible', 'http://localhost:1234/v1'), 'LM Studio');
  assert.equal(labelFor('openai-compatible', 'http://127.0.0.1:8080/v1'), '127.0.0.1:8080');
  assert.equal(labelFor('openai-compatible', ''), 'OpenAI');
  assert.equal(labelFor('anthropic', 'http://localhost:9000'), 'localhost:9000');
  assert.equal(labelFor('xai', ''), 'SuperGrok subscription');
});

test('a malformed stored state reads as its valid rows, not as a crash', () => {
  assert.deepEqual(sanitizeConnections(undefined), EMPTY_CONNECTIONS);
  assert.deepEqual(sanitizeConnections({ v: 2, list: [] }), EMPTY_CONNECTIONS);
  const s = sanitizeConnections({ v: 1, list: [null, { id: '', kind: 'anthropic', label: 'x' }, { id: 'a', kind: 'nope', label: 'x' }, { id: 'ok', kind: 'anthropic', label: 'A', apiKey: 5 }] });
  assert.deepEqual(s.list, [{ id: 'ok', kind: 'anthropic', label: 'A', baseUrl: '', apiKey: '' }]);
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

test('adding from a preset: the label, the endpoint and the preset model, with no key', () => {
  const openai = KEY_PRESETS.find((p) => p.label === 'OpenAI')!;
  const c = connectionFromPreset(openai, [], 'id-1');
  assert.deepEqual(c, { id: 'id-1', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '', extraModels: ['gpt-5'] });
  const ollama = connectionFromPreset(KEY_PRESETS.find((p) => p.label === 'Ollama')!, [], 'id-2');
  assert.equal(ollama.extraModels, undefined);
});

test('more than one of the same kind is allowed, and each gets a distinct label', () => {
  const custom = { label: 'Custom OpenAI API', kind: 'openai-compatible' as const, baseUrl: 'http://localhost:', model: '' };
  let s = EMPTY_CONNECTIONS;
  s = addConnection(s, connectionFromPreset(custom, s.list, 'a'));
  s = addConnection(s, connectionFromPreset(custom, s.list, 'b'));
  s = addConnection(s, connectionFromPreset(custom, s.list, 'c'));
  assert.deepEqual(s.list.map((c) => c.label), ['Custom OpenAI API', 'Custom OpenAI API 2', 'Custom OpenAI API 3']);
  assert.ok(canAdd('openai-compatible', s.list, false));
  assert.ok(canAdd('anthropic', s.list, true));
});

test('a subscription kind is one connection: the sign-in is stored per vendor', () => {
  const s = state(conn({ id: 'g', kind: 'chatgpt' }));
  assert.equal(canAdd('chatgpt', s.list, false), false);
  assert.equal(canAdd('xai', s.list, false), true);
});

test('adding the same id twice is a no-op', () => {
  const s = state(conn({ id: 'a' }));
  assert.equal(addConnection(s, conn({ id: 'a', label: 'other' })), s);
});

test('editing: fields change, id and kind do not, and a label collision is resolved', () => {
  const s = state(conn({ id: 'a', label: 'OpenAI' }), conn({ id: 'b', label: 'Local' }));
  const next = updateConnection(s, 'b', { label: 'openai', apiKey: 'k', images: 'send' });
  assert.deepEqual(next.list[1]!, { id: 'b', kind: 'openai-compatible', label: 'openai 2', baseUrl: '', apiKey: 'k', images: 'send' });
  // Renaming a connection to its own name is not a collision with itself.
  assert.equal(updateConnection(s, 'a', { label: 'OpenAI' }).list[0]!.label, 'OpenAI');
  assert.equal(uniqueLabel('  ', s.list), 'Provider');
});

test('editing an id that is gone changes nothing (it was removed in another view)', () => {
  const s = state(conn({ id: 'a' }));
  assert.equal(updateConnection(s, 'zzz', { apiKey: 'k' }), s);
});

test('moving the endpoint drops the cached listing; changing the key does not', () => {
  const cached = conn({ id: 'a', baseUrl: 'http://one/v1', models: { ids: ['m1'], fetchedAt: 1 } });
  assert.equal(updateConnection(state(cached), 'a', { baseUrl: 'http://two/v1' }).list[0]!.models, undefined);
  assert.deepEqual(updateConnection(state(cached), 'a', { apiKey: 'k' }).list[0]!.models, { ids: ['m1'], fetchedAt: 1 });
  assert.deepEqual(updateConnection(state(cached), 'a', { baseUrl: ' http://one/v1 ' }).list[0]!.models, { ids: ['m1'], fetchedAt: 1 });
});

test('removing: only that connection goes, and an unknown id is a no-op', () => {
  const s = state(conn({ id: 'a' }), conn({ id: 'b' }));
  assert.deepEqual(removeConnection(s, 'a').list.map((c) => c.id), ['b']);
  assert.equal(removeConnection(s, 'zzz'), s);
});

test('a typed model id is remembered once, and a listed one is not duplicated', () => {
  let s = state(conn({ id: 'a', models: { ids: ['listed'], fetchedAt: 1 } }));
  s = rememberModel(s, 'a', ' my-finetune ');
  s = rememberModel(s, 'a', 'my-finetune');
  assert.deepEqual(s.list[0]!.extraModels, ['my-finetune']);
  assert.equal(rememberModel(s, 'a', 'listed'), s);
  assert.equal(rememberModel(s, 'a', '  '), s);
  assert.equal(rememberModel(s, 'nope', 'x'), s);
  assert.deepEqual(offeredModels(s.list[0]!), ['my-finetune', 'listed']);
});

// ---------------------------------------------------------------------------
// Connectedness
// ---------------------------------------------------------------------------

test('a key-based connection is connected by a key, or by a keyless endpoint of its own', () => {
  assert.equal(connectionStatus(conn({ id: 'a', kind: 'anthropic', apiKey: 'sk' }), NOT_SIGNED_IN, false), 'connected');
  assert.equal(connectionStatus(conn({ id: 'a', baseUrl: 'http://localhost:11434/v1' }), NOT_SIGNED_IN, false), 'connected');
  assert.equal(connectionStatus(conn({ id: 'a', kind: 'anthropic', baseUrl: 'http://127.0.0.1:8080' }), NOT_SIGNED_IN, false), 'connected');
  assert.equal(connectionStatus(conn({ id: 'a', baseUrl: 'https://llm.corp.example/v1' }), NOT_SIGNED_IN, false), 'connected');
});

test('a hosted API with no key is not connected, whatever its base URL says', () => {
  for (const baseUrl of ['', 'https://api.openai.com/v1', 'https://api.x.ai/v1', 'https://openrouter.ai/api/v1']) {
    assert.equal(connectionStatus(conn({ id: 'a', baseUrl }), NOT_SIGNED_IN, false), 'needs-key', baseUrl || '(default)');
  }
  assert.equal(connectionStatus(conn({ id: 'a', kind: 'anthropic' }), NOT_SIGNED_IN, false), 'needs-key');
  assert.equal(connectionStatus(conn({ id: 'a', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }), NOT_SIGNED_IN, false), 'needs-key');
  assert.equal(connectionStatus(conn({ id: 'a', apiKey: '   ' }), NOT_SIGNED_IN, false), 'needs-key');
  assert.equal(connectionStatus(conn({ id: 'a', baseUrl: 'http://localhost:' }), NOT_SIGNED_IN, false), 'needs-key', 'a half-typed URL is not an endpoint');
});

test('a subscription connection is connected exactly when it is signed in', () => {
  const g = conn({ id: 'g', kind: 'chatgpt' });
  assert.equal(connectionStatus(g, NOT_SIGNED_IN, false), 'signed-out');
  assert.equal(connectionStatus(g, { chatgpt: true, xai: false }, false), 'connected');
  assert.equal(connectionStatus(conn({ id: 'x', kind: 'xai' }), { chatgpt: true, xai: false }, false), 'signed-out');
  // A stale key on a subscription row proves nothing.
  assert.equal(connectionStatus(conn({ id: 'g', kind: 'chatgpt', apiKey: 'k' }), NOT_SIGNED_IN, false), 'signed-out');
});

test('every status has words for Settings', () => {
  assert.equal(statusText('connected'), 'Connected');
  assert.equal(statusText('needs-key'), 'Needs an API key');
  assert.equal(statusText('signed-out'), 'Not signed in');
  assert.equal(statusText('unavailable'), 'Not available in this build');
});

// ---------------------------------------------------------------------------
// The store build
// ---------------------------------------------------------------------------

test('store build: no subscription presets, and none can be added', () => {
  const kinds = presetsFor(true).map((p) => p.kind);
  assert.ok(!kinds.includes('chatgpt') && !kinds.includes('xai'));
  assert.ok(presetsFor(false).some((p) => p.kind === 'chatgpt'));
  assert.ok(presetsFor(false).some((p) => p.kind === 'xai'));
  assert.equal(canAdd('chatgpt', [], true), false);
  assert.equal(canAdd('xai', [], true), false);
});

test('store build: a subscription connection saved by the GitHub build is kept, unavailable, and never in the picker', () => {
  const s = state(
    conn({ id: 'g', kind: 'chatgpt', label: 'ChatGPT subscription', extraModels: ['gpt-5.5'] }),
    conn({ id: 'x', kind: 'xai', label: 'SuperGrok subscription', extraModels: ['grok-4.6'] }),
    conn({ id: 'k', kind: 'anthropic', label: 'Anthropic', apiKey: 'sk', extraModels: ['claude-opus-5'] }),
  );
  // Even signed in — tokens left over from the other build — the store build will not list them.
  assert.equal(connectionStatus(s.list[0]!, SIGNED_IN, true), 'unavailable');
  assert.equal(isConnected(s.list[1]!, SIGNED_IN, true), false);
  assert.deepEqual(pickerGroups(s, SIGNED_IN, '', true).map((g) => g.connection.id), ['k']);
  assert.deepEqual(pickerGroups(s, SIGNED_IN, '', false).map((g) => g.connection.id), ['g', 'x', 'k']);
  // A chat that was on the subscription says so, and does not move to the key-based one.
  const r = resolveSelection({ connectionId: 'g', model: 'gpt-5.5' }, s, SIGNED_IN, true);
  assert.deepEqual(r, { ok: false, problem: 'unavailable', message: problemMessage('unavailable', 'ChatGPT subscription') });
  // A new chat's default skips them.
  assert.deepEqual(defaultSelection(s, { connectionId: 'g', model: 'gpt-5.5' }, SIGNED_IN, true), { connectionId: 'k', model: 'claude-opus-5', label: 'Anthropic' });
});

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

const TWO = state(
  conn({ id: 'a', label: 'Anthropic', kind: 'anthropic', apiKey: 'sk', extraModels: ['claude-opus-5'], models: { ids: ['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5'], fetchedAt: 1 } }),
  conn({ id: 'l', label: 'Local', baseUrl: 'http://localhost:1234/v1', models: { ids: ['qwen3-coder', 'llama-3.3-70b'], fetchedAt: 1 } }),
  conn({ id: 'o', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', extraModels: ['gpt-5'] }),
);

test('the picker lists connected connections only, in Settings order, each with its models', () => {
  const groups = pickerGroups(TWO, NOT_SIGNED_IN, '', false);
  assert.deepEqual(groups.map((g) => g.connection.label), ['Anthropic', 'Local']);
  assert.deepEqual(groups[0]!.models, ['claude-opus-5', 'claude-haiku-4-5', 'claude-sonnet-5']);
  assert.deepEqual(groups[1]!.models, ['qwen3-coder', 'llama-3.3-70b']);
});

test('filtering: every term must match the model id or the connection label, case-insensitively', () => {
  const by = (f: string) => pickerGroups(TWO, NOT_SIGNED_IN, f, false).map((g) => [g.connection.id, g.models]);
  assert.deepEqual(by('SONNET'), [['a', ['claude-sonnet-5']], ['l', []]]);
  assert.deepEqual(by('local'), [['a', []], ['l', ['qwen3-coder', 'llama-3.3-70b']]]);
  assert.deepEqual(by('local qwen'), [['a', []], ['l', ['qwen3-coder']]]);
  assert.deepEqual(by('nothing-matches'), [['a', []], ['l', []]]);
  assert.equal(pickerGroups(TWO, NOT_SIGNED_IN, 'sonnet', false)[1]!.total, 2, 'an empty filtered group still knows it has models');
});

test('a connection that lists nothing is still a group, so an id can be typed for it', () => {
  const s = state(conn({ id: 'l', label: 'Local', baseUrl: 'http://localhost:9/v1' }));
  assert.deepEqual(pickerGroups(s, NOT_SIGNED_IN, '', false), [{ connection: s.list[0]!, models: [], total: 0 }]);
});

// ---------------------------------------------------------------------------
// Model-list caching
// ---------------------------------------------------------------------------

test('a listing is stale when it was never fetched, is a fallback, failed, or is older than the TTL', () => {
  const now = 10 * MODELS_TTL_MS;
  assert.equal(modelsStale(conn({ id: 'a' }), now), true);
  assert.equal(modelsStale(conn({ id: 'a', models: { ids: ['m'], fetchedAt: now - 1000 } }), now), false);
  assert.equal(modelsStale(conn({ id: 'a', models: { ids: ['m'], fetchedAt: now - MODELS_TTL_MS - 1 } }), now), true);
  assert.equal(modelsStale(conn({ id: 'a', models: { ids: ['m'], fetchedAt: now, fallback: true, error: '400' } }), now), true);
  assert.equal(modelsStale(conn({ id: 'a', models: { ids: [], fetchedAt: now, error: 'unreachable' } }), now), true);
});

test('a refresh replaces the cached listing and keeps what the user typed', () => {
  let s = state(conn({ id: 'a', extraModels: ['mine'], models: { ids: ['old'], fetchedAt: 1 } }));
  s = updateConnection(s, 'a', { models: { ids: ['new-1', 'new-2'], fetchedAt: 2 } });
  assert.deepEqual(offeredModels(s.list[0]!), ['mine', 'new-1', 'new-2']);
  // A failed refresh recorded as a fallback is offered too, marked.
  s = updateConnection(s, 'a', { models: { ids: ['built-in'], fetchedAt: 3, fallback: true, error: 'Could not list models (400): x' } });
  assert.deepEqual(offeredModels(s.list[0]!), ['mine', 'built-in']);
  assert.equal(s.list[0]!.models?.fallback, true);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('a selection resolves to its connection and model', () => {
  const r = resolveSelection({ connectionId: 'l', model: ' qwen3-coder ' }, TWO, NOT_SIGNED_IN, false);
  assert.ok(r.ok);
  assert.equal(r.connection.id, 'l');
  assert.equal(r.model, 'qwen3-coder');
  assert.deepEqual(r.selection, { connectionId: 'l', model: 'qwen3-coder', label: 'Local' });
});

test('a model the connection does not list still resolves: endpoints that cannot list are normal', () => {
  assert.ok(resolveSelection({ connectionId: 'l', model: 'typed-by-hand' }, TWO, NOT_SIGNED_IN, false).ok);
});

test('a removed connection is a problem that names it — never a quiet move to another provider', () => {
  const r = resolveSelection({ connectionId: 'gone', model: 'm', label: 'Work proxy' }, TWO, NOT_SIGNED_IN, false);
  assert.deepEqual(r, { ok: false, problem: 'removed', message: 'The provider this chat was using (Work proxy) was removed. Pick another model to continue.' });
  assert.match(problemMessage('removed'), /^The provider this chat was using was removed\./);
});

test('signed out, keyless and model-less selections each say what to do', () => {
  const s = state(conn({ id: 'g', kind: 'chatgpt', label: 'ChatGPT subscription' }), conn({ id: 'o', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }), conn({ id: 'l', label: 'Local', baseUrl: 'http://localhost:1/v1' }));
  const out = (sel: { connectionId: string; model: string }) => {
    const r = resolveSelection(sel, s, NOT_SIGNED_IN, false);
    assert.equal(r.ok, false);
    return r.ok ? null : [r.problem, r.message];
  };
  assert.deepEqual(out({ connectionId: 'g', model: 'gpt-5.5' }), ['signed-out', 'You are signed out of “ChatGPT subscription”. Sign in again in Settings, or pick another model.']);
  assert.deepEqual(out({ connectionId: 'o', model: 'gpt-5' }), ['needs-key', 'OpenAI has no API key. Add one in Settings, or pick another model.']);
  assert.deepEqual(out({ connectionId: 'l', model: '  ' }), ['no-model', 'Pick a model for “Local”.']);
});

test('no selection: asks for a model when something is connected, for a provider when nothing is', () => {
  const some = resolveSelection(null, TWO, NOT_SIGNED_IN, false);
  assert.deepEqual(some, { ok: false, problem: 'none', message: 'Pick a model for this chat.' });
  const none = resolveSelection(undefined, EMPTY_CONNECTIONS, NOT_SIGNED_IN, false);
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.problem, 'no-providers');
  assert.match(!none.ok ? none.message : '', /^Connect a provider in Settings/);
});

test('a new chat defaults to the last model picked', () => {
  assert.deepEqual(defaultSelection(TWO, { connectionId: 'l', model: 'llama-3.3-70b' }, NOT_SIGNED_IN, false), { connectionId: 'l', model: 'llama-3.3-70b', label: 'Local' });
});

test('…and when that can no longer be used, to the first model of the first connected connection', () => {
  assert.deepEqual(defaultSelection(TWO, { connectionId: 'gone', model: 'm' }, NOT_SIGNED_IN, false), { connectionId: 'a', model: 'claude-opus-5', label: 'Anthropic' });
  assert.deepEqual(defaultSelection(TWO, { connectionId: 'o', model: 'gpt-5' }, NOT_SIGNED_IN, false), { connectionId: 'a', model: 'claude-opus-5', label: 'Anthropic' });
  assert.deepEqual(defaultSelection(TWO, null, NOT_SIGNED_IN, false), { connectionId: 'a', model: 'claude-opus-5', label: 'Anthropic' });
});

test('…skipping a connected connection that offers no model, and answering null when none does', () => {
  const s = state(conn({ id: 'l', baseUrl: 'http://localhost:1/v1' }), conn({ id: 'm', label: 'M', baseUrl: 'http://localhost:2/v1', extraModels: ['x'] }));
  assert.deepEqual(defaultSelection(s, null, NOT_SIGNED_IN, false), { connectionId: 'm', model: 'x', label: 'M' });
  assert.equal(defaultSelection(state(s.list[0]!), null, NOT_SIGNED_IN, false), null);
  assert.equal(defaultSelection(EMPTY_CONNECTIONS, null, NOT_SIGNED_IN, false), null);
});

test('a chat with its own selection keeps it even when it is broken; only a chat without one takes the default', () => {
  const last = { connectionId: 'l', model: 'qwen3-coder' };
  const broken = { connectionId: 'gone', model: 'm', label: 'Old' };
  assert.deepEqual(selectionForChat({ model: broken }, TWO, last, NOT_SIGNED_IN, false), broken);
  assert.deepEqual(selectionForChat({}, TWO, last, NOT_SIGNED_IN, false), { ...last, label: 'Local' });
  assert.deepEqual(selectionForChat(null, TWO, last, NOT_SIGNED_IN, false), { ...last, label: 'Local' });
});

test('two selections are the same by connection and model, not by label', () => {
  assert.ok(sameSelection({ connectionId: 'a', model: 'm', label: 'Old name' }, { connectionId: 'a', model: 'm' }));
  assert.ok(!sameSelection({ connectionId: 'a', model: 'm' }, { connectionId: 'b', model: 'm' }));
  assert.ok(!sameSelection({ connectionId: 'a', model: 'm' }, { connectionId: 'a', model: 'n' }));
  assert.ok(!sameSelection(null, null));
});

test('effective settings: the connection and the chat\'s model over the global preferences', () => {
  const prefs = { ...DEFAULT_SETTINGS, theme: 'light' as const, contextBudget: 50_000, autoNameChats: false };
  const c = conn({ id: 'l', baseUrl: ' http://localhost:1234/v1 ', apiKey: ' k ', images: 'never' });
  assert.deepEqual(effectiveSettings(prefs, c, 'qwen3-coder'), {
    ...prefs,
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'k',
    model: 'qwen3-coder',
    images: 'never',
  });
  // A connection with no Images setting must not inherit one from anywhere: it reads as Auto.
  assert.equal(effectiveSettings({ ...prefs, images: 'never' }, conn({ id: 'x' }), 'm').images, undefined);
});
