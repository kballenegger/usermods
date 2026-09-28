// The install banner's detection: is the page in view offering a userscript, and which one?
//
// Runs in the page content script on every top-level page, so the first rule is that it must cost
// nothing where there is nothing to find. `detectUserscripts` returns before touching the DOM unless
// the page is on one of four hosts or its document is plain text, and on those it reads only what
// it needs: a handful of elements, the first lines of a file, the first 2 KB of a text document. It
// makes no request of any kind — the install page fetches the script, and only when the user asks.
//
// Written against the standard DOM so the same code is tested under node on saved copies of the
// real pages (test/fixtures/pages, parsed with linkedom) and run in the browser.
import { parseHeader } from './mods.ts';
import { compareVersions } from './version.ts';
import { latestGistRawUrl, parseGistRawUrl, parseGistUrl, parseGreasyForkScriptUrl } from './share.ts';
import type { Mod } from './types';

export type DetectionKind = 'gist' | 'github-blob' | 'raw' | 'greasyfork' | 'openuserjs';

export interface DetectedScript {
  name: string;
  namespace: string;
  version: string;
  /** What Install hands the install page: a URL serving the script's source. */
  installUrl: string;
  /** @downloadURL from the header, when the page showed it. */
  downloadUrl?: string;
}

export interface Detection {
  kind: DetectionKind;
  scripts: DetectedScript[];
  /** For a gist page: which gist, so a user's own shared mod does not nag. */
  gist?: { user: string; id: string };
}

/** Hosts whose pages are read at all. Everything else is only a plain-text check. */
export const BANNER_HOSTS = ['gist.github.com', 'github.com', 'greasyfork.org', 'www.greasyfork.org', 'openuserjs.org'];

/** Document types a raw script is served as. */
const TEXT_TYPES = new Set(['text/plain', 'text/javascript', 'application/javascript', 'application/x-javascript', 'application/ecmascript']);

/** How much of a text document is looked at for the header's opening line. */
export const RAW_SNIFF_BYTES = 2048;
/** How much is parsed once the opening line is there: enough for any real header. */
const RAW_HEADER_BYTES = 16_384;
/** How many rendered source lines are read for a header on a gist or blob page. */
const HEADER_LINES = 120;

const HEADER_OPEN = /\/\/\s*==UserScript==/;
const HEADER_CLOSE = /\/\/\s*==\/UserScript==/;

/** Would a page at this URL, with this document type, even be looked at? The cheap gate. */
export function worthLooking(href: string, contentType: string): boolean {
  let host = '';
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  return BANNER_HOSTS.includes(host) || TEXT_TYPES.has(contentType.toLowerCase());
}

function header(text: string): { name: string; namespace: string; version: string; downloadUrl?: string } | null {
  if (!HEADER_OPEN.test(text)) return null;
  const h = parseHeader(text);
  if (!h.name && !HEADER_CLOSE.test(text)) return null;
  return { name: h.name, namespace: h.raw['namespace']?.[0]?.trim() ?? '', version: h.version, ...(h.downloadUrl ? { downloadUrl: h.downloadUrl } : {}) };
}

function linesText(els: ArrayLike<Element>): string {
  const out: string[] = [];
  for (let i = 0; i < els.length && i < HEADER_LINES; i++) {
    const t = els[i]!.textContent ?? '';
    out.push(t.replace(/\n$/, ''));
    if (HEADER_CLOSE.test(t)) break;
  }
  return out.join('\n');
}

/** The file name at the end of a URL path, decoded. */
function lastSegment(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(seg);
  } catch {
    return '';
  }
}

const stem = (file: string) => file.replace(/\.user\.js$/i, '');

/**
 * (a) A gist page with one or more `.user.js` files. Read from the page: each file's "Raw" link
 * names the file and gives the gist, and the rendered lines under it carry the header. The Raw link
 * pins a revision, so the install URL is turned into the sha-less "always latest" one — installing
 * from a gist should follow the gist.
 */
function detectGist(doc: Document, href: string): Detection | null {
  const g = parseGistUrl(href);
  // The gist's own page (or a pinned revision of it). Not /edit, not /revisions, not the new-gist
  // form: those are pages the user is writing, and a banner there is a nag.
  if (!g || (g.rest !== '' && !/^[0-9a-f]{40}$/i.test(g.rest))) return null;
  const scripts: DetectedScript[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="/raw/"]'))) {
    const abs = absolute(a.getAttribute('href') ?? '', href);
    const raw = parseGistRawUrl(abs);
    if (!raw || raw.id !== g.id || !/\.user\.js$/i.test(raw.fileName) || seen.has(raw.fileName)) continue;
    seen.add(raw.fileName);
    const file = a.closest('.file');
    const h = file ? header(linesText(file.querySelectorAll('.js-file-line, .blob-code-inner'))) : null;
    scripts.push({
      name: h?.name || stem(raw.fileName),
      namespace: h?.namespace ?? '',
      version: h?.version ?? '',
      installUrl: latestGistRawUrl(abs) ?? abs,
      ...(h?.downloadUrl ? { downloadUrl: h.downloadUrl } : {}),
    });
  }
  return scripts.length ? { kind: 'gist', scripts, gist: { user: g.user, id: g.id } } : null;
}

/**
 * Read the rawLines array out of GitHub's embedded page data without parsing the whole blob (which
 * can be megabytes): scan the JSON strings after `"rawLines":[` one at a time, stopping at the end
 * of the header.
 */
export function rawLinesHeader(json: string): string {
  const at = json.indexOf('"rawLines":[');
  if (at < 0) return '';
  const re = /\s*"((?:[^"\\]|\\.)*)"\s*(,|\])/y;
  re.lastIndex = at + '"rawLines":['.length;
  const out: string[] = [];
  for (let i = 0; i < HEADER_LINES; i++) {
    const m = re.exec(json);
    if (!m) break;
    let line = '';
    try {
      line = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      break;
    }
    out.push(line);
    if (HEADER_CLOSE.test(line) || m[2] === ']') break;
  }
  return out.join('\n');
}

/**
 * (b) A github.com blob page of a `.user.js` file. The page's own Raw button is the install URL
 * (github.com/…/raw/… redirects to raw.githubusercontent.com, and keeps a branch ref a branch ref);
 * the header comes from the rendered lines, or the read-only textarea, or the embedded page data,
 * whichever this revision of GitHub's code view has.
 */
function detectBlob(doc: Document, href: string): Detection | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname !== 'github.com' || parts.length < 5 || parts[2] !== 'blob' || !/\.user\.js$/i.test(u.pathname)) return null;
  const rawButton = doc.querySelector<HTMLAnchorElement>('a[data-testid="raw-button"], a#raw-url');
  const installUrl = rawButton?.getAttribute('href') ? absolute(rawButton.getAttribute('href')!, href) : `https://github.com/${parts[0]}/${parts[1]}/raw/${parts.slice(3).join('/')}`;
  let text = linesText(doc.querySelectorAll('.react-file-line, .js-file-line'));
  if (!HEADER_OPEN.test(text)) {
    const ta = doc.querySelector<HTMLTextAreaElement>('#read-only-cursor-text-area');
    text = (ta?.value || ta?.textContent || '').slice(0, RAW_HEADER_BYTES);
  }
  if (!HEADER_OPEN.test(text)) {
    for (const s of Array.from(doc.querySelectorAll('script[data-target="react-app.embeddedData"]'))) {
      const t = rawLinesHeader(s.textContent ?? '');
      if (HEADER_OPEN.test(t)) {
        text = t;
        break;
      }
    }
  }
  const h = header(text);
  const file = decodeURIComponent(parts[parts.length - 1]!);
  return {
    kind: 'github-blob',
    scripts: [{ name: h?.name || stem(file), namespace: h?.namespace ?? '', version: h?.version ?? '', installUrl, ...(h?.downloadUrl ? { downloadUrl: h.downloadUrl } : {}) }],
  };
}

/**
 * (c) A document that IS a script: a raw view the .user.js redirect did not catch (a `?raw` URL, a
 * paste site, a raw link without the .user.js suffix). Only a plain-text document is looked at, and
 * only its first 2 KB for the opening line.
 */
function detectRaw(doc: Document, href: string, contentType: string): Detection | null {
  if (!TEXT_TYPES.has(contentType.toLowerCase())) return null;
  const body = doc.body;
  if (!body) return null;
  // Chrome and Safari render a text document as one <pre>. Its first text node is the file, and a
  // slice of it costs nothing like textContent on the whole body would.
  const pre = body.querySelector('pre') ?? body;
  const first = pre.firstChild;
  const all = (first && first.nodeType === 3 ? (first as Text).data : pre.textContent) ?? '';
  if (!HEADER_OPEN.test(all.slice(0, RAW_SNIFF_BYTES))) return null;
  const h = header(all.slice(0, RAW_HEADER_BYTES));
  if (!h) return null;
  return { kind: 'raw', scripts: [{ name: h.name || stem(lastSegment(href)) || 'Untitled script', namespace: h.namespace, version: h.version, installUrl: href, ...(h.downloadUrl ? { downloadUrl: h.downloadUrl } : {}) }] };
}

/**
 * (d) Greasy Fork and OpenUserJS script pages. Their Install buttons already link a .user.js URL,
 * which the redirect catches, so the banner's only job here is to say "installed" or "update
 * available" — the caller hides it when neither is true. Greasy Fork writes the identity on the
 * button itself (data-script-name / -namespace / -version).
 */
function detectGreasyFork(doc: Document, href: string): Detection | null {
  const r = parseGreasyForkScriptUrl(href);
  if (!r || (r.rest !== '' && r.rest !== 'code')) return null;
  const a = doc.querySelector<HTMLAnchorElement>('a.install-link[data-script-name]');
  if (!a?.getAttribute('href')) return null;
  return {
    kind: 'greasyfork',
    scripts: [
      {
        name: a.getAttribute('data-script-name') ?? '',
        namespace: a.getAttribute('data-script-namespace') ?? '',
        version: a.getAttribute('data-script-version') ?? '',
        installUrl: absolute(a.getAttribute('href')!, href),
      },
    ],
  };
}

function detectOpenUserJs(doc: Document, href: string): Detection | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.hostname !== 'openuserjs.org' || !/^\/scripts\/[^/]+\/[^/]+\/?$/.test(u.pathname)) return null;
  const a = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href^="/install/"]')).find((x) => /\.user\.js$/i.test(x.getAttribute('href') ?? '') && !/\.min\.user\.js$/i.test(x.getAttribute('href') ?? ''));
  if (!a) return null;
  const name = doc.querySelector('a.script-name')?.textContent?.trim() ?? '';
  // "Version: 1.4.8+d4aced7" — the part after the + is OpenUserJS's content hash, not the version.
  const versionEl = Array.from(doc.querySelectorAll('p')).find((p) => /^\s*Version:/.test(p.textContent ?? ''))?.querySelector('code');
  const version = (versionEl?.firstChild?.textContent ?? '').trim();
  return { kind: 'openuserjs', scripts: [{ name: name || stem(lastSegment(absolute(a.getAttribute('href')!, href))), namespace: '', version, installUrl: absolute(a.getAttribute('href')!, href) }] };
}

function absolute(maybeRelative: string, base: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

/** Everything the banner could offer on this page, or null. */
export function detectUserscripts(doc: Document, href: string, contentType = doc.contentType ?? ''): Detection | null {
  if (!worthLooking(href, contentType)) return null;
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    return null;
  }
  if (host === 'gist.github.com') return detectGist(doc, href);
  if (host === 'github.com') return detectBlob(doc, href);
  if (host === 'greasyfork.org' || host === 'www.greasyfork.org') return detectGreasyFork(doc, href);
  if (host === 'openuserjs.org') return detectOpenUserJs(doc, href);
  return detectRaw(doc, href, contentType);
}

// ---------------------------------------------------------------------------
// Already installed?
// ---------------------------------------------------------------------------

/**
 * One spelling per script location, so the same script reached two ways compares equal: a gist raw
 * URL with or without its revision sha, and Greasy Fork's `update.greasyfork.org/scripts/<id>/…`
 * versus `greasyfork.org/<locale>/scripts/<id>-<slug>/code/…`.
 */
export function canonicalScriptUrl(url: string): string {
  const gist = parseGistRawUrl(url);
  if (gist) return `gist:${gist.user.toLowerCase()}/${gist.id}/${gist.fileName}`;
  try {
    const u = new URL(url);
    const gf = u.pathname.match(/\/scripts\/(\d+)(?:[-/]|$)/);
    if (gf && /(^|\.)greasyfork\.org$|(^|\.)sleazyfork\.org$/.test(u.hostname)) return `greasyfork:${gf[1]}`;
    return `${u.hostname.toLowerCase()}${u.pathname}`;
  } catch {
    return url.trim();
  }
}

export type InstallState =
  | { kind: 'install' }
  | { kind: 'installed'; modId: string; version: string }
  | { kind: 'update'; modId: string; from: string; to: string };

/**
 * Is this script already one of the user's mods, and is the page offering a newer version?
 *
 * Identity is the download URL when both sides have one (canonicalised as above), else @name AND
 * @namespace from the header, both required when the page gives a namespace. Name alone is never
 * identity: two unrelated scripts called "Dark mode" are two scripts. A page that shows no namespace
 * (OpenUserJS) can therefore only match by URL.
 */
export function installState(script: DetectedScript, mods: Array<Pick<Mod, 'id' | 'name' | 'version' | 'source' | 'downloadUrl'>>): InstallState {
  const urls = new Set([script.installUrl, script.downloadUrl].filter((u): u is string => !!u).map(canonicalScriptUrl));
  const found = mods.find((m) => {
    if (m.downloadUrl && urls.has(canonicalScriptUrl(m.downloadUrl))) return true;
    if (!script.namespace || !script.name) return false;
    const h = parseHeader(m.source);
    const ns = h.raw['namespace']?.[0]?.trim() ?? '';
    return ns === script.namespace && (h.name || m.name) === script.name;
  });
  if (!found) return { kind: 'install' };
  if (script.version && found.version && compareVersions(script.version, found.version) > 0) {
    return { kind: 'update', modId: found.id, from: found.version, to: script.version };
  }
  return { kind: 'installed', modId: found.id, version: found.version };
}

/**
 * Should the banner show at all for this state? Everywhere but Greasy Fork and OpenUserJS it offers
 * Install; there, the site's own Install button already does that, so the banner only appears when
 * it has something the page does not say — an update, or that it is already installed.
 */
export function bannerWorthShowing(kind: DetectionKind, state: InstallState): boolean {
  if (kind === 'greasyfork' || kind === 'openuserjs') return state.kind === 'update';
  return true;
}

// ---------------------------------------------------------------------------
// Dismissals
// ---------------------------------------------------------------------------

export const BANNER_DISMISSED_KEY = 'banner:dismissed';
/** Remembered dismissals, newest first. Old ones fall off the end. */
export const BANNER_DISMISSED_CAP = 200;

/** The page a dismissal is remembered for: no fragment, and no query on the four known hosts. */
export function dismissKey(href: string): string {
  try {
    const u = new URL(href);
    return BANNER_HOSTS.includes(u.hostname) ? `${u.origin}${u.pathname}` : `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return href;
  }
}

export function addDismissal(list: string[] | undefined, href: string, cap = BANNER_DISMISSED_CAP): string[] {
  const key = dismissKey(href);
  return [key, ...(list ?? []).filter((k) => k !== key)].slice(0, cap);
}

export function isDismissed(list: string[] | undefined, href: string): boolean {
  return (list ?? []).includes(dismissKey(href));
}

/** The banner's words. */
export function bannerText(script: DetectedScript, state: InstallState): { message: string; action: string | null } {
  const name = script.name || 'this userscript';
  if (state.kind === 'installed') return { message: `“${name}” is installed in usermods.`, action: null };
  if (state.kind === 'update') return { message: `usermods has “${name}” v${state.from}. This page has v${state.to}.`, action: `Update to v${state.to}` };
  return { message: `usermods can install “${name}”.`, action: 'Install' };
}
