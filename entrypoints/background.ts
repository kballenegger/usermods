import { runAgent, type AgentEnv } from '@/lib/agent/loop';
import { buildRegisteredCode, gmValuesKey, loadGmValues, type GmMessage } from '@/lib/gm';
import { checkConnect, connectOf } from '@/lib/connect';
import { fetchText, previewFromUrl, resolveDependencies, toBase64 } from '@/lib/install';
import { UPDATED_MARK } from '@/lib/importreport';
import { scriptIdentity } from '@/lib/installurl';
import { resyncPlan } from '@/lib/resync';
import { mapStack, prepareRunScript, renderRunResult, type RunResult } from '@/lib/runscript';
import { shouldUpdate } from '@/lib/version';
import { loadMods, modFromSource, parseHeader, previewFromSource, upsertMod, deleteMod, saveMods } from '@/lib/mods';
import { appendTurn, archiveChat, createChat, deleteChat, getChat, listChats, loadMessages, markTitleRefreshed, renameChat, saveMessages, setModelTitle, touchChat } from '@/lib/chats';
import { buildTitleInput, completedTurns, sanitizeTitle, titleDecision, TITLE_SYSTEM_PROMPT } from '@/lib/title';
import { createProvider } from '@/lib/providers';
import {
  CHATGPT_CODEX_BASE,
  STORE_BUILD,
  XAI_PROXY_BASE,
  unavailableProviderMessage,
} from '@/lib/buildflags';
import type { OAuthKind } from '@/lib/oauth';
import type { AgentPortRequest, OAuthLoginState, RpcRequest } from '@/lib/rpc';
import { SessionMap } from '@/lib/sessions';
import { loadSettings } from '@/lib/settings';
import { looksLikeZip, parseTampermonkeyJson, parseTampermonkeyZipEntries, type TmScript } from '@/lib/tampermonkey';
import type { AgentEvent, AgentEventBody, ContentRequest, Mod, Msg, Part, Settings, UserTurn } from '@/lib/types';

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
    // A registered mod's GM shim connects as "gm:<modId>" to hear about value changes made by the
    // same mod running in another tab or frame.
    if (port.name.startsWith('gm:')) return registerGmPort(port);
    if (port.name !== 'agent') return;
    agentPorts.add(port);
    port.onMessage.addListener((req: AgentPortRequest) => {
      if (req.type === 'abort') {
        // Only this chat. Stop used to abort whatever the port last started, which meant pressing
        // Stop in the chat you were reading killed a run belonging to a different tab.
        for (const id of sessions.abort(req.chatId)) postAgentEvent(req.chatId, { type: 'unqueued', id });
        return;
      }
      const turn: UserTurn = { id: req.id, text: req.text, refs: req.refs };
      const { start } = sessions.accept(req.chatId, req.tabId, turn);
      if (start) void runChat(req.chatId, req.tabId, turn);
    });
    // The panel going away does NOT stop a run. History and the transcript are both keyed by chat
    // id and written by the background, so a run that finishes with no panel attached still lands
    // in the right chat; killing it instead would throw away work the moment the user switched to
    // a window without the side panel. Events posted meanwhile go nowhere, and the panel says
    // "reconnected" when it comes back to a transcript that stops mid-turn.
    port.onDisconnect.addListener(() => agentPorts.delete(port));
  });
});

// ---------- agent sessions ----------

/**
 * One run per chat, not one per panel. See lib/sessions.ts for why. The map is module-scoped so a
 * run survives the side panel closing and reopening (the panel reconnects and picks the stream up
 * by chat id).
 */
const sessions = new SessionMap();

/** Every open side-panel port. A chat's events go to all of them; each panel routes by chat id. */
const agentPorts = new Set<chrome.runtime.Port>();

/**
 * The single chokepoint where an agent event is stamped with its chat and put on the wire. The
 * agent loop emits AgentEventBody, which has no chat id at all, so no emitter can forget one.
 */
function postAgentEvent(chatId: string, body: AgentEventBody): void {
  const event: AgentEvent = { ...body, chatId };
  for (const port of agentPorts) {
    try {
      port.postMessage(event);
    } catch {
      /* that panel closed; others still get it */
    }
  }
}

async function runChat(chatId: string, tabId: number, turn: UserTurn): Promise<void> {
  const session = sessions.ensure(chatId, tabId);
  session.running = true;
  session.controller = new AbortController();
  const signal = session.controller.signal;
  const post = (e: AgentEventBody) => postAgentEvent(chatId, e);
  // Only a turn that finished cleanly is worth naming: an aborted or failed one has nothing
  // the model could summarise, and the user's own message is already the placeholder title.
  let succeeded = false;
  let settings: Settings | null = null;
  // Held outside the try so the catch can still write the conversation back. runAgent only
  // returns messages on success, so a provider error (429, a bad key) would otherwise leave
  // the whole chat unsaved and the user's turn lost.
  let history: Msg[] = [];
  try {
    settings = await loadSettings();
    const usesKey = settings.provider === 'anthropic' || settings.provider === 'openai-compatible';
    if (usesKey && !settings.apiKey && !settings.baseUrl) throw new Error('Add an API key in Settings first (or a base URL for a local server or proxy).');
    if (!settings.model) throw new Error('Choose a model in Settings first.');
    history = await loadMessages(chatId);
    // The first message of a chat names it.
    await touchChat(chatId, history.length ? {} : { title: turn.text });
    const messages = await runAgent({
      settings,
      history,
      turn,
      pullQueued: () => session.queue.splice(0),
      env: envForTab(session.tabId),
      emit: post,
      signal,
    });
    await saveMessages(chatId, messages);
    await touchChat(chatId);
    succeeded = !signal.aborted;
  } catch (e) {
    // Keep everything that was already in the chat, plus the turn that failed, so retrying
    // does not start from nothing. Partial assistant output inside the failed run is lost;
    // loop.ts should later attach its messages to the thrown error so we can keep those too.
    try {
      await saveMessages(chatId, appendTurn(history, turn));
      await touchChat(chatId);
    } catch {
      /* storage failed too; the error below is still reported */
    }
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
  session.running = false;
  // Stop clears the queue; otherwise anything still waiting starts the next turn.
  const next = session.queue.shift();
  if (next && !signal.aborted) {
    void runChat(chatId, session.tabId, next);
  } else {
    // The panel's activity line watches for this: 'idle' is what makes this chat's indicator
    // disappear. It goes through the same post() as everything else, so it is stamped with this
    // chat's id and cannot switch off the indicator of a chat that is still running.
    post({ type: 'status', phase: 'idle', detail: 'done' });
    post({ type: 'done' });
    sessions.release(chatId);
    // Naming the chat is a second, tool-free model call. It runs only after 'done' has been
    // posted and its result is never awaited by the turn, so a slow or failing title call cannot
    // delay, break or fail what the user actually asked for. Errors are swallowed and logged.
    // It posts through this chat's own post(), so the rename lands on this chat and no other.
    if (succeeded && settings) void nameChat(chatId, settings, post);
  }
}

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
 *
 * The matched URL goes in the FRAGMENT, not a query parameter. A query parameter is parsed by the
 * install page, so an attacker URL carrying its own `&url=…` would decide what the page previewed;
 * everything after the first '#' is taken verbatim instead, which nothing can smuggle past. It also
 * means a script URL with a fragment of its own survives, because we never parse the remainder.
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
        action: { type: 'redirect', redirect: { regexSubstitution: `${target}#\\0` } },
        condition: {
          regexFilter: String.raw`^https?://[^?#]+\.user\.js([?#].*)?$`,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ['main_frame'],
        },
      },
    ],
  });
}

// ---------- chat titles ----------

/**
 * One tool-free model call: ask the provider for a short answer to a system prompt.
 *
 * This deliberately reuses Provider.chat with an empty tool list rather than adding a method to the
 * Provider interface — every adapter already omits the tools field when there are none, so all four
 * backends get this for free and none of them grew an API.
 */
async function complete(settings: Settings, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const res = await createProvider(settings).chat({
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    tools: [],
    signal,
    callbacks: { onText: () => {} },
  });
  return res.content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
}

/** A title call that hangs must not keep the worker alive, so it gets its own deadline. */
const TITLE_TIMEOUT_MS = 20_000;

/**
 * Give the chat a model-written name, if it is due one.
 *
 * Called after 'done' has already been posted, so nothing here is on the user's critical path.
 * Every failure — no provider, a 429, a nonsense reply, the chat being deleted meanwhile — leaves
 * the existing title in place and is logged, never surfaced as a chat error.
 */
async function nameChat(chatId: string, settings: Settings, post: (e: AgentEventBody) => void): Promise<void> {
  try {
    if (settings.autoNameChats === false) return;
    const chat = await getChat(chatId);
    const messages = await loadMessages(chatId);
    const decision = titleDecision(chat, completedTurns(messages), true);
    if (decision.kind === 'none') return;
    const refresh = decision.kind === 'refresh';
    // The first title reads the whole first exchange; the refresh reads what the chat has become,
    // which is the last three things the user asked for.
    const input = buildTitleInput(messages, refresh ? { userMessages: 3, includeAssistant: false } : { userMessages: 1, includeAssistant: true });
    if (!input) return;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TITLE_TIMEOUT_MS);
    let raw: string;
    try {
      raw = await complete(settings, TITLE_SYSTEM_PROMPT, input, ac.signal);
    } finally {
      clearTimeout(timer);
    }

    const title = sanitizeTitle(raw);
    // An empty or refusal-shaped reply means keep what we have. The refresh is still spent, so a
    // model that will not name this chat is not asked again on every later turn.
    if (!title) {
      if (refresh) await markTitleRefreshed(chatId);
      return;
    }
    const stored = await setModelTitle(chatId, title, { refresh });
    // The panel may be closed, in which case the title is simply stored and read back next open.
    if (stored) post({ type: 'chat_title', title: stored });
  } catch (e) {
    console.warn('[usermods] chat title', e);
  }
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
        return legacyRunShape(await executeInTab(req.tabId, code, { world: mod.world, raw: true }));
      }
      return legacyRunShape(await executeInTab(req.tabId, req.code, { raw: true }));
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
    case 'chats.archive':
      await archiveChat(req.id, req.archived);
      return { ok: true };
    case 'chats.rename':
      await renameChat(req.id, req.title);
      return { ok: true };
    case 'oauth.status': {
      if (STORE_BUILD) return { signedIn: false };
      const t = await (await oauthModule()).loadTokens(req.kind);
      return { signedIn: !!t, label: t?.label };
    }
    case 'oauth.start':
      if (STORE_BUILD) return { status: 'error', message: unavailableProviderMessage(req.kind) };
      return startLogin(req.kind);
    case 'oauth.poll':
      if (STORE_BUILD) return { status: 'error', message: unavailableProviderMessage(req.kind) };
      return logins.get(req.kind)?.state ?? { status: 'idle' };
    case 'oauth.cancel':
      if (STORE_BUILD) return { ok: true };
      logins.get(req.kind)?.controller.abort();
      logins.delete(req.kind);
      return { ok: true };
    case 'oauth.signout':
      if (STORE_BUILD) return { ok: true };
      logins.get(req.kind)?.controller.abort();
      logins.delete(req.kind);
      await (await oauthModule()).saveTokens(req.kind, null);
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

/** Refetch from @downloadURL and swap in the new source when the remote @version is newer. */
async function updateMod(id: string): Promise<{ updated: boolean; version: string }> {
  const mods = await loadMods();
  const mod = mods.find((m) => m.id === id);
  if (!mod) throw new Error('That mod no longer exists.');
  if (!mod.downloadUrl) throw new Error(`"${mod.name}" has no @downloadURL, so there is nothing to update from.`);
  const source = await fetchText(mod.downloadUrl);
  if (!/\/\/\s*==UserScript==/.test(source)) throw new Error(`${mod.downloadUrl} did not return a userscript.`);
  const next = parseHeader(source);
  // Versions are compared ordinally, so a downgrade (1.9 published after 1.10 was installed, or a
  // rolled-back file) does not overwrite what is installed. With no version on either side there
  // is nothing to order by, so the source text decides.
  if (!shouldUpdate({ version: mod.version, source: mod.source }, { version: next.version, source })) {
    return { updated: false, version: mod.version || next.version };
  }
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
  // Identity is @downloadURL, else @namespace + @name — never name + version, which treated every
  // new version of a script as a different script and installed a second copy of it.
  const byIdentity = new Map<string, Mod>();
  for (const m of mods) {
    byIdentity.set(scriptIdentity({ downloadUrl: m.downloadUrl, raw: parseHeader(m.source).raw, name: m.name }), m);
  }

  for (const s of parsed.scripts) {
    const header = parseHeader(s.source);
    const existing = byIdentity.get(scriptIdentity({ downloadUrl: s.downloadUrl, raw: header.raw, name: s.name }));
    try {
      // A duplicate updates in place: same mod id, so its registration and its gm:<id> store are
      // kept, and the backup's values are merged over what is there (the backup wins for the keys
      // it carries, other keys survive).
      const mod = await installSource(s.source, { downloadUrl: s.downloadUrl, enabled: s.enabled, values: s.values, existing });
      if (existing) {
        const i = mods.findIndex((m) => m.id === existing.id);
        if (i >= 0) mods[i] = mod;
        else mods.push(mod);
        skipped.push(`${s.name} (already installed — ${UPDATED_MARK})`);
      } else {
        mods.push(mod);
        imported++;
      }
      byIdentity.set(scriptIdentity({ downloadUrl: mod.downloadUrl, raw: parseHeader(mod.source).raw, name: mod.name }), mod);
    } catch (e) {
      skipped.push(`${s.name} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  await saveMods(mods);
  await syncRegistrations();
  return { imported, skipped, mods };
}

// ---------- GM API host ----------

/**
 * Re-register a mod after its GM store changes, so a page loaded later sees the new values.
 * Only that mod is updated: a full syncRegistrations() unregisters and re-registers every script,
 * which is both slower and a window in which nothing is registered. Install, delete and toggle
 * still go through the full sync, because those change which scripts exist.
 */
const gmResyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleResync(modId: string): void {
  clearTimeout(gmResyncTimers.get(modId));
  gmResyncTimers.set(
    modId,
    setTimeout(() => {
      gmResyncTimers.delete(modId);
      void resyncOne(modId);
    }, 500),
  );
}

async function resyncOne(modId: string): Promise<void> {
  if (!userScriptsAvailable()) return;
  try {
    const mod = (await loadMods()).find((m) => m.id === modId);
    const registered = (await chrome.userScripts.getScripts({ ids: [modId] })).length > 0;
    const plan = resyncPlan(mod, registered);
    if (plan === 'none') return;
    if (plan === 'full') return void (await syncRegistrations());
    await chrome.userScripts.update([{ id: modId, js: [{ code: buildRegisteredCode(mod!, await loadGmValues(modId)) }] }]);
  } catch (e) {
    console.warn('[usermods] resync', modId, e);
  }
}

// ---------- live GM value changes (CONTRACT C3) ----------

/**
 * Open ports, per mod. A registered script in the USER_SCRIPT world connects as `gm:<modId>`;
 * when one frame writes a value, every OTHER frame running that mod is told, so
 * GM_addValueChangeListener fires with remote: true the way Tampermonkey's does.
 */
const gmPorts = new Map<string, Set<chrome.runtime.Port>>();

function registerGmPort(port: chrome.runtime.Port): void {
  const modId = port.name.slice('gm:'.length);
  if (!modId) return;
  let set = gmPorts.get(modId);
  if (!set) gmPorts.set(modId, (set = new Set()));
  set.add(port);
  port.onDisconnect.addListener(() => {
    const current = gmPorts.get(modId);
    if (!current) return;
    current.delete(port);
    if (!current.size) gmPorts.delete(modId);
  });
}

function broadcastValueChange(modId: string, key: string, oldValue: unknown, newValue: unknown, from: chrome.runtime.Port | null): void {
  for (const port of gmPorts.get(modId) ?? []) {
    if (port === from) continue;
    try {
      port.postMessage({ type: 'gm.valueChanged', key, oldValue, newValue, remote: true });
    } catch {
      /* the frame went away; onDisconnect will clean it up */
    }
  }
}

/** The port belonging to the frame this message came from, so it is not told about its own write. */
function portForSender(modId: string, sender: chrome.runtime.MessageSender): chrome.runtime.Port | null {
  for (const port of gmPorts.get(modId) ?? []) {
    if (port.sender?.tab?.id === sender.tab?.id && port.sender?.frameId === sender.frameId) return port;
  }
  return null;
}

async function handleGm(msg: GmMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'gm.setValue':
    case 'gm.deleteValue': {
      const key = gmValuesKey(msg.modId);
      const values = await loadGmValues(msg.modId);
      const name = String(msg.key);
      const oldValue = values[name];
      if (msg.type === 'gm.setValue') values[name] = msg.value;
      else delete values[name];
      await chrome.storage.local.set({ [key]: values });
      broadcastValueChange(msg.modId, name, oldValue, msg.type === 'gm.setValue' ? msg.value : undefined, portForSender(msg.modId, sender));
      scheduleResync(msg.modId);
      return true;
    }
    case 'gm.xhr': {
      const d = msg.details;
      if (!d?.url) throw new Error('GM_xmlhttpRequest needs a url');
      // @connect gates which hosts a script may reach (CONTRACT C1). A script that declared
      // nothing can still talk to the sites it runs on only if it said "self".
      const mod = (await loadMods()).find((m) => m.id === msg.modId);
      const check = checkConnect(d.url, connectOf(mod), mod ? [...mod.matches, ...mod.includeGlobs] : []);
      if (!check.allowed) throw new Error(check.reason);
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
        const responseHeaders = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n');
        const base = { status: res.status, statusText: res.statusText, responseHeaders, finalUrl: res.url || d.url };
        // Binary responses cannot cross the messaging boundary, so they travel as base64 and the
        // shim rebuilds the ArrayBuffer or Blob on the other side (CONTRACT C2).
        if (d.responseType === 'arraybuffer' || d.responseType === 'blob') {
          const buf = new Uint8Array(await res.arrayBuffer());
          return { ...base, base64: toBase64(buf) };
        }
        const responseText = await res.text();
        let response: unknown = responseText;
        if (d.responseType === 'json') {
          try {
            response = JSON.parse(responseText) as unknown;
          } catch {
            response = null;
          }
        }
        // 'document' and '' both come back as text; the shim runs DOMParser where it can.
        return { ...base, responseText, response };
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

/**
 * lib/oauth, loaded on demand. Every call site is behind `if (STORE_BUILD)`, so the bundler drops
 * this import — and the vendor auth endpoints it reaches — from the store build. See lib/buildflags.
 */
function oauthModule() {
  return import('@/lib/oauth');
}

async function startLogin(kind: OAuthKind): Promise<OAuthLoginState> {
  logins.get(kind)?.controller.abort();
  const controller = new AbortController();
  const entry = { state: { status: 'idle' } as OAuthLoginState, controller };
  logins.set(kind, entry);
  try {
    const o = await oauthModule();
    const login = kind === 'chatgpt' ? await o.startChatgptLogin() : await o.startXaiLogin();
    entry.state = { status: 'pending', userCode: login.userCode, verificationUri: login.verificationUri, expiresAt: login.expiresAt };
    void login
      .poll(controller.signal)
      .then(async (tokens) => {
        await o.saveTokens(kind, tokens);
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
    case 'chatgpt': {
      if (STORE_BUILD) throw new Error(unavailableProviderMessage('chatgpt'));
      const o = await oauthModule();
      url = `${(s.baseUrl || CHATGPT_CODEX_BASE).replace(/\/+$/, '')}/models`;
      headers = o.chatgptHeaders(await o.getValidTokens('chatgpt'));
      break;
    }
    case 'xai': {
      if (STORE_BUILD) throw new Error(unavailableProviderMessage('xai'));
      const o = await oauthModule();
      const t = await o.getValidTokens('xai');
      url = `${(s.baseUrl || XAI_PROXY_BASE).replace(/\/+$/, '')}/models`;
      const h = o.xaiProxyHeaders('', t.access);
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
 * Everything the injected wrapper puts around the model's code, split so the line offset of the
 * user's first line is a computable constant rather than a guess. mapStack() needs that offset to
 * report a thrown error at the line the model wrote, not the line the wrapper landed on.
 *
 * The observer is the answer to "the script reported nothing, did it do anything?": a script whose
 * only effect is `forEach((e) => e.remove())` has no return value, and without a count of what it
 * moved the model has no evidence it worked and goes back to inspecting the page.
 */
function wrapForExecution(code: string, runId: string): { wrapped: string; lineOffset: number } {
  const preamble = `(async () => {
    const __logs = [];
    const __fmt = (a) => a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ');
    const __console = globalThis.console;
    const console = { ...__console, log: (...a) => { __logs.push(__fmt(a)); __console.log(...a); }, info: (...a) => { __logs.push(__fmt(a)); __console.info(...a); }, warn: (...a) => { __logs.push('warn: ' + __fmt(a)); __console.warn(...a); }, error: (...a) => { __logs.push('error: ' + __fmt(a)); __console.error(...a); } };
    const __dom = { added: 0, removed: 0, attributes: 0 };
    let __obs = null;
    try {
      __obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'attributes') __dom.attributes++;
          else { __dom.added += r.addedNodes.length; __dom.removed += r.removedNodes.length; }
        }
      });
      __obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch {}
    let __out;
    try {
      const __r = await (async () => {`;
  const epilogue = `
      })();
      // One microtask turn and one frame, so a removal the page does in a rAF callback is counted.
      await new Promise((r) => { try { requestAnimationFrame(() => r()); setTimeout(r, 50); } catch { r(); } });
      try { __obs && __obs.takeRecords().forEach((r) => { if (r.type === 'attributes') __dom.attributes++; else { __dom.added += r.addedNodes.length; __dom.removed += r.removedNodes.length; } }); } catch {}
      let __s; try { __s = typeof __r === 'string' ? __r : JSON.stringify(__r); } catch { __s = String(__r); }
      __out = { ok: true, returnedValue: __r !== undefined, result: __s === undefined ? 'undefined' : String(__s).slice(0, 4000), dom: __dom, logs: __logs };
    } catch (e) {
      __out = { ok: false, error: (e && e.stack) ? String(e.stack).slice(0, 4000) : String(e), dom: __dom, logs: __logs };
    }
    try { __obs && __obs.disconnect(); } catch {}
    try { chrome.runtime.sendMessage({ type: 'usermods:run-result', runId: ${JSON.stringify(runId)}, ...__out }); } catch {}
    return __out;
  })()`;
  // The user's first line begins on the line after the preamble's last newline.
  return { wrapped: `${preamble} ${code}${epilogue}`, lineOffset: preamble.split('\n').length - 1 };
}

/**
 * Run code once in a tab, in the USER_SCRIPT world. The wrapper captures console output, the
 * returned value (awaiting promises) and a count of what the DOM did, then reports back over
 * runtime messaging so async code works.
 *
 * `raw: true` injects the code exactly as given — that is the path `mods.try` uses, where the code
 * is a whole registered userscript and a last-expression rewrite would be wrong.
 */
async function executeInTab(
  tabId: number,
  code: string,
  opts: { world?: Mod['world']; timeoutMs?: number; raw?: boolean } = {},
): Promise<RunResult> {
  const { world = 'USER_SCRIPT', timeoutMs = 20_000, raw = false } = opts;
  const status = userScriptsStatus();
  if (!status.available) throw new Error(status.message);

  let source = code;
  if (!raw) {
    const prepared = prepareRunScript(code);
    // Injecting code we know does not parse wastes a round trip and reports the failure as a
    // runtime error from inside the wrapper; saying so here is both faster and more precise.
    if (!prepared.ok) return { outcome: { kind: 'threw', error: prepared.message }, logs: [] };
    source = prepared.code;
  }

  const runId = crypto.randomUUID();
  const { wrapped, lineOffset } = wrapForExecution(source, runId);
  const codeLines = source.split('\n').length;

  // Watching the tab is how a lost result stops looking like a timeout. The wrapper reports over
  // chrome.runtime.sendMessage; a navigation or unload between the script finishing and that
  // message flushing drops it silently, and the model used to be told only that 20s had passed.
  const result = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onUserScriptMessage.removeListener(listener);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(r);
    };

    const timer = setTimeout(() => finish({ outcome: { kind: 'timeout', seconds: timeoutMs / 1000 }, logs: [] }), timeoutMs);

    const listener = (msg: { type?: string; runId?: string } & Record<string, unknown>) => {
      if (msg?.type !== 'usermods:run-result' || msg.runId !== runId) return;
      const logs = (msg.logs as string[]) ?? [];
      if (msg.ok) {
        finish({
          outcome: {
            kind: 'ok',
            returnedValue: !!msg.returnedValue,
            result: msg.result as string | undefined,
            dom: msg.dom as { added: number; removed: number; attributes: number } | undefined,
          },
          logs,
        });
      } else {
        const stack = String(msg.error ?? '');
        finish({ outcome: { kind: 'threw', error: mapStack(stack, lineOffset, codeLines) }, logs });
      }
    };
    chrome.runtime.onUserScriptMessage.addListener(listener);

    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId || change.status !== 'loading') return;
      finish({ outcome: { kind: 'navigated', url: change.url ?? tab.url ?? 'a new page' }, logs: [] });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    const onRemoved = (id: number) => {
      if (id === tabId) finish({ outcome: { kind: 'navigated', url: 'a closed tab' }, logs: [] });
    };
    chrome.tabs.onRemoved.addListener(onRemoved);

    // An injection that never starts is its own failure, and saying "timed out" for it is a lie.
    chrome.userScripts
      .execute({ target: { tabId }, js: [{ code: wrapped }], world })
      .catch((e: unknown) => finish({ outcome: { kind: 'injection-failed', reason: e instanceof Error ? e.message : String(e) }, logs: [] }));
  });

  return result;
}

/** The `{ok, result, logs, error}` shape `mods.try` and the panel have always spoken. */
function legacyRunShape(r: RunResult): { ok: boolean; result?: string; logs: string[]; error?: string } {
  const rendered = renderRunResult(r);
  if (r.outcome.kind === 'ok') return { ok: true, result: r.outcome.result ?? 'undefined', logs: r.logs };
  return { ok: false, error: rendered.text, logs: r.logs };
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
