import { runAgent, type AgentEnv } from '@/lib/agent/loop';
import { buildRegisteredCode, gmValuesKey, loadGmValues, type GmMessage } from '@/lib/gm';
import { fetchText, previewFromUrl, resolveDependencies } from '@/lib/install';
import { loadMods, modFromSource, parseHeader, previewFromSource, upsertMod, deleteMod, saveMods } from '@/lib/mods';
import { createChat, deleteChat, listChats, loadMessages, renameChat, saveMessages, touchChat } from '@/lib/chats';
import {
  CHATGPT_CODEX_BASE,
  XAI_PROXY_BASE,
  chatgptHeaders,
  getValidTokens,
  loadTokens,
  saveTokens,
  startChatgptLogin,
  startXaiLogin,
  xaiProxyHeaders,
  type OAuthKind,
} from '@/lib/oauth';
import type { AgentPortRequest, OAuthLoginState, RpcRequest } from '@/lib/rpc';
import { loadSettings } from '@/lib/settings';
import { looksLikeZip, parseTampermonkeyJson, parseTampermonkeyZipEntries, type TmScript } from '@/lib/tampermonkey';
import type { ContentRequest, Mod, Msg, UserTurn } from '@/lib/types';

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.runtime.onInstalled.addListener(() => void bootstrap());
  chrome.runtime.onStartup.addListener(() => void bootstrap());

  // Registered mods call back here for GM_setValue, GM_xmlhttpRequest and friends. The listener is
  // permanent (not per-run) so it survives the worker sleeping between page loads.
  chrome.runtime.onUserScriptMessage.addListener((msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
    const m = msg as Partial<GmMessage> | null;
    if (!m || m.__usermods !== true || typeof m.modId !== 'string' || typeof m.type !== 'string') return false;
    handleGm(m as GmMessage, sender)
      .then((result) => sendResponse({ result }))
      .catch((e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });

  chrome.runtime.onMessage.addListener((msg: RpcRequest | { type?: string }, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.includes('.')) return false; // not an RPC (e.g. content events)
    handleRpc(msg as RpcRequest)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'agent') return;
    // One session per side panel: a running turn, plus messages queued while it runs.
    let controller: AbortController | null = null;
    let running = false;
    const queue: UserTurn[] = [];
    const post = (e: unknown) => {
      try {
        port.postMessage(e);
      } catch {
        /* panel closed */
      }
    };

    async function run(tabId: number, chatId: string, turn: UserTurn) {
      running = true;
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const settings = await loadSettings();
        const usesKey = settings.provider === 'anthropic' || settings.provider === 'openai-compatible';
        if (usesKey && !settings.apiKey && !settings.baseUrl) throw new Error('Add an API key in Settings first (or a base URL for a local server or proxy).');
        if (!settings.model) throw new Error('Choose a model in Settings first.');
        const history = await loadMessages(chatId);
        // The first message of a chat names it.
        await touchChat(chatId, history.length ? {} : { title: turn.text });
        const messages = await runAgent({
          settings,
          history,
          turn,
          pullQueued: () => queue.splice(0),
          env: envForTab(tabId),
          emit: post,
          signal,
        });
        await saveMessages(chatId, messages);
        await touchChat(chatId);
      } catch (e) {
        post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      running = false;
      // Stop clears the queue; otherwise anything still waiting starts the next turn.
      const next = queue.shift();
      if (next && !signal.aborted) void run(tabId, chatId, next);
      else post({ type: 'done' });
    }

    port.onMessage.addListener((req: AgentPortRequest) => {
      if (req.type === 'abort') {
        for (const q of queue.splice(0)) post({ type: 'unqueued', id: q.id });
        controller?.abort();
        return;
      }
      const turn: UserTurn = { id: req.id, text: req.text, refs: req.refs };
      if (running) queue.push(turn);
      else void run(req.tabId, req.chatId, turn);
    });
    port.onDisconnect.addListener(() => controller?.abort());
  });
});

async function bootstrap() {
  try {
    if (userScriptsAvailable()) {
      await chrome.userScripts.configureWorld({ messaging: true });
      await syncRegistrations();
    }
  } catch (e) {
    console.warn('[usermods] bootstrap', e);
  }
  try {
    await installUserJsRedirect();
  } catch (e) {
    console.warn('[usermods] .user.js redirect', e);
  }
}

/**
 * Clicking a .user.js link should open our install page rather than showing the raw source, which
 * is what Tampermonkey does. \0 in the substitution is the whole matched URL.
 */
const USER_JS_RULE_ID = 1;

async function installUserJsRedirect(): Promise<void> {
  const target = chrome.runtime.getURL('install.html');
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [USER_JS_RULE_ID],
    addRules: [
      {
        id: USER_JS_RULE_ID,
        priority: 1,
        action: { type: 'redirect', redirect: { regexSubstitution: `${target}?url=\\0` } },
        condition: {
          regexFilter: String.raw`^https?://[^?#]+\.user\.js(\?.*)?$`,
          resourceTypes: ['main_frame'],
        },
      },
    ],
  });
}

// ---------- RPC ----------

async function handleRpc(req: RpcRequest): Promise<unknown> {
  switch (req.type) {
    case 'mods.list':
      return loadMods();
    case 'mods.save': {
      const mods = await upsertMod(req.mod);
      await syncRegistrations();
      return mods;
    }
    case 'mods.delete': {
      const mods = await deleteMod(req.id);
      await syncRegistrations();
      return mods;
    }
    case 'mods.toggle': {
      const mods = await loadMods();
      const m = mods.find((x) => x.id === req.id);
      if (m) {
        m.enabled = req.enabled;
        m.updatedAt = Date.now();
      }
      await saveMods(mods);
      await syncRegistrations();
      return mods;
    }
    case 'mods.preview':
      return 'url' in req ? previewFromUrl(req.url) : previewFromSource(req.source);
    case 'mods.install': {
      const mod = await installSource(req.source, { downloadUrl: req.downloadUrl, enabled: req.enabled, values: req.values });
      const mods = await upsertMod(mod);
      await syncRegistrations();
      return mods;
    }
    case 'mods.update':
      return updateMod(req.id);
    case 'mods.importBackup':
      return importBackup(req);
    case 'mods.try': {
      // A saved mod runs exactly as it would on a page load: GM shim, @require bodies, its world.
      if ('modId' in req) {
        const mod = (await loadMods()).find((m) => m.id === req.modId);
        if (!mod) throw new Error('That mod no longer exists.');
        const code = buildRegisteredCode(mod, await loadGmValues(mod.id));
        return executeInTab(req.tabId, code, { world: mod.world });
      }
      return executeInTab(req.tabId, req.code);
    }
    case 'userScripts.status':
      return userScriptsStatus();
    case 'page.pick':
      await sendToContent(req.tabId, { type: 'pick' });
      return { ok: true };
    case 'page.info': {
      const tab = await chrome.tabs.get(req.tabId);
      return { url: tab.url ?? '', title: tab.title ?? '' };
    }
    case 'chats.list':
      return listChats(req.host);
    case 'chats.create':
      return createChat(req.host);
    case 'chats.delete':
      await deleteChat(req.id);
      return { ok: true };
    case 'chats.rename':
      await renameChat(req.id, req.title);
      return { ok: true };
    case 'oauth.status': {
      const t = await loadTokens(req.kind);
      return { signedIn: !!t, label: t?.label };
    }
    case 'oauth.start':
      return startLogin(req.kind);
    case 'oauth.poll':
      return logins.get(req.kind)?.state ?? { status: 'idle' };
    case 'oauth.cancel':
      logins.get(req.kind)?.controller.abort();
      logins.delete(req.kind);
      return { ok: true };
    case 'oauth.signout':
      logins.get(req.kind)?.controller.abort();
      logins.delete(req.kind);
      await saveTokens(req.kind, null);
      return { ok: true };
    case 'models.list':
      return listModels();
  }
}

// ---------- installing outside userscripts ----------

/**
 * Parse a userscript, fetch its dependencies and seed its GM store. Shared by URL install, file
 * import and Tampermonkey migration so all three behave identically.
 */
async function installSource(
  source: string,
  opts: { downloadUrl?: string; enabled?: boolean; values?: Record<string, unknown>; existing?: Mod } = {},
): Promise<Mod> {
  const mod = modFromSource(source, opts.existing);
  if (opts.downloadUrl) mod.downloadUrl = opts.downloadUrl;
  if (opts.enabled !== undefined) mod.enabled = opts.enabled;
  if (!mod.matches.length && !mod.includeGlobs.length) {
    throw new Error(`"${mod.name}" has no @match or @include lines, so it would never run.`);
  }
  await resolveDependencies(mod);
  if (opts.values && Object.keys(opts.values).length) {
    const existing = opts.existing ? await loadGmValues(mod.id) : {};
    await chrome.storage.local.set({ [gmValuesKey(mod.id)]: { ...existing, ...opts.values } });
  }
  return mod;
}

/** Refetch from @downloadURL and swap in the new source when @version moved. */
async function updateMod(id: string): Promise<{ updated: boolean; version: string }> {
  const mods = await loadMods();
  const mod = mods.find((m) => m.id === id);
  if (!mod) throw new Error('That mod no longer exists.');
  if (!mod.downloadUrl) throw new Error(`"${mod.name}" has no @downloadURL, so there is nothing to update from.`);
  const source = await fetchText(mod.downloadUrl);
  if (!/\/\/\s*==UserScript==/.test(source)) throw new Error(`${mod.downloadUrl} did not return a userscript.`);
  const next = parseHeader(source);
  if (next.version && mod.version && next.version === mod.version) return { updated: false, version: mod.version };
  // Keep identity, enabled state and GM values; replace source and dependencies.
  const fresh = await installSource(source, { downloadUrl: mod.downloadUrl, enabled: mod.enabled, existing: mod });
  await upsertMod(fresh);
  await syncRegistrations();
  return { updated: true, version: fresh.version || next.version };
}

/** Import a Tampermonkey backup: JSON text, or a base64-encoded ZIP. */
async function importBackup(req: { json: string } | { zipBase64: string }): Promise<{ imported: number; skipped: string[]; mods: Mod[] }> {
  let parsed: { scripts: TmScript[]; skipped: string[] };
  if ('zipBase64' in req) {
    const bytes = Uint8Array.from(atob(req.zipBase64), (c) => c.charCodeAt(0));
    if (!looksLikeZip(bytes)) throw new Error('That file is not a ZIP archive.');
    const { unzipSync, strFromU8 } = await import('fflate');
    const entries = unzipSync(bytes);
    const text: Record<string, string> = {};
    for (const [path, data] of Object.entries(entries)) {
      if (!data.length) continue;
      try {
        text[path] = strFromU8(data);
      } catch {
        /* binary entry, not a script */
      }
    }
    parsed = parseTampermonkeyZipEntries(text);
  } else {
    parsed = parseTampermonkeyJson(req.json);
  }

  const mods = await loadMods();
  const skipped = [...parsed.skipped];
  let imported = 0;
  for (const s of parsed.scripts) {
    const dupe = mods.find((m) => m.name === s.name && m.version === parseHeader(s.source).version);
    if (dupe) {
      skipped.push(`${s.name} (already installed)`);
      continue;
    }
    try {
      const mod = await installSource(s.source, { downloadUrl: s.downloadUrl, enabled: s.enabled, values: s.values });
      mods.push(mod);
      imported++;
    } catch (e) {
      skipped.push(`${s.name} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  await saveMods(mods);
  await syncRegistrations();
  return { imported, skipped, mods };
}

// ---------- GM API host ----------

/** Re-register a mod shortly after its GM store changes, so the next page load sees new values. */
const gmResyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleResync(modId: string): void {
  clearTimeout(gmResyncTimers.get(modId));
  gmResyncTimers.set(
    modId,
    setTimeout(() => {
      gmResyncTimers.delete(modId);
      void syncRegistrations();
    }, 500),
  );
}

async function handleGm(msg: GmMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'gm.setValue':
    case 'gm.deleteValue': {
      const key = gmValuesKey(msg.modId);
      const values = await loadGmValues(msg.modId);
      if (msg.type === 'gm.setValue') values[String(msg.key)] = msg.value;
      else delete values[String(msg.key)];
      await chrome.storage.local.set({ [key]: values });
      scheduleResync(msg.modId);
      return true;
    }
    case 'gm.xhr': {
      const d = msg.details;
      if (!d?.url) throw new Error('GM_xmlhttpRequest needs a url');
      const controller = new AbortController();
      const timer = d.timeout ? setTimeout(() => controller.abort(), d.timeout) : undefined;
      try {
        const res = await fetch(d.url, {
          method: d.method || 'GET',
          headers: d.headers ?? {},
          body: d.data ?? null,
          signal: controller.signal,
          credentials: 'omit',
        });
        const responseText = await res.text();
        const responseHeaders = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n');
        let response: unknown = responseText;
        if (d.responseType === 'json') {
          try {
            response = JSON.parse(responseText) as unknown;
          } catch {
            response = null;
          }
        }
        return { status: res.status, statusText: res.statusText, responseHeaders, responseText, response, finalUrl: res.url || d.url };
      } finally {
        clearTimeout(timer);
      }
    }
    case 'gm.openInTab': {
      if (!msg.url) throw new Error('GM_openInTab needs a url');
      const tab = await chrome.tabs.create({ url: msg.url, active: msg.active !== false, openerTabId: sender.tab?.id });
      return { id: tab.id };
    }
    case 'gm.log':
      console.log(`[usermods ${msg.modId}]`, ...(msg.args ?? []));
      return true;
    default:
      throw new Error(`Unknown GM call: ${String((msg as { type: string }).type)}`);
  }
}

// ---------- subscription sign-in (device code) ----------

const logins = new Map<OAuthKind, { state: OAuthLoginState; controller: AbortController }>();

async function startLogin(kind: OAuthKind): Promise<OAuthLoginState> {
  logins.get(kind)?.controller.abort();
  const controller = new AbortController();
  const entry = { state: { status: 'idle' } as OAuthLoginState, controller };
  logins.set(kind, entry);
  try {
    const login = kind === 'chatgpt' ? await startChatgptLogin() : await startXaiLogin();
    entry.state = { status: 'pending', userCode: login.userCode, verificationUri: login.verificationUri, expiresAt: login.expiresAt };
    void login
      .poll(controller.signal)
      .then(async (tokens) => {
        await saveTokens(kind, tokens);
        entry.state = { status: 'done' };
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        entry.state = { status: 'error', message: e instanceof Error ? e.message : String(e) };
      });
  } catch (e) {
    entry.state = { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  return entry.state;
}

/** Model ids for the configured provider, where the backend can list them. */
async function listModels(): Promise<string[]> {
  const s = await loadSettings();
  let url: string;
  let headers: Record<string, string>;
  switch (s.provider) {
    case 'chatgpt':
      url = `${(s.baseUrl || CHATGPT_CODEX_BASE).replace(/\/+$/, '')}/models`;
      headers = chatgptHeaders(await getValidTokens('chatgpt'));
      break;
    case 'xai': {
      const t = await getValidTokens('xai');
      url = `${(s.baseUrl || XAI_PROXY_BASE).replace(/\/+$/, '')}/models`;
      const h = xaiProxyHeaders('', t.access);
      delete h['x-grok-model-override'];
      headers = h;
      break;
    }
    case 'openai-compatible':
      url = `${(s.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/models`;
      headers = s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {};
      break;
    case 'anthropic':
      url = `${(s.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/models?limit=100`;
      headers = { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' };
      break;
  }
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Could not list models: ${r.status}`);
  const body = (await r.json()) as { data?: Array<{ id?: string; slug?: string }>; models?: Array<{ id?: string; slug?: string }> };
  const entries = body.data ?? body.models ?? [];
  return entries.map((m) => m.id ?? m.slug ?? '').filter(Boolean).sort();
}

// ---------- userScripts ----------

function userScriptsAvailable(): boolean {
  try {
    // Throws when the permission toggle is off.
    chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

function userScriptsStatus(): { available: boolean; message: string } {
  if (userScriptsAvailable()) return { available: true, message: '' };
  const version = Number(navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/)?.[1] ?? 0);
  const message =
    version >= 138
      ? 'usermods needs the "Allow User Scripts" toggle.\n1. Open chrome://extensions\n2. Click Details on usermods\n3. Turn on "Allow User Scripts"'
      : 'usermods needs Developer Mode.\n1. Open chrome://extensions\n2. Turn on "Developer mode" (top right)';
  return { available: false, message };
}

async function syncRegistrations(): Promise<void> {
  if (!userScriptsAvailable()) return;
  const mods = await loadMods();
  const existing = await chrome.userScripts.getScripts();
  if (existing.length) await chrome.userScripts.unregister({ ids: existing.map((s) => s.id) });
  // register() rejects a script with neither matches nor includeGlobs, which would take the whole
  // batch down with it, so those are dropped here.
  const enabled = mods.filter((m) => m.enabled && (m.matches.length || m.includeGlobs.length));
  if (!enabled.length) return;
  const scripts = await Promise.all(
    enabled.map(async (m) => ({
      id: m.id,
      js: [{ code: buildRegisteredCode(m, await loadGmValues(m.id)) }],
      ...(m.matches.length ? { matches: m.matches } : {}),
      ...(m.excludeMatches.length ? { excludeMatches: m.excludeMatches } : {}),
      ...(m.includeGlobs.length ? { includeGlobs: m.includeGlobs } : {}),
      ...(m.excludeGlobs.length ? { excludeGlobs: m.excludeGlobs } : {}),
      runAt: m.runAt,
      world: m.world,
      allFrames: m.allFrames,
    })),
  );
  await chrome.userScripts.register(scripts);
}

/**
 * Run code once in a tab, in the USER_SCRIPT world. The wrapper captures console output and the
 * final value (awaiting promises), then reports back over runtime messaging so async code works.
 */
async function executeInTab(tabId: number, code: string, opts: { world?: Mod['world']; timeoutMs?: number } = {}) {
  const { world = 'USER_SCRIPT', timeoutMs = 20_000 } = opts;
  const status = userScriptsStatus();
  if (!status.available) throw new Error(status.message);
  const runId = crypto.randomUUID();
  const wrapped = `(async () => {
    const __logs = [];
    const __fmt = (a) => a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ');
    const __console = globalThis.console;
    const console = { ...__console, log: (...a) => { __logs.push(__fmt(a)); __console.log(...a); }, info: (...a) => { __logs.push(__fmt(a)); __console.info(...a); }, warn: (...a) => { __logs.push('warn: ' + __fmt(a)); __console.warn(...a); }, error: (...a) => { __logs.push('error: ' + __fmt(a)); __console.error(...a); } };
    let __out;
    try {
      const __r = await (async () => { ${code}\n })();
      let __s; try { __s = typeof __r === 'string' ? __r : JSON.stringify(__r); } catch { __s = String(__r); }
      __out = { ok: true, result: __s === undefined ? 'undefined' : String(__s).slice(0, 4000), logs: __logs };
    } catch (e) {
      __out = { ok: false, error: (e && e.stack) ? String(e.stack).slice(0, 2000) : String(e), logs: __logs };
    }
    try { chrome.runtime.sendMessage({ type: 'usermods:run-result', runId: ${JSON.stringify(runId)}, ...__out }); } catch {}
    return __out;
  })()`;

  const result = new Promise<{ ok: boolean; result?: string; logs: string[]; error?: string }>((resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onUserScriptMessage.removeListener(listener);
      resolve({ ok: false, error: `Timed out after ${timeoutMs / 1000}s (the script may still be running).`, logs: [] });
    }, timeoutMs);
    const listener = (msg: { type?: string; runId?: string } & Record<string, unknown>) => {
      if (msg?.type !== 'usermods:run-result' || msg.runId !== runId) return;
      clearTimeout(timer);
      chrome.runtime.onUserScriptMessage.removeListener(listener);
      resolve({ ok: !!msg.ok, result: msg.result as string | undefined, logs: (msg.logs as string[]) ?? [], error: msg.error as string | undefined });
    };
    chrome.runtime.onUserScriptMessage.addListener(listener);
  });

  await chrome.userScripts.execute({ target: { tabId }, js: [{ code: wrapped }], world });
  return result;
}

// ---------- content script plumbing ----------

async function sendToContent<T = unknown>(tabId: number, req: ContentRequest): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, req)) as T;
  } catch {
    // Content script not present (tab opened before install, or a reload). Inject and retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] });
    return (await chrome.tabs.sendMessage(tabId, req)) as T;
  }
}

function envForTab(tabId: number): AgentEnv {
  return {
    sendToContent: (req) => sendToContent(tabId, req as ContentRequest),
    runScript: (code) => executeInTab(tabId, code),
    async screenshot() {
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
      return { mediaType: 'image/jpeg', data: dataUrl.replace(/^data:image\/jpeg;base64,/, '') };
    },
    async pageInfo() {
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url ?? '', title: tab.title ?? '' };
    },
  };
}
