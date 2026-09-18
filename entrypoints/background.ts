import { runAgent, type AgentEnv } from '@/lib/agent/loop';
import { loadMods, upsertMod, deleteMod, saveMods } from '@/lib/mods';
import type { AgentPortRequest, RpcRequest } from '@/lib/rpc';
import { loadSettings } from '@/lib/settings';
import type { ContentRequest, Msg } from '@/lib/types';

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.runtime.onInstalled.addListener(() => void bootstrap());
  chrome.runtime.onStartup.addListener(() => void bootstrap());

  chrome.runtime.onMessage.addListener((msg: RpcRequest | { type?: string }, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.includes('.')) return false; // not an RPC (e.g. content events)
    handleRpc(msg as RpcRequest)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'agent') return;
    let controller: AbortController | null = null;
    port.onMessage.addListener((req: AgentPortRequest) => {
      if (req.type === 'abort') {
        controller?.abort();
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      void (async () => {
        const post = (e: unknown) => {
          try {
            port.postMessage(e);
          } catch {
            /* panel closed */
          }
        };
        try {
          const settings = await loadSettings();
          if (!settings.apiKey && !settings.baseUrl) throw new Error('Add an API key in Settings first (or a base URL for a local server or proxy).');
          if (!settings.model) throw new Error('Choose a model in Settings first.');
          const history = await loadHistory(req.tabId);
          const messages = await runAgent({
            settings,
            history,
            text: req.text,
            picked: req.picked,
            env: envForTab(req.tabId),
            emit: post,
            signal,
          });
          await saveHistory(req.tabId, messages);
          post({ type: 'done' });
        } catch (e) {
          if (signal.aborted) post({ type: 'done' });
          else post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      })();
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
    case 'mods.try':
      return executeInTab(req.tabId, req.code);
    case 'userScripts.status':
      return userScriptsStatus();
    case 'page.pick':
      await sendToContent(req.tabId, { type: 'pick' });
      return { ok: true };
    case 'page.info': {
      const tab = await chrome.tabs.get(req.tabId);
      return { url: tab.url ?? '', title: tab.title ?? '' };
    }
    case 'chat.reset':
      await chrome.storage.session.remove(historyKey(req.tabId));
      return { ok: true };
    case 'chat.hasHistory':
      return (await loadHistory(req.tabId)).length > 0;
  }
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
  const enabled = mods.filter((m) => m.enabled && m.matches.length);
  if (!enabled.length) return;
  await chrome.userScripts.register(
    enabled.map((m) => ({
      id: m.id,
      matches: m.matches,
      js: [{ code: m.source }],
      runAt: 'document_idle',
      world: 'USER_SCRIPT',
    })),
  );
}

/**
 * Run code once in a tab, in the USER_SCRIPT world. The wrapper captures console output and the
 * final value (awaiting promises), then reports back over runtime messaging so async code works.
 */
async function executeInTab(tabId: number, code: string, timeoutMs = 20_000) {
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

  await chrome.userScripts.execute({ target: { tabId }, js: [{ code: wrapped }], world: 'USER_SCRIPT' });
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

// ---------- chat history (per tab, session-scoped) ----------

const historyKey = (tabId: number) => `chat:${tabId}`;

async function loadHistory(tabId: number): Promise<Msg[]> {
  const r = await chrome.storage.session.get(historyKey(tabId));
  return (r[historyKey(tabId)] as Msg[] | undefined) ?? [];
}

async function saveHistory(tabId: number, messages: Msg[]): Promise<void> {
  // Screenshots are large; drop image data from stored history to stay under the session quota.
  const slim = messages.map((m) => ({
    ...m,
    content: m.content.map((p) =>
      p.type === 'tool_result'
        ? { ...p, content: p.content.map((c) => (c.type === 'image' ? { type: 'text' as const, text: '[screenshot omitted from history]' } : c)) }
        : p,
    ),
  }));
  await chrome.storage.session.set({ [historyKey(tabId)]: slim });
}
