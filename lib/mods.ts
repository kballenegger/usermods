import type { Mod, ModProposal, ScriptPreview } from './types';

const STORAGE_KEY = 'mods';

export function newId(): string {
  return crypto.randomUUID();
}

export interface Header {
  name: string;
  description: string;
  version: string;
  matches: string[];
  excludeMatches: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  grants: string[];
  requires: string[];
  resources: Array<{ name: string; url: string }>;
  runAt: Mod['runAt'];
  noFrames: boolean;
  downloadUrl?: string;
  updateUrl?: string;
  warnings: string[];
  /** All raw key/value pairs, for GM_info.script. */
  raw: Record<string, string[]>;
}

/** Parse the ==UserScript== header block the way Tampermonkey reads it. */
export function parseHeader(source: string): Header {
  const h: Header = {
    name: '', description: '', version: '', matches: [], excludeMatches: [], includeGlobs: [], excludeGlobs: [],
    grants: [], requires: [], resources: [], runAt: 'document_idle', noFrames: false, warnings: [], raw: {},
  };
  const m = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!m) return h;
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^\s*\/\/\s*@([\w:-]+)\s*(.*?)\s*$/);
    if (!kv) continue;
    const [, keyRaw, value] = kv as [string, string, string];
    const key = keyRaw.replace(/:.*$/, ''); // @name:en → @name
    (h.raw[key] ??= []).push(value);
    switch (key) {
      case 'name': if (!h.name) h.name = value; break;
      case 'description': if (!h.description) h.description = value; break;
      case 'version': h.version = value; break;
      case 'match': {
        const p = toMatchPattern(value);
        if (p) h.matches.push(p);
        else h.warnings.push(`Ignored invalid @match ${value}`);
        break;
      }
      case 'include': {
        const p = toMatchPattern(value);
        if (p) h.matches.push(p);
        else if (/^\/.*\/$/.test(value)) h.warnings.push(`Ignored regex @include ${value} (not supported)`);
        else h.includeGlobs.push(value);
        break;
      }
      case 'exclude': {
        const p = toMatchPattern(value);
        if (p) h.excludeMatches.push(p);
        else if (!/^\/.*\/$/.test(value)) h.excludeGlobs.push(value);
        break;
      }
      case 'grant': if (value && value !== 'none') h.grants.push(value); else if (value === 'none') h.grants.push('none'); break;
      case 'require': if (value) h.requires.push(value); break;
      case 'resource': {
        const r = value.match(/^(\S+)\s+(\S+)/);
        if (r) h.resources.push({ name: r[1]!, url: r[2]! });
        break;
      }
      case 'run-at':
        h.runAt = value === 'document-start' ? 'document_start' : value === 'document-end' || value === 'document-body' ? 'document_end' : 'document_idle';
        break;
      case 'noframes': h.noFrames = true; break;
      case 'downloadURL': h.downloadUrl = value; break;
      case 'updateURL': h.updateUrl = value; break;
    }
  }
  return h;
}

/**
 * Coerce a Tampermonkey-style @match/@include into a valid Chrome match pattern, or null.
 * Handles `*`, `http*://`, `https://example.com` (no path) and similar looseness.
 */
export function toMatchPattern(v: string): string | null {
  let s = v.trim();
  if (!s) return null;
  if (s === '*' || s === '*://*' || s === '*://*/') return '*://*/*';
  s = s.replace(/^http\*:\/\//, '*://').replace(/^https?\*?:\/\//, (x) => (x.startsWith('https') ? 'https://' : x.startsWith('http*') ? '*://' : 'http://'));
  const m = s.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/);
  if (!m) return null;
  const [, scheme, host, path] = m as [string, string, string, string | undefined];
  if (!host && scheme !== 'file') return null;
  // host may be *, *.example.com, or example.com; anything else (e.g. *example*) is a glob, not a pattern.
  if (host && !/^(\*|(\*\.)?[\w.-]+(:\d+)?)$/.test(host)) return null;
  return `${scheme}://${host}${path ?? '/*'}`;
}

/** Strip the header block, returning just the script body. */
export function stripHeader(source: string): string {
  return source.replace(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/, '');
}

export function buildSource(p: ModProposal): string {
  const lines = [
    '// ==UserScript==',
    `// @name        ${p.name}`,
    `// @description ${p.description}`,
    '// @version     1.0',
    ...p.matches.map((m) => `// @match       ${m}`),
    '// @grant       none',
    '// ==/UserScript==',
    '',
    p.code.trim(),
    '',
  ];
  return lines.join('\n');
}

function worldFor(h: Header): Mod['world'] {
  // @grant none means "run in the page context" in Tampermonkey; unsafeWindow needs it too.
  if (h.grants.includes('none') || h.grants.includes('unsafeWindow')) return 'MAIN';
  return 'USER_SCRIPT';
}

/** Mods written by the model: our own scripts, no GM API, isolated world. */
export function modFromProposal(p: ModProposal, existing?: Mod): Mod {
  return modFromSource(buildSource(p), existing, { world: 'USER_SCRIPT' });
}

export function modFromSource(source: string, existing?: Mod, overrides: Partial<Mod> = {}): Mod {
  const h = parseHeader(source);
  const now = Date.now();
  return {
    id: existing?.id ?? newId(),
    name: h.name || existing?.name || 'Untitled mod',
    description: h.description,
    version: h.version,
    matches: h.matches.length || h.includeGlobs.length ? h.matches : existing?.matches ?? [],
    excludeMatches: h.excludeMatches,
    includeGlobs: h.includeGlobs,
    excludeGlobs: h.excludeGlobs,
    runAt: h.runAt,
    world: worldFor(h),
    allFrames: !h.noFrames,
    grants: h.grants,
    requires: existing?.requires ?? [],
    resources: existing?.resources ?? [],
    downloadUrl: h.downloadUrl ?? existing?.downloadUrl,
    source,
    enabled: existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...overrides,
  };
}

export function previewFromSource(source: string, downloadUrl?: string): ScriptPreview {
  const h = parseHeader(source);
  const warnings = [...h.warnings];
  if (!h.matches.length && !h.includeGlobs.length) warnings.push('No @match or @include lines: this script would never run.');
  const unsupported = h.grants.filter((g) => !SUPPORTED_GRANTS.has(g));
  if (unsupported.length) warnings.push(`Unsupported: ${unsupported.join(', ')}. Those calls will be no-ops.`);
  return {
    source,
    name: h.name || 'Untitled script',
    description: h.description,
    version: h.version,
    matches: h.matches,
    includeGlobs: h.includeGlobs,
    grants: h.grants,
    requires: h.requires,
    resources: h.resources.map((r) => r.name),
    world: worldFor(h),
    runAt: h.runAt,
    downloadUrl: downloadUrl ?? h.downloadUrl,
    warnings,
  };
}

export const SUPPORTED_GRANTS = new Set([
  'none', 'unsafeWindow', 'GM_addStyle', 'GM.addStyle', 'GM_getValue', 'GM.getValue', 'GM_setValue', 'GM.setValue',
  'GM_deleteValue', 'GM.deleteValue', 'GM_listValues', 'GM.listValues', 'GM_getResourceText', 'GM.getResourceText',
  'GM_getResourceURL', 'GM.getResourceUrl', 'GM_xmlhttpRequest', 'GM.xmlHttpRequest', 'GM_openInTab', 'GM.openInTab',
  'GM_setClipboard', 'GM.setClipboard', 'GM_log', 'GM.log', 'GM_info', 'GM.info', 'GM_registerMenuCommand', 'GM.registerMenuCommand',
  'GM_unregisterMenuCommand', 'GM_notification', 'GM.notification', 'GM_addElement', 'GM.addElement', 'GM_addValueChangeListener',
  'GM_removeValueChangeListener', 'GM_getTab', 'GM_saveTab', 'GM_getTabs', 'window.close', 'window.focus', 'window.onurlchange',
]);

/** Fill defaults for mods saved by older versions. */
export function normalizeMod(m: Partial<Mod> & { id: string; source: string }): Mod {
  const fresh = modFromSource(m.source, undefined);
  return { ...fresh, ...m, requires: m.requires ?? [], resources: m.resources ?? [], grants: m.grants ?? fresh.grants, world: m.world ?? fresh.world, runAt: m.runAt ?? fresh.runAt, allFrames: m.allFrames ?? fresh.allFrames, excludeMatches: m.excludeMatches ?? [], includeGlobs: m.includeGlobs ?? [], excludeGlobs: m.excludeGlobs ?? [], version: m.version ?? fresh.version };
}

export async function loadMods(): Promise<Mod[]> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const raw = (r[STORAGE_KEY] as Array<Partial<Mod> & { id: string; source: string }> | undefined) ?? [];
  return raw.map(normalizeMod);
}

export async function saveMods(mods: Mod[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: mods });
}

export async function upsertMod(mod: Mod): Promise<Mod[]> {
  const mods = await loadMods();
  const i = mods.findIndex((m) => m.id === mod.id);
  if (i >= 0) mods[i] = mod;
  else mods.push(mod);
  await saveMods(mods);
  return mods;
}

export async function deleteMod(id: string): Promise<Mod[]> {
  const mods = (await loadMods()).filter((m) => m.id !== id);
  await saveMods(mods);
  await chrome.storage.local.remove(`gm:${id}`);
  return mods;
}

/** Turn a page URL into a match pattern covering that host and its subdomains. */
export function matchPatternForUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return `*://*.${host}/*`;
  } catch {
    return url;
  }
}

/** Does a URL match any of the mod's patterns or globs? Display only; Chrome does the real matching. */
export function urlMatches(url: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp(
      '^' +
        p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/^\*:/, '[a-z]+:')
          .replace(/\*/g, '.*') +
        '$',
    );
    return re.test(url);
  });
}

export function modMatchesUrl(m: Mod, url: string): boolean {
  return urlMatches(url, [...m.matches, ...m.includeGlobs]) && !urlMatches(url, [...m.excludeMatches, ...m.excludeGlobs]);
}
