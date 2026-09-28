// Sharing a mod to GitHub Gist and Greasy Fork, the pure half.
//
// usermods never publishes anything itself. It opens the site's own editor in the user's own
// logged-in tab, fills the form, points at the site's save button and waits; the user presses it.
// No OAuth, no token, no request of ours. What lives here is everything about that which can be
// decided without a browser: which URL is which, what version the shared copy carries, what header
// lines it needs, and what gets remembered once the site has saved it. The I/O is in
// entrypoints/background.ts (tabs and the session record) and entrypoints/content.ts (the filling).
//
// The .ts extensions on the value imports are load-bearing, for the node test runner; see
// lib/install.ts.
import { reheaderFields } from './artifact.ts';
import { parseHeader } from './mods.ts';
import type { Mod, ModShare } from './types';

export type ShareTarget = 'gist' | 'greasyfork';
export type ShareMode = 'new' | 'update';

// ---------------------------------------------------------------------------
// GitHub Gist URLs
// ---------------------------------------------------------------------------

/** The new-gist editor. Signed in, gist.github.com's root IS the form. */
export const GIST_NEW_URL = 'https://gist.github.com/';

/**
 * First path segments on gist.github.com that are the site's own pages rather than a user. A gist
 * URL is `/<user>/<id>`, and `/starred/…` or `/search?…` must never be mistaken for one.
 */
const GIST_RESERVED = new Set(['auth', 'discover', 'forked', 'join', 'login', 'logout', 'mine', 'search', 'session', 'starred', 'stars', 'new', 'settings', 'assets', 'about']);

/** Gist ids are hex: 20 characters for old gists, 32 for everything made since 2014. */
const GIST_ID = /^[0-9a-f]{20,40}$/i;

export interface GistRef {
  user: string;
  id: string;
  /** What follows the id: '' for the gist page, 'edit', 'raw/…', 'revisions', … */
  rest: string;
}

/** Read `https://gist.github.com/<user>/<id>[/rest]`, or null for anything else. */
export function parseGistUrl(url: string): GistRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'gist.github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [user, id, ...rest] = parts as [string, string, ...string[]];
  if (GIST_RESERVED.has(user.toLowerCase()) || !/^[A-Za-z0-9-]{1,39}$/.test(user) || !GIST_ID.test(id)) return null;
  return { user, id, rest: rest.join('/') };
}

/** The gist's own page: the URL the tab lands on after "Create … gist" or "Update … gist". */
export function isGistPage(url: string): boolean {
  const g = parseGistUrl(url);
  return !!g && g.rest === '';
}

export function isGistEditUrl(url: string): boolean {
  return parseGistUrl(url)?.rest === 'edit';
}

/** The new-gist form: gist.github.com's root (and its legacy /new alias). */
export function isGistNewUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'gist.github.com' && (u.pathname === '/' || u.pathname === '/new');
  } catch {
    return false;
  }
}

export function gistPageUrl(user: string, id: string): string {
  return `https://gist.github.com/${user}/${id}`;
}

export function gistEditUrl(user: string, id: string): string {
  return `https://gist.github.com/${user}/${id}/edit`;
}

/**
 * The install link: the raw URL WITHOUT a revision sha, which GitHub always serves at the latest
 * revision. The "Raw" button on a gist page links a sha'd URL, which is frozen at that revision
 * forever and would make a useless @updateURL.
 */
export function gistRawUrl(user: string, id: string, fileName: string): string {
  return `https://gist.githubusercontent.com/${user}/${id}/raw/${encodeURIComponent(fileName)}`;
}

export interface GistRawRef {
  user: string;
  id: string;
  /** Present when the URL pins a revision. */
  sha?: string;
  fileName: string;
}

/**
 * Read a gist raw URL, in either spelling: `gist.githubusercontent.com/<user>/<id>/raw/[<sha>/]<file>`
 * or the `gist.github.com/<user>/<id>/raw/[<sha>/]<file>` form the Raw button links (which
 * redirects to the first).
 */
export function parseGistRawUrl(url: string): GistRawRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'gist.githubusercontent.com' && u.hostname !== 'gist.github.com')) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[2] !== 'raw') return null;
  const [user, id] = parts as [string, string];
  if (!GIST_ID.test(id)) return null;
  const tail = parts.slice(3);
  const sha = tail.length > 1 && /^[0-9a-f]{40}$/i.test(tail[0]!) ? tail.shift() : undefined;
  if (tail.length !== 1) return null;
  let fileName = tail[0]!;
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    /* keep it as written */
  }
  return { user, id, ...(sha ? { sha } : {}), fileName };
}

/** Any raw link to a gist file, turned into the sha-less "always latest" install link. */
export function latestGistRawUrl(url: string): string | null {
  const r = parseGistRawUrl(url);
  return r ? gistRawUrl(r.user, r.id, r.fileName) : null;
}

// ---------------------------------------------------------------------------
// Greasy Fork URLs
// ---------------------------------------------------------------------------

/** The "Post a new script" form. Greasy Fork redirects to the sign-in page when signed out. */
export const GREASYFORK_NEW_URL = 'https://greasyfork.org/en/script_versions/new';

export function greasyForkNewVersionUrl(id: string): string {
  return `https://greasyfork.org/en/scripts/${id}/versions/new`;
}

function greasyForkPath(url: string): string[] | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'greasyfork.org' && u.hostname !== 'www.greasyfork.org')) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  // An optional locale first: /en/, /zh-CN/, /pt-BR/.
  if (parts[0] && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(parts[0]) && parts[0] !== 'scripts') parts.shift();
  return parts;
}

export interface GreasyForkRef {
  id: string;
  slug: string;
  /** What follows `/scripts/<id>-<slug>`: '' for the script page itself. */
  rest: string;
}

/** Read `greasyfork.org/[<locale>/]scripts/<id>[-<slug>][/rest]`, or null. */
export function parseGreasyForkScriptUrl(url: string): GreasyForkRef | null {
  const parts = greasyForkPath(url);
  if (!parts || parts[0] !== 'scripts' || !parts[1]) return null;
  const m = parts[1].match(/^(\d+)(?:-(.*))?$/);
  if (!m) return null;
  return { id: m[1]!, slug: m[2] ?? '', rest: parts.slice(2).join('/') };
}

/** The script's own page: where Greasy Fork lands after "Post script" succeeds. */
export function isGreasyForkScriptPage(url: string): boolean {
  return parseGreasyForkScriptUrl(url)?.rest === '';
}

/** Either form Greasy Fork posts a script from: a new script, or a new version of one. */
export function isGreasyForkPostForm(url: string): boolean {
  const parts = greasyForkPath(url);
  if (!parts) return false;
  if (parts[0] === 'script_versions' && parts[1] === 'new') return true;
  const r = parseGreasyForkScriptUrl(url);
  return !!r && r.rest === 'versions/new';
}

export function isGreasyForkSignIn(url: string): boolean {
  const parts = greasyForkPath(url);
  return !!parts && parts[0] === 'users' && parts[1] === 'sign_in';
}

/** GitHub's sign-in pages, which a signed-out gist share passes through. */
export function isGitHubSignIn(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com' && u.hostname !== 'gist.github.com') return false;
    return /^\/(login|session|sessions\/|auth\/|join|signup)/.test(u.pathname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The shared copy: file name, version, header lines
// ---------------------------------------------------------------------------

/**
 * `<slug-of-mod-name>.user.js` — the same name Download gives the file (lib/dashboard.ts
 * exportFilename; a test holds the two together). Spelled out here rather than imported, because
 * this module is bundled into the page content script and lib/dashboard.ts brings the chat store.
 */
export function shareFileName(name: string): string {
  const safe = name
    .replace(/[^\w.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
  return `${safe || 'mod'}.user.js`;
}

/**
 * The next patch version: `1.2.3` → `1.2.4`, `1.0` → `1.0.1`, `2026.1.19` → `2026.1.20`. A version
 * with a pre-release or other suffix (`1.2.0-beta`) moves to the next patch of its numeric core,
 * which orders above it. No version at all starts at 1.0.0.
 */
export function bumpPatch(version: string): string {
  const v = (version ?? '').trim().replace(/^v/i, '');
  const core = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!core) return '1.0.0';
  const [, major, minor, patch] = core as [string, string, string | undefined, string | undefined];
  const hasSuffix = v.length > core[0].length && !/^\.\d/.test(v.slice(core[0].length));
  if (patch === undefined) return `${major}.${minor ?? '0'}.1`;
  // 1.2.0-beta: the release it is heading for is 1.2.0 itself, which already sorts above the beta.
  if (hasSuffix) return `${major}.${minor}.${patch}`;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/** What Greasy Fork checks a script's header for. `match` means @match or @include. */
export type GreasyForkKey = 'name' | 'namespace' | 'version' | 'description' | 'match' | 'license';

/** Header keys Greasy Fork expects that this source does not have. */
export function greasyForkMissing(source: string): GreasyForkKey[] {
  const h = parseHeader(source);
  const has = (k: string) => (h.raw[k] ?? []).some((v) => v.trim().length > 0);
  const missing: GreasyForkKey[] = [];
  if (!h.name) missing.push('name');
  if (!has('namespace')) missing.push('namespace');
  if (!h.version) missing.push('version');
  if (!h.description) missing.push('description');
  if (!has('match') && !has('include')) missing.push('match');
  if (!has('license')) missing.push('license');
  return missing;
}

/** What the panel suggests for a header line Greasy Fork wants and the mod lacks. */
export const SUGGESTED_LICENSE = 'MIT';
export const SUGGESTED_NAMESPACE = 'usermods';

export interface PreparedShare {
  target: ShareTarget;
  mode: ShareMode;
  /** The exact text to put in the site's editor, and to save on the mod. */
  source: string;
  /** The version the source had before this share (for "did the editor really take it?"). */
  previousVersion: string;
  version: string;
  fileName: string;
  description: string;
  /** Where the tab opens. */
  openUrl: string;
  /** Header lines Greasy Fork wants that are still missing after the additions asked for. */
  missing: GreasyForkKey[];
}

export interface ShareOptions {
  /** Add `@license MIT` — only ever on the user's say-so in the panel. */
  addLicense?: boolean;
  /** Add `@namespace usermods` when the header has none. */
  addNamespace?: boolean;
  /** Share as a new gist even though one is remembered (the remembered one was deleted). */
  forceNew?: boolean;
}

/**
 * Everything a share needs, decided in one place.
 *
 * - A first share to a site keeps the version as it is, adding 1.0.0 when there is none (Greasy
 *   Fork and every update check need one).
 * - An update — "Update gist", "Post new version on Greasy Fork" — bumps the patch version, so the
 *   copy people installed from the link sees a newer @version and updates.
 * - Greasy Fork's missing header lines are added only when the options say so; the caller asks.
 */
export function prepareShare(mod: Pick<Mod, 'name' | 'description' | 'source' | 'version' | 'share'>, target: ShareTarget, opts: ShareOptions = {}): PreparedShare {
  const header = parseHeader(mod.source);
  const previousVersion = header.version || '';
  const shared = target === 'gist' ? !!mod.share?.gist : !!mod.share?.greasyFork;
  const mode: ShareMode = shared && !opts.forceNew ? 'update' : 'new';
  const version = mode === 'update' ? bumpPatch(previousVersion) : previousVersion || '1.0.0';
  const fields: Record<string, string | null> = {};
  if (version !== previousVersion) fields['version'] = version;
  if (target === 'greasyfork') {
    if (opts.addLicense && !(header.raw['license'] ?? []).length) fields['license'] = SUGGESTED_LICENSE;
    if (opts.addNamespace && !(header.raw['namespace'] ?? []).length) fields['namespace'] = SUGGESTED_NAMESPACE;
  }
  const source = Object.keys(fields).length ? reheaderFields(mod.source, fields) : mod.source;
  const fileName = (mode === 'update' && mod.share?.gist?.fileName) || shareFileName(mod.name);
  const openUrl =
    target === 'gist'
      ? mode === 'update' && mod.share?.gist
        ? gistEditUrl(mod.share.gist.user, mod.share.gist.id)
        : GIST_NEW_URL
      : mode === 'update' && mod.share?.greasyFork
        ? greasyForkNewVersionUrl(mod.share.greasyFork.id)
        : GREASYFORK_NEW_URL;
  return {
    target,
    mode,
    source,
    previousVersion,
    version,
    fileName,
    description: header.description || mod.description || '',
    openUrl,
    missing: target === 'greasyfork' ? greasyForkMissing(source) : [],
  };
}

/**
 * What a created gist changes about the mod: the gist is remembered, and the header's
 * @updateURL/@downloadURL point at its always-latest raw URL, so the copy anyone installs from the
 * link — and this one, through Update — follows new versions. Nothing is bumped here.
 */
export function recordGist(mod: Mod, gist: { user: string; id: string; fileName: string }, at = Date.now()): Mod {
  const rawUrl = gistRawUrl(gist.user, gist.id, gist.fileName);
  const share: ModShare = {
    ...mod.share,
    gist: { url: gistPageUrl(gist.user, gist.id), user: gist.user, id: gist.id, fileName: gist.fileName, rawUrl, savedAt: at },
  };
  const source = reheaderFields(mod.source, { updateURL: rawUrl, downloadURL: rawUrl });
  return { ...mod, source, downloadUrl: rawUrl, share, updatedAt: at };
}

/** A post Greasy Fork accepted: remember the script page, so the next one is a new version. */
export function recordGreasyFork(mod: Mod, url: string, at = Date.now()): Mod {
  const ref = parseGreasyForkScriptUrl(url);
  if (!ref) return mod;
  let clean = url;
  try {
    const u = new URL(url);
    clean = `${u.origin}${u.pathname}`;
  } catch {
    /* keep it */
  }
  return { ...mod, share: { ...mod.share, greasyFork: { url: clean, id: ref.id, savedAt: at } }, updatedAt: at };
}

/**
 * Pick the .user.js file a just-saved gist holds for this share: the one with the name that was
 * filled in, else the only .user.js file there is, else the first. The user can rename the file
 * before pressing Create, which is why the page is asked rather than the name assumed.
 */
export function pickGistFile(files: string[], wanted: string): string | null {
  const scripts = files.filter((f) => /\.user\.js$/i.test(f));
  if (scripts.includes(wanted)) return wanted;
  if (scripts.length) return scripts[0]!;
  return files.includes(wanted) ? wanted : null;
}

// ---------------------------------------------------------------------------
// The in-flight share, as the background remembers it between page loads
// ---------------------------------------------------------------------------

export type SharePhase = 'opening' | 'signin' | 'filled' | 'fallback' | 'notfound';

export interface ShareSession {
  tabId: number;
  modId: string;
  target: ShareTarget;
  mode: ShareMode;
  source: string;
  fileName: string;
  description: string;
  version: string;
  previousVersion: string;
  /** The gist being updated, for recognising the page the update lands on. */
  gist?: { user: string; id: string };
  phase: SharePhase;
  startedAt: number;
}

/** How long a share waits for the user (sign-in included) before it stops watching the tab. */
export const SHARE_SESSION_TTL_MS = 30 * 60_000;

export type ShareStep =
  | { kind: 'fill' }
  | { kind: 'signin' }
  | { kind: 'record-gist'; user: string; id: string }
  | { kind: 'record-greasyfork'; url: string }
  | { kind: 'wait' }
  | { kind: 'abandon' };

/**
 * What a finished page load in a share's tab means. Pure, so every URL the two sites can put a tab
 * on is decided in a test rather than in a listener.
 *
 * - The editor, not yet filled: fill it. (Filled already — say after Greasy Fork re-rendered the
 *   form with validation errors — is left alone, so the user's own corrections are not overwritten.)
 * - A sign-in page: say so, and keep waiting; the site brings the user back to the editor.
 * - The saved page after the fill: record it.
 * - Anywhere else on the same site: keep waiting (the user may be looking around). Another site
 *   altogether: the user has moved on; stop watching.
 */
export function shareStep(s: Pick<ShareSession, 'target' | 'mode' | 'phase' | 'gist'>, url: string): ShareStep {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return { kind: 'wait' };
  }
  const filled = s.phase === 'filled' || s.phase === 'fallback';
  if (s.target === 'gist') {
    if (host !== 'gist.github.com' && host !== 'github.com') return { kind: 'abandon' };
    if (isGitHubSignIn(url)) return { kind: 'signin' };
    const editor = s.mode === 'update' && s.gist ? isGistEditUrl(url) && parseGistUrl(url)?.id === s.gist.id : isGistNewUrl(url);
    if (editor) return filled ? { kind: 'wait' } : { kind: 'fill' };
    const g = parseGistUrl(url);
    if (g && g.rest === '' && filled) {
      if (s.mode === 'update' && s.gist && g.id !== s.gist.id) return { kind: 'wait' };
      return { kind: 'record-gist', user: g.user, id: g.id };
    }
    return { kind: 'wait' };
  }
  if (host !== 'greasyfork.org' && host !== 'www.greasyfork.org') return { kind: 'abandon' };
  if (isGreasyForkSignIn(url)) return { kind: 'signin' };
  if (isGreasyForkPostForm(url)) return filled ? { kind: 'wait' } : { kind: 'fill' };
  if (filled && isGreasyForkScriptPage(url)) return { kind: 'record-greasyfork', url };
  return { kind: 'wait' };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The Export menu's share items, which change once the mod has been shared there. */
export function shareMenuLabels(mod: Pick<Mod, 'share'>): { gist: string; greasyFork: string } {
  return {
    gist: mod.share?.gist ? 'Update gist' : 'Share as Gist',
    greasyFork: mod.share?.greasyFork ? 'Post new version on Greasy Fork' : 'Publish on Greasy Fork',
  };
}

/** The hint bubble's words, one place, so the docs and the smoke can quote them exactly. */
export const HINTS = {
  gistNew:
    'Your script is filled in. Press “Create secret gist” to save it: only people with the link can see a secret gist. “Create public gist” (in the menu beside it) also lists it on your profile. usermods will not press it for you.',
  gistUpdate: (version: string) =>
    `Version ${version} is filled in. Press “Update secret gist” (or “Update public gist”, whichever this gist is) to publish it. Everyone who installed from the link gets it on their next update.`,
  greasyForkNew: 'Your script is filled in. Press “Post script” at the bottom of the form to publish it. Everything on Greasy Fork is public.',
  greasyForkUpdate: (version: string) => `Version ${version} is filled in. Press “Post new version” at the bottom of the form to publish it.`,
  greasyForkSync: (rawUrl: string) =>
    `Tip: this mod has a gist. In your script’s Admin tab on Greasy Fork you can sync from ${rawUrl}, and new versions will post themselves.`,
  signInGitHub: 'Sign in to GitHub, then usermods will fill this in.',
  signInGreasyFork: 'Sign in to Greasy Fork, then usermods will fill this in.',
  fallback: (fileName: string, copied: boolean) =>
    copied
      ? `Paste your script here (it is on your clipboard) and name the file ${fileName}.`
      : `usermods could not fill this page in. Press Copy script, paste it here and name the file ${fileName}.`,
  fallbackGreasyFork: (copied: boolean) =>
    copied ? 'Paste your script into the Code box (it is on your clipboard).' : 'usermods could not fill this page in. Press Copy script and paste it into the Code box.',
  gistMissing: 'This gist no longer exists: it may have been deleted. Share it as a new gist instead?',
  savedGist: 'Saved. usermods remembered this gist: your install link is in the Mods tab.',
  savedGreasyFork: 'Posted. usermods remembered this script, so next time Export offers “Post new version”.',
} as const;
