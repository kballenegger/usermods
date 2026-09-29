// Listing models: the request each backend needs, the response shapes they answer with, and what
// happens when a listing fails. The ChatGPT cases are the regression for "400 error listing chatgpt
// models after login": the Codex backend requires ?client_version=, as the open-source CLI sends it
// (codex-rs/codex-api/src/endpoint/models.rs).
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHATGPT_CLIENT_VERSION,
  FALLBACK_MODELS,
  errorDetail,
  fallbackModels,
  listFailureMessage,
  listWithFallback,
  modelsRequest,
  parseModelIds,
} from '../lib/modellist.ts';

// What lib/oauth's chatgptHeaders() returns, restated: that module needs chrome.storage to load.
const CHATGPT_AUTH = {
  authorization: 'Bearer access-token',
  'chatgpt-account-id': 'acct-123',
  'openai-beta': 'responses=experimental',
  originator: 'usermods',
};
const XAI_AUTH = {
  authorization: 'Bearer xai-access',
  'x-grok-client-identifier': 'usermods',
  'x-grok-client-version': '0.2.101',
  'x-grok-client-mode': 'interactive',
  'x-xai-token-auth': 'xai-grok-cli',
  'x-authenticateresponse': 'authenticate-response',
  'x-grok-model-override': '',
};

// ---------- the request ----------

test('chatgpt: the listing carries client_version, which the Codex backend answers 400 without', () => {
  const { url } = modelsRequest({ kind: 'chatgpt', baseUrl: '', apiKey: '' }, CHATGPT_AUTH);
  assert.equal(url, `https://chatgpt.com/backend-api/codex/models?client_version=${CHATGPT_CLIENT_VERSION}`);
});

test('chatgpt: client_version is a whole MAJOR.MINOR.PATCH, as client_version_to_whole() produces', () => {
  assert.match(CHATGPT_CLIENT_VERSION, /^\d+\.\d+\.\d+$/);
});

test('chatgpt: bearer token and account id are sent; the Responses beta flag is not', () => {
  const { headers } = modelsRequest({ kind: 'chatgpt', baseUrl: '', apiKey: '' }, CHATGPT_AUTH);
  assert.equal(headers.authorization, 'Bearer access-token');
  assert.equal(headers['chatgpt-account-id'], 'acct-123');
  assert.equal(headers.originator, 'usermods');
  assert.equal(headers.accept, 'application/json');
  assert.ok(!('openai-beta' in headers), 'the CLI does not send openai-beta to /models');
});

test('chatgpt: a base URL override is honoured, trailing slashes and an existing query included', () => {
  assert.equal(
    modelsRequest({ kind: 'chatgpt', baseUrl: 'http://127.0.0.1:9/codex//', apiKey: '' }).url,
    `http://127.0.0.1:9/codex/models?client_version=${CHATGPT_CLIENT_VERSION}`,
  );
  assert.equal(
    modelsRequest({ kind: 'chatgpt', baseUrl: 'http://127.0.0.1:9/codex?route=eu', apiKey: '' }).url,
    `http://127.0.0.1:9/codex/models?route=eu&client_version=${CHATGPT_CLIENT_VERSION}`,
  );
});

test('the auth headers handed in are not mutated', () => {
  const auth = { ...CHATGPT_AUTH };
  modelsRequest({ kind: 'chatgpt', baseUrl: '', apiKey: '' }, auth);
  assert.deepEqual(auth, CHATGPT_AUTH);
  const xai = { ...XAI_AUTH };
  modelsRequest({ kind: 'xai', baseUrl: '', apiKey: '' }, xai);
  assert.deepEqual(xai, XAI_AUTH);
});

test('xai: the proxy listing keeps the client headers and drops the model override', () => {
  const { url, headers } = modelsRequest({ kind: 'xai', baseUrl: '', apiKey: '' }, XAI_AUTH);
  assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/models');
  assert.equal(headers.authorization, 'Bearer xai-access');
  assert.equal(headers['x-grok-client-version'], '0.2.101');
  assert.equal(headers['x-xai-token-auth'], 'xai-grok-cli');
  assert.ok(!('x-grok-model-override' in headers), 'an empty override is not the same as none');
});

test('openai-compatible: {base}/models, with a bearer key only when there is one', () => {
  assert.deepEqual(modelsRequest({ kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1/', apiKey: '' }), {
    url: 'http://localhost:1234/v1/models',
    headers: {},
  });
  assert.deepEqual(modelsRequest({ kind: 'openai-compatible', baseUrl: '', apiKey: 'sk-x' }), {
    url: 'https://api.openai.com/v1/models',
    headers: { authorization: 'Bearer sk-x' },
  });
});

test('anthropic: {base}/v1/models?limit=100 with the key and version headers', () => {
  assert.deepEqual(modelsRequest({ kind: 'anthropic', baseUrl: '', apiKey: 'sk-ant' }), {
    url: 'https://api.anthropic.com/v1/models?limit=100',
    headers: { 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' },
  });
  assert.equal(modelsRequest({ kind: 'anthropic', baseUrl: 'http://localhost:8080/', apiKey: '' }).url, 'http://localhost:8080/v1/models?limit=100');
});

// ---------- the response ----------

/** The shape of codex-rs/protocol ModelsResponse, cut down to the fields that matter plus noise. */
const CODEX_CATALOG = {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12, supported_in_api: true, context_window: 272000 },
    { slug: 'codex-auto-review', display_name: 'Auto review', visibility: 'hide', priority: 43, supported_in_api: true },
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', priority: 1, supported_in_api: true },
    { slug: 'gpt-internal', display_name: 'Internal', visibility: 'none', priority: 2, supported_in_api: false },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 6, supported_in_api: true },
  ],
};

test('a Codex catalog: slugs, hidden models left out, the catalog\'s own priority order kept', () => {
  assert.deepEqual(parseModelIds(CODEX_CATALOG), ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5']);
});

test('an OpenAI-style list: ids, sorted', () => {
  assert.deepEqual(parseModelIds({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }, { id: 'davinci' }, { id: 'gpt-5' }] }), ['davinci', 'gpt-5']);
});

test('an Anthropic list reads the same way', () => {
  assert.deepEqual(parseModelIds({ data: [{ type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' }], has_more: false }), ['claude-opus-5']);
});

test('tolerated odd shapes: a bare array, name-only entries, plain strings', () => {
  assert.deepEqual(parseModelIds([{ id: 'b' }, { id: 'a' }]), ['a', 'b']);
  assert.deepEqual(parseModelIds({ models: [{ name: 'llama3:8b' }] }), ['llama3:8b']);
  assert.deepEqual(parseModelIds({ data: ['x', ' y '] }), ['x', 'y']);
});

test('garbage answers an empty list rather than throwing', () => {
  for (const body of [null, undefined, 'nope', 42, {}, { data: 'x' }, { data: [null, {}, { id: '' }, { id: 7 }] }]) {
    assert.deepEqual(parseModelIds(body), []);
  }
});

// ---------- failures ----------

test('the error message carries what the server said, not just the status', () => {
  assert.equal(
    listFailureMessage(400, JSON.stringify({ detail: 'Missing required query parameter: client_version' })),
    'Could not list models (400): Missing required query parameter: client_version',
  );
  assert.equal(listFailureMessage(401, JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } })), 'Could not list models (401): Incorrect API key provided');
  assert.equal(listFailureMessage(403, JSON.stringify({ error: 'forbidden' })), 'Could not list models (403): forbidden');
  assert.equal(listFailureMessage(500, JSON.stringify({ message: 'boom' })), 'Could not list models (500): boom');
  assert.equal(listFailureMessage(502, 'Bad gateway\n'), 'Could not list models (502): Bad gateway');
});

test('a structured FastAPI detail is shown as JSON rather than [object Object]', () => {
  assert.equal(errorDetail(JSON.stringify({ detail: [{ loc: ['query', 'client_version'], msg: 'field required' }] })), '[{"loc":["query","client_version"],"msg":"field required"}]');
});

test('an empty body or an HTML error page adds nothing; a long body is cut', () => {
  assert.equal(listFailureMessage(404, ''), 'Could not list models (404).');
  assert.equal(listFailureMessage(503, '<!doctype html><html><body>Service unavailable</body></html>'), 'Could not list models (503).');
  const long = errorDetail('x'.repeat(1000));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
});

// ---------- the fallback ----------

test('only the subscription kinds have a built-in list', () => {
  assert.deepEqual(fallbackModels('chatgpt'), [...FALLBACK_MODELS.chatgpt]);
  assert.deepEqual(fallbackModels('xai'), [...FALLBACK_MODELS.xai]);
  assert.deepEqual(fallbackModels('anthropic'), []);
  assert.deepEqual(fallbackModels('openai-compatible'), []);
  assert.ok(FALLBACK_MODELS.chatgpt.length > 0 && FALLBACK_MODELS.xai.length > 0);
});

test('a listing that works is returned as is, and is not marked as a fallback', async () => {
  assert.deepEqual(await listWithFallback('chatgpt', async () => ['gpt-x']), { models: ['gpt-x'], fallback: false });
});

test('a subscription listing that fails answers the built-in list, marked, with the reason', async () => {
  const r = await listWithFallback('chatgpt', async () => {
    throw new Error(listFailureMessage(400, '{"detail":"nope"}'));
  });
  assert.deepEqual(r, { models: [...FALLBACK_MODELS.chatgpt], fallback: true, error: 'Could not list models (400): nope' });
});

test('a subscription listing that comes back empty also falls back', async () => {
  const r = await listWithFallback('xai', async () => []);
  assert.equal(r.fallback, true);
  assert.deepEqual(r.models, [...FALLBACK_MODELS.xai]);
  assert.equal(r.error, 'The backend returned no models.');
});

test('a key-based listing that fails throws: nobody can guess a local server\'s models', async () => {
  await assert.rejects(
    listWithFallback('openai-compatible', async () => {
      throw new Error('Could not list models (401): bad key');
    }),
    /bad key/,
  );
  assert.deepEqual(await listWithFallback('anthropic', async () => []), { models: [], fallback: false });
});
