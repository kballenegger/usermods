// Greasemonkey/Tampermonkey API shim. Each mod is wrapped in its own closure with the GM_* functions
// bound to that mod, then registered with chrome.userScripts. Persistent values are snapshotted into
// the code at registration; writes go to the background over user-script messaging and trigger a
// re-registration so the next page load sees them.
import type { Mod } from './types';

export const HANDLER_VERSION = '0.1.0';

export interface GmMessage {
  __usermods: true;
  modId: string;
  type: 'gm.setValue' | 'gm.deleteValue' | 'gm.xhr' | 'gm.openInTab' | 'gm.log';
  key?: string;
  value?: unknown;
  url?: string;
  active?: boolean;
  details?: { method?: string; url: string; headers?: Record<string, string>; data?: string | null; responseType?: string; timeout?: number };
  args?: unknown[];
}

function scriptInfo(mod: Mod) {
  const header = mod.source.match(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/)?.[0] ?? '';
  return {
    id: mod.id,
    handlerVersion: HANDLER_VERSION,
    metaStr: header,
    script: {
      name: mod.name,
      description: mod.description,
      version: mod.version,
      matches: mod.matches,
      includes: mod.includeGlobs,
      excludes: [...mod.excludeMatches, ...mod.excludeGlobs],
      grant: mod.grants,
      resources: mod.resources.map((r) => ({ name: r.name, url: r.url, mimetype: r.mime })),
      'run-at': mod.runAt.replace('_', '-'),
      downloadURL: mod.downloadUrl,
    },
    resources: Object.fromEntries(mod.resources.map((r) => [r.name, { mime: r.mime, text: r.text, base64: r.base64 }])),
  };
}

/** The complete code registered for a mod: GM shim + @require bodies + the script itself, in one closure. */
export function buildRegisteredCode(mod: Mod, values: Record<string, unknown>): string {
  const body = mod.source; // header lines are comments; keeping them keeps line numbers close to the original
  const requires = mod.requires.map((r) => `/* @require ${r.url} */\n${r.code}\n`).join('\n');
  return `(function () {
'use strict';
const __meta = ${JSON.stringify(scriptInfo(mod))};
let __values = ${JSON.stringify(values)};
const __menu = [];
const __send = (msg) => new Promise((resolve, reject) => {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return reject(new Error('GM API unavailable in the page world'));
    chrome.runtime.sendMessage({ ...msg, __usermods: true, modId: __meta.id }, (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (r && r.error) reject(new Error(r.error));
      else resolve(r && r.result);
    });
  } catch (e) { reject(e); }
});
const GM_info = { script: __meta.script, scriptHandler: 'usermods', version: __meta.handlerVersion, scriptMetaStr: __meta.metaStr, isIncognito: false };
function GM_addStyle(css) { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); return s; }
function GM_addElement(a, b, c) { const parent = typeof a === 'string' ? (document.head || document.documentElement) : a; const tag = typeof a === 'string' ? a : b; const attrs = (typeof a === 'string' ? b : c) || {}; const el = document.createElement(tag); for (const k of Object.keys(attrs)) { if (k === 'textContent') el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]); } parent.appendChild(el); return el; }
function GM_getValue(k, d) { return Object.prototype.hasOwnProperty.call(__values, k) ? __values[k] : d; }
function GM_setValue(k, v) { __values[k] = v; __send({ type: 'gm.setValue', key: k, value: v }).catch(() => {}); }
function GM_deleteValue(k) { delete __values[k]; __send({ type: 'gm.deleteValue', key: k }).catch(() => {}); }
function GM_listValues() { return Object.keys(__values); }
function GM_addValueChangeListener() { return 0; }
function GM_removeValueChangeListener() {}
function GM_getResourceText(n) { const r = __meta.resources[n]; return r ? r.text : null; }
function GM_getResourceURL(n) { const r = __meta.resources[n]; return r ? 'data:' + (r.mime || 'application/octet-stream') + ';base64,' + r.base64 : null; }
function GM_openInTab(url, opts) { const bg = opts === true || (opts && opts.active === false); __send({ type: 'gm.openInTab', url: String(url), active: !bg }).catch(() => {}); return { close() {}, closed: false, onclose: null }; }
function GM_setClipboard(text) { try { navigator.clipboard.writeText(String(text)); } catch {} }
function GM_log() { console.log.apply(console, ['[' + __meta.script.name + ']'].concat([].slice.call(arguments))); }
function GM_notification(details, ondone) { const d = typeof details === 'string' ? { text: details, title: ondone } : (details || {}); console.info('[' + __meta.script.name + '] ' + (d.title ? d.title + ': ' : '') + (d.text || '')); if (typeof d.ondone === 'function') d.ondone(); }
function GM_registerMenuCommand(name, fn) { __menu.push({ name, fn }); return __menu.length; }
function GM_unregisterMenuCommand(id) { __menu[id - 1] = null; }
function GM_getTab(cb) { cb({}); } function GM_saveTab() {} function GM_getTabs(cb) { cb({}); }
function GM_xmlhttpRequest(details) {
  const d = details || {};
  let aborted = false;
  const data = d.data == null ? null : (typeof d.data === 'string' ? d.data : (d.data instanceof URLSearchParams ? d.data.toString() : (typeof FormData !== 'undefined' && d.data instanceof FormData ? null : JSON.stringify(d.data))));
  __send({ type: 'gm.xhr', details: { method: d.method || 'GET', url: String(d.url), headers: d.headers || {}, data, responseType: d.responseType || '', timeout: d.timeout } })
    .then((r) => {
      if (aborted) return;
      const res = { status: r.status, statusText: r.statusText, readyState: 4, responseHeaders: r.responseHeaders, responseText: r.responseText, response: r.response, finalUrl: r.finalUrl, context: d.context };
      if (r.status >= 200 && r.status < 300 || r.status === 304) { if (d.onload) d.onload(res); }
      else if (d.onerror) d.onerror(res); else if (d.onload) d.onload(res);
      if (d.onloadend) d.onloadend(res);
    })
    .catch((e) => { if (aborted) return; const res = { status: 0, statusText: String(e && e.message || e), readyState: 4, responseHeaders: '', responseText: '', response: null, finalUrl: d.url, context: d.context, error: String(e && e.message || e) }; if (d.onerror) d.onerror(res); if (d.onloadend) d.onloadend(res); });
  return { abort() { aborted = true; if (d.onabort) d.onabort(); } };
}
const GM = {
  info: GM_info,
  addStyle: GM_addStyle, addElement: GM_addElement,
  getValue: async (k, d) => GM_getValue(k, d), setValue: async (k, v) => GM_setValue(k, v), deleteValue: async (k) => GM_deleteValue(k), listValues: async () => GM_listValues(),
  getResourceText: async (n) => GM_getResourceText(n), getResourceUrl: async (n) => GM_getResourceURL(n),
  xmlHttpRequest: GM_xmlhttpRequest, openInTab: GM_openInTab, setClipboard: GM_setClipboard, log: GM_log, notification: GM_notification,
  registerMenuCommand: GM_registerMenuCommand, unregisterMenuCommand: GM_unregisterMenuCommand,
};
const unsafeWindow = window;
void GM; void unsafeWindow; void GM_info; void GM_addStyle; void GM_addElement; void GM_getValue; void GM_setValue; void GM_deleteValue; void GM_listValues; void GM_addValueChangeListener; void GM_removeValueChangeListener; void GM_getResourceText; void GM_getResourceURL; void GM_openInTab; void GM_setClipboard; void GM_log; void GM_notification; void GM_registerMenuCommand; void GM_unregisterMenuCommand; void GM_getTab; void GM_saveTab; void GM_getTabs; void GM_xmlhttpRequest;
${requires}
${body}
})();
`;
}

/** Storage key for a mod's GM_setValue store. */
export const gmValuesKey = (modId: string) => `gm:${modId}`;

export async function loadGmValues(modId: string): Promise<Record<string, unknown>> {
  const r = await chrome.storage.local.get(gmValuesKey(modId));
  return (r[gmValuesKey(modId)] as Record<string, unknown> | undefined) ?? {};
}
