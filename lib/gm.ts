// Greasemonkey/Tampermonkey API shim. Each mod is wrapped in its own closure with the GM_* functions
// bound to that mod, then registered with chrome.userScripts. Persistent values are snapshotted into
// the code at registration; writes go to the background over user-script messaging, which broadcasts
// them to the mod's other live frames so GM_addValueChangeListener fires there too.
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

/** What the background posts back over a `gm:<modId>` port when another frame changes a value. */
export interface GmValueChanged {
  type: 'gm.valueChanged';
  key: string;
  oldValue: unknown;
  newValue: unknown;
  remote: true;
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
      connects: mod.connect ?? [],
      resources: mod.resources.map((r) => ({ name: r.name, url: r.url, mimetype: r.mime })),
      'run-at': mod.runAt.replace('_', '-'),
      downloadURL: mod.downloadUrl,
    },
    resources: Object.fromEntries(mod.resources.map((r) => [r.name, { mime: r.mime, text: r.text, base64: r.base64 }])),
  };
}

/**
 * The complete code registered for a mod: the GM shim, then each @require evaluated in its own
 * function scope, then the script body.
 *
 * Deliberately not strict mode: Tampermonkey does not impose one, and plenty of old scripts and
 * libraries rely on sloppy-mode behaviour (implicit globals, `arguments.callee`, octal literals).
 * A script that wants strict mode still gets it from its own leading directive, because the body
 * is evaluated as its own function.
 */
export function buildRegisteredCode(mod: Mod, values: Record<string, unknown>): string {
  const body = mod.source; // header lines are comments; keeping them keeps line numbers close to the original
  // Each @require gets its own function scope, evaluated in order, sharing globals the way
  // Tampermonkey does: libraries assign to window/globalThis, which in the USER_SCRIPT world is the
  // isolated global. They see the GM_* bindings because they are passed in as parameters.
  const requireUnits = mod.requires.map((r) => ({ url: r.url, code: r.code }));
  const units = [...requireUnits, { url: null as string | null, code: body }];
  const evaluated = units
    .map(
      (u) =>
        `__evaluate(${JSON.stringify(u.url ? `@require ${u.url}` : 'script')}, function (${GM_PARAMS.join(', ')}) {\n${u.code}\n})(${GM_PARAMS.join(', ')});`,
    )
    .join('\n');
  return `(function () {
const __meta = ${JSON.stringify(scriptInfo(mod))};
let __values = ${JSON.stringify(values)};
const __menu = [];
const __listeners = new Map();
let __listenerId = 0;
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
// A port to the background, so value changes made in other tabs reach this one live. Only the
// USER_SCRIPT world can connect; in the page (MAIN) world this is a no-op and listeners fire only
// for local writes.
let __port = null;
try {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
    __port = chrome.runtime.connect({ name: 'gm:' + __meta.id });
    __port.onMessage.addListener((m) => {
      if (!m || m.type !== 'gm.valueChanged') return;
      if (Object.prototype.hasOwnProperty.call(m, 'newValue') && m.newValue !== undefined) __values[m.key] = m.newValue;
      else delete __values[m.key];
      __fireValueChange(m.key, m.oldValue, m.newValue, true);
    });
    if (__port.onDisconnect) __port.onDisconnect.addListener(() => { __port = null; });
  }
} catch (e) { __port = null; }
function __fireValueChange(key, oldValue, newValue, remote) {
  for (const l of Array.from(__listeners.values())) {
    if (l.name !== key) continue;
    try { l.fn(key, oldValue, newValue, remote); } catch (e) { console.error('[' + __meta.script.name + '] value change listener failed', e); }
  }
}
function __bytesToBase64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function __base64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
const GM_info = { script: __meta.script, scriptHandler: 'usermods', version: __meta.handlerVersion, scriptMetaStr: __meta.metaStr, isIncognito: false };
function GM_addStyle(css) { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); return s; }
function GM_addElement(a, b, c) { const parent = typeof a === 'string' ? (document.head || document.documentElement) : a; const tag = typeof a === 'string' ? a : b; const attrs = (typeof a === 'string' ? b : c) || {}; const el = document.createElement(tag); for (const k of Object.keys(attrs)) { if (k === 'textContent') el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]); } parent.appendChild(el); return el; }
function GM_getValue(k, d) { return Object.prototype.hasOwnProperty.call(__values, k) ? __values[k] : d; }
function GM_setValue(k, v) { const old = Object.prototype.hasOwnProperty.call(__values, k) ? __values[k] : undefined; __values[k] = v; __send({ type: 'gm.setValue', key: k, value: v }).catch(() => {}); __fireValueChange(k, old, v, false); }
function GM_deleteValue(k) { const old = Object.prototype.hasOwnProperty.call(__values, k) ? __values[k] : undefined; delete __values[k]; __send({ type: 'gm.deleteValue', key: k }).catch(() => {}); __fireValueChange(k, old, undefined, false); }
function GM_listValues() { return Object.keys(__values); }
function GM_addValueChangeListener(name, fn) { if (typeof fn !== 'function') return 0; const id = ++__listenerId; __listeners.set(id, { name: String(name), fn }); return id; }
function GM_removeValueChangeListener(id) { __listeners.delete(id); }
function GM_getResourceText(n) { const r = __meta.resources[n]; return r ? r.text : null; }
function GM_getResourceURL(n) { const r = __meta.resources[n]; return r ? 'data:' + (r.mime || 'application/octet-stream') + ';base64,' + r.base64 : null; }
function GM_openInTab(url, opts) {
  // Tampermonkey: bare true means "open in the background"; undefined/false means foreground; the
  // object form opens in the background unless it says active: true, so a missing 'active' is a
  // background tab.
  let active;
  if (opts === true) active = false;
  else if (opts && typeof opts === 'object') active = opts.active === true;
  else active = true;
  __send({ type: 'gm.openInTab', url: String(url), active }).catch(() => {});
  return { close() {}, closed: false, onclose: null };
}
function GM_setClipboard(text) { try { navigator.clipboard.writeText(String(text)); } catch (e) {} }
function GM_log() { console.log.apply(console, ['[' + __meta.script.name + ']'].concat([].slice.call(arguments))); }
function GM_notification(details, ondone) { const d = typeof details === 'string' ? { text: details, title: ondone } : (details || {}); console.info('[' + __meta.script.name + '] ' + (d.title ? d.title + ': ' : '') + (d.text || '')); if (typeof d.ondone === 'function') d.ondone(); }
function GM_registerMenuCommand(name, fn) { __menu.push({ name, fn }); return __menu.length; }
function GM_unregisterMenuCommand(id) { __menu[id - 1] = null; }
function GM_getTab(cb) { cb({}); } function GM_saveTab() {} function GM_getTabs(cb) { cb({}); }
function GM_xmlhttpRequest(details) {
  const d = details || {};
  let aborted = false;
  const responseType = d.responseType || '';
  const data = d.data == null ? null : (typeof d.data === 'string' ? d.data : (d.data instanceof URLSearchParams ? d.data.toString() : (typeof FormData !== 'undefined' && d.data instanceof FormData ? null : JSON.stringify(d.data))));
  __send({ type: 'gm.xhr', details: { method: d.method || 'GET', url: String(d.url), headers: d.headers || {}, data, responseType, timeout: d.timeout } })
    .then((r) => {
      if (aborted) return;
      const res = { status: r.status, statusText: r.statusText, readyState: 4, responseHeaders: r.responseHeaders, responseText: r.responseText, response: r.response, responseXML: null, responseType, finalUrl: r.finalUrl, context: d.context };
      // The background cannot post an ArrayBuffer or Blob through sendMessage, so binary bodies come
      // back base64-encoded and are rebuilt here; 'document' is parsed here for the same reason.
      if (r.base64 != null && (responseType === 'arraybuffer' || responseType === 'blob')) {
        const bytes = __base64ToBytes(r.base64);
        if (responseType === 'blob') {
          const type = (String(r.responseHeaders || '').match(/^content-type:\\s*([^\\r\\n;]+)/im) || [])[1] || '';
          res.response = new Blob([bytes], { type: type.trim() });
        } else {
          res.response = bytes.buffer;
        }
        res.responseText = '';
      } else if (responseType === 'document') {
        try {
          const doc = new DOMParser().parseFromString(String(r.responseText == null ? '' : r.responseText), 'text/html');
          res.response = doc;
          res.responseXML = doc;
        } catch (e) { res.response = null; }
      }
      if ((r.status >= 200 && r.status < 300) || r.status === 304) { if (d.onload) d.onload(res); }
      else if (d.onerror) d.onerror(res); else if (d.onload) d.onload(res);
      if (d.onloadend) d.onloadend(res);
    })
    .catch((e) => { if (aborted) return; const res = { status: 0, statusText: String((e && e.message) || e), readyState: 4, responseHeaders: '', responseText: '', response: null, responseXML: null, responseType, finalUrl: d.url, context: d.context, error: String((e && e.message) || e) }; if (d.onerror) d.onerror(res); if (d.onloadend) d.onloadend(res); });
  return { abort() { aborted = true; if (d.onabort) d.onabort(); } };
}
const GM = {
  info: GM_info,
  addStyle: GM_addStyle, addElement: GM_addElement,
  getValue: async (k, d) => GM_getValue(k, d), setValue: async (k, v) => GM_setValue(k, v), deleteValue: async (k) => GM_deleteValue(k), listValues: async () => GM_listValues(),
  addValueChangeListener: GM_addValueChangeListener, removeValueChangeListener: GM_removeValueChangeListener,
  getResourceText: async (n) => GM_getResourceText(n), getResourceUrl: async (n) => GM_getResourceURL(n),
  xmlHttpRequest: GM_xmlhttpRequest, openInTab: GM_openInTab, setClipboard: GM_setClipboard, log: GM_log, notification: GM_notification,
  registerMenuCommand: GM_registerMenuCommand, unregisterMenuCommand: GM_unregisterMenuCommand,
};
const unsafeWindow = window;
// One function scope per unit, so a "use strict" or a stray syntax quirk in one @require cannot
// leak into the next one or into the script body. The GM_* bindings arrive as parameters.
const __evaluate = (label, fn) => function () {
  try { return fn.apply(this, arguments); }
  catch (e) { console.error('[' + __meta.script.name + '] ' + label + ' failed', e); throw e; }
};
${evaluated}
})();
`;
}

/** The GM bindings handed to every evaluated unit, as function parameters. */
const GM_PARAMS = [
  'GM',
  'unsafeWindow',
  'GM_info',
  'GM_addStyle',
  'GM_addElement',
  'GM_getValue',
  'GM_setValue',
  'GM_deleteValue',
  'GM_listValues',
  'GM_addValueChangeListener',
  'GM_removeValueChangeListener',
  'GM_getResourceText',
  'GM_getResourceURL',
  'GM_openInTab',
  'GM_setClipboard',
  'GM_log',
  'GM_notification',
  'GM_registerMenuCommand',
  'GM_unregisterMenuCommand',
  'GM_getTab',
  'GM_saveTab',
  'GM_getTabs',
  'GM_xmlhttpRequest',
];

/** Storage key for a mod's GM_setValue store. */
export const gmValuesKey = (modId: string) => `gm:${modId}`;

export async function loadGmValues(modId: string): Promise<Record<string, unknown>> {
  const r = await chrome.storage.local.get(gmValuesKey(modId));
  return (r[gmValuesKey(modId)] as Record<string, unknown> | undefined) ?? {};
}
