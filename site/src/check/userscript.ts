// Reads the ==UserScript== block and builds the code the harness injects with
// page.addInitScript: @match filtering, @noframes, a GM_addStyle shim identical to
// usermods' own (lib/gm.ts), and @run-at timing.

export type RunAt = 'document-start' | 'document-end' | 'document-idle';

export interface ScriptMeta {
  name: string;
  matches: string[];
  runAt: RunAt;
  grants: string[];
  noframes: boolean;
}

const ALLOWED_GRANTS = new Set(['none', 'GM_addStyle']);

export function parseMeta(source: string): ScriptMeta {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(source);
  if (!block?.[1]) throw new Error('no ==UserScript== block');
  const meta: ScriptMeta = { name: '', matches: [], runAt: 'document-idle', grants: [], noframes: false };
  for (const line of block[1].split('\n')) {
    const m = /^\s*\/\/\s*@([\w:-]+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!m?.[1]) continue;
    const key = m[1];
    const value = m[2] ?? '';
    if (key === 'name') meta.name = value;
    else if (key === 'match') meta.matches.push(value);
    else if (key === 'grant') meta.grants.push(value);
    else if (key === 'noframes') meta.noframes = true;
    else if (key === 'run-at') {
      if (value !== 'document-start' && value !== 'document-end' && value !== 'document-idle') {
        throw new Error(`unsupported @run-at ${value}`);
      }
      meta.runAt = value;
    }
  }
  if (meta.matches.length === 0) throw new Error('no @match line');
  for (const g of meta.grants) {
    if (!ALLOWED_GRANTS.has(g)) throw new Error(`@grant ${g} is not allowed (only none or GM_addStyle)`);
  }
  return meta;
}

// Chrome match pattern → RegExp source. https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
export function matchPatternToRegExp(pattern: string): string {
  if (pattern === '<all_urls>') return '^(https?|file|ftp)://';
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m?.[1] || m[2] === undefined || !m[3]) throw new Error(`bad @match pattern ${pattern}`);
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const scheme = m[1] === '*' ? 'https?' : m[1];
  const hostPat = m[2];
  let host: string;
  if (hostPat === '*') host = '[^/]*';
  else if (hostPat.startsWith('*.')) host = `(?:[^/]*\\.)?${esc(hostPat.slice(2))}`;
  else host = esc(hostPat);
  const path = m[3].split('*').map(esc).join('.*');
  return `^${scheme}://${host}(?::\\d+)?${path}$`;
}

export function matchesUrl(meta: ScriptMeta, url: string): boolean {
  return meta.matches.some((p) => new RegExp(matchPatternToRegExp(p)).test(url));
}

// The window property where a thrown script error is left for the harness to read.
export const ERROR_SLOT = '__usermodsCheckError';

export function buildInjection(source: string, meta: ScriptMeta): string {
  const patterns = JSON.stringify(meta.matches.map(matchPatternToRegExp));
  const run = {
    // Chrome runs document_start scripts once <html> exists; addInitScript runs before that.
    'document-start': 'if (document.documentElement) __run(); else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); __run(); } }).observe(document, { childList: true });',
    'document-end': "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __run, { once: true }); else __run();",
    'document-idle': "if (document.readyState === 'complete') __run(); else window.addEventListener('load', __run, { once: true });",
  }[meta.runAt];
  return `(() => {
${meta.noframes ? 'if (window.top !== window) return;' : ''}
if (!${patterns}.some((p) => new RegExp(p).test(location.href))) return;
function GM_addStyle(css) { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); return s; }
const GM = { addStyle: GM_addStyle };
const __run = () => {
  try {
${source}
  } catch (e) {
    window.${ERROR_SLOT} = String(e && e.stack || e);
  }
};
${run}
})();`;
}
