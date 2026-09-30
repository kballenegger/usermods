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
  /** Raw @connect values, in header order. */
  connect: string[];
  requires: string[];
  resources: Array<{ name: string; url: string }>;
  runAt: Mod['runAt'];
  noFrames: boolean;
  downloadUrl?: string;
  updateUrl?: string;
  /** Violentmonkey's @inject-into (page | content | auto), as written. */
  injectInto?: string;
  /** Tampermonkey's @sandbox (raw | JavaScript | DOM), as written. */
  sandbox?: string;
  warnings: string[];
  /** All raw key/value pairs, for GM_info.script. */
  raw: Record<string, string[]>;
}

/** Parse the ==UserScript== header block the way Tampermonkey reads it. */
export function parseHeader(source: string): Header {
  const h: Header = {
    name: '', description: '', version: '', matches: [], excludeMatches: [], includeGlobs: [], excludeGlobs: [],
    grants: [], connect: [], requires: [], resources: [], runAt: 'document_idle', noFrames: false, warnings: [], raw: {},
  };
  const m = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!m) return h;
  // Locale-suffixed keys (@name:fr) are fallbacks only: the unsuffixed key is canonical however the
  // lines are ordered, matching Tampermonkey. They are still recorded in `raw` under their bare key.
  const localized: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^\s*\/\/\s*@([\w:-]+)\s*(.*?)\s*$/);
    if (!kv) continue;
    const [, keyRaw, value] = kv as [string, string, string];
    const suffixed = keyRaw.includes(':');
    const key = keyRaw.replace(/:.*$/, ''); // @name:en → @name
    (h.raw[key] ??= []).push(value);
    if (suffixed) {
      if (!(key in localized)) localized[key] = value;
      continue; // a locale variant never sets a canonical field, nor counts as a @match/@grant/…
    }
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
        // @include is glob-semantics in Tampermonkey; only promote to a match pattern when doing so
        // cannot widen it, i.e. when the host carries no wildcard beyond a leading "*." or a bare "*".
        const p = includeHostIsPromotable(value) ? toMatchPattern(value) : null;
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
      case 'connect': if (value && !h.connect.includes(value)) h.connect.push(value); break;
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
      case 'inject-into': if (h.injectInto === undefined) h.injectInto = value; break;
      case 'sandbox': if (h.sandbox === undefined) h.sandbox = value; break;
    }
  }
  if (!h.name && localized['name']) h.name = localized['name']!;
  if (!h.description && localized['description']) h.description = localized['description']!;
  return h;
}

/**
 * True when an @include value's host part is safe to turn into a Chrome match pattern: either no
 * wildcard at all, a bare "*" host, or the leading "*." subdomain form. `*.foo.*` or `*example*`
 * mean something wider as globs than any pattern would, so those stay globs.
 */
function includeHostIsPromotable(v: string): boolean {
  const s = v.trim();
  if (!s || /^\/.*\/$/.test(s)) return false;
  if (s === '*' || s === '*://*' || s === '*://*/') return true;
  const m = s.match(/^(?:\*|https?\*?|file|ftp):\/\/([^/]*)/);
  if (!m) return false;
  const host = m[1]!;
  return host === '*' || !host.replace(/^\*\./, '').includes('*');
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

/**
 * The header of a mod the model wrote. The model tests in the isolated USER_SCRIPT world, so the
 * header has to say "isolated" in a way that survives every rebuild from this text: a later Save,
 * the dashboard's source editor, an export installed somewhere else. It used to say `@grant none`,
 * which every userscript manager (and worldFor below) reads as "run in the page", so the first
 * save's forced world was lost on the second. There is no `@grant` line now (no GM functions, and
 * nothing that means the page), plus the two managers' own isolated-world markers: Violentmonkey's
 * `@inject-into content` and Tampermonkey's `@sandbox DOM`. worldFor honours both.
 */
export const ISOLATED_MARKERS = ['// @inject-into content', '// @sandbox     DOM'];

export function buildSource(p: ModProposal): string {
  const lines = [
    '// ==UserScript==',
    `// @name        ${p.name}`,
    `// @description ${p.description}`,
    '// @version     1.0',
    ...p.matches.map((m) => `// @match       ${m}`),
    ...ISOLATED_MARKERS,
    '// ==/UserScript==',
    '',
    p.code.trim(),
    '',
  ];
  return lines.join('\n');
}

/**
 * The world a header asks for. `@grant none` means "run in the page context" in Tampermonkey and
 * Violentmonkey, and unsafeWindow needs the page too — unless the header also names the isolated
 * world outright, with Violentmonkey's `@inject-into content` or Tampermonkey's `@sandbox DOM`, which
 * both managers let override it. Only that direction is honoured: `@inject-into page` on a script
 * with GM grants would cost it its GM functions here (the page world gets no capability), so the
 * other values leave the @grant rule to decide, as before.
 */
export function worldFor(h: Pick<Header, 'grants' | 'injectInto' | 'sandbox'>): Mod['world'] {
  if (h.injectInto?.toLowerCase() === 'content' || h.sandbox?.toLowerCase() === 'dom') return 'USER_SCRIPT';
  if (h.grants.includes('none') || h.grants.includes('unsafeWindow')) return 'MAIN';
  return 'USER_SCRIPT';
}

/**
 * Mods written by the model: our own scripts, no GM API, isolated world. The world comes from the
 * header like any other mod's; forcing it here is what used to hide that the header disagreed.
 */
export function modFromProposal(p: ModProposal, existing?: Mod): Mod {
  return modFromSource(buildSource(p), existing);
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
    connect: h.connect,
    requires: existing?.requires ?? [],
    resources: existing?.resources ?? [],
    downloadUrl: h.downloadUrl ?? existing?.downloadUrl,
    // Where it was shared is a fact about the mod, not about this text: an edit, an update from its
    // download URL or a reinstall over it keeps the gist and Greasy Fork links it already had.
    ...(existing?.share ? { share: existing.share } : {}),
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
    connect: h.connect,
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

/** The `@grant none` line the generated header carried before ISOLATED_MARKERS replaced it. */
const LEGACY_GRANT_NONE = /^\/\/ @grant       none$/m;

/**
 * A mod saved by an older version whose header disagrees with the world it runs in, in the one
 * case that can be told apart for certain: isolated, yet its header is exactly the old generated
 * one, `@grant none` and all. Only modFromProposal's forced world ever produced that pair (any
 * other path reads `@grant none` as the page), so this is a first save from chat that has always
 * run isolated. Its header is rewritten to the current one so the NEXT rebuild from the text (a
 * dashboard edit, an open_mod in a chat) keeps it isolated; nothing it does changes.
 *
 * A generated mod that a second save already moved to the page is NOT repaired: its later versions
 * were tested by test_mod in the page world, and the same header typed by a person means the page.
 * Which one a given mod is cannot be told from what was stored, so it is left as it is.
 */
function repairGeneratedHeader(m: Partial<Mod> & { source: string }): (Partial<Mod> & { source: string }) | null {
  if (m.world !== 'USER_SCRIPT' || !LEGACY_GRANT_NONE.test(m.source)) return null;
  const block = m.source.match(/^\/\/ ==UserScript==\n((?:\/\/ @\S+.*\n)*?)\/\/ ==\/UserScript==\n/);
  if (!block || block.index !== 0) return null;
  const keys = block[1]!.split('\n').filter(Boolean).map((l) => l.match(/^\/\/ @(\S+)/)?.[1]);
  if (!keys.every((k) => k === 'name' || k === 'description' || k === 'version' || k === 'match' || k === 'grant')) return null;
  if (keys.filter((k) => k === 'grant').length !== 1 || !/^\/\/ @version     1\.0$/m.test(block[1]!)) return null;
  const source = m.source.replace(LEGACY_GRANT_NONE, ISOLATED_MARKERS.join('\n'));
  return { ...m, source, grants: (m.grants ?? []).filter((g) => g !== 'none') };
}

/** Fill defaults for mods saved by older versions. */
export function normalizeMod(stored: Partial<Mod> & { id: string; source: string }): Mod {
  const m = repairGeneratedHeader(stored) ?? stored;
  const fresh = modFromSource(m.source, undefined);
  return { ...fresh, ...m, requires: m.requires ?? [], resources: m.resources ?? [], grants: m.grants ?? fresh.grants, connect: m.connect ?? fresh.connect, world: m.world ?? fresh.world, runAt: m.runAt ?? fresh.runAt, allFrames: m.allFrames ?? fresh.allFrames, excludeMatches: m.excludeMatches ?? [], includeGlobs: m.includeGlobs ?? [], excludeGlobs: m.excludeGlobs ?? [], version: m.version ?? fresh.version };
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
          // escape every regex metacharacter except "*", which is the glob wildcard
          .replace(/[.+^${}()|[\]\\?\/]/g, '\\$&')
          .replace(/^\\?\*:/, '[a-z]+:')
          .replace(/\*/g, '.*') +
        '$',
    );
    return re.test(url);
  });
}

export function modMatchesUrl(m: Mod, url: string): boolean {
  return urlMatches(url, [...m.matches, ...m.includeGlobs]) && !urlMatches(url, [...m.excludeMatches, ...m.excludeGlobs]);
}
