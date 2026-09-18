// Fetching userscripts from the network: preview before install, and the @require / @resource
// dependencies a script needs baked in at install time (registered code has no network of its own).
// The .ts extension is load-bearing: the node test runner (--experimental-strip-types) resolves
// these imports literally, and the pure decisions in this file are tested there. Vite resolves it
// either way. lib/dashboard.ts imports lib/chats.ts the same way for the same reason.
import { modFromSource, parseHeader, previewFromSource } from './mods.ts';
import type { Mod, ScriptPreview } from './types';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;

export interface FetchedText {
  text: string;
  bytes: Uint8Array;
  mime: string;
  finalUrl: string;
}

/** GET a URL as text, with a timeout and a size cap so a bad URL cannot hang or blow up storage. */
export async function fetchBinary(url: string): Promise<FetchedText> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be installed: ${url}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(parsed.toString(), { signal: controller.signal, redirect: 'follow', credentials: 'omit' });
  } catch (e) {
    clearTimeout(timer);
    const msg = controller.signal.aborted ? `Timed out after ${FETCH_TIMEOUT_MS / 1000}s` : e instanceof Error ? e.message : String(e);
    throw new Error(`Could not fetch ${url}: ${msg}`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Could not fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error(`Refusing to fetch ${url}: ${(declared / 1048576).toFixed(1)} MB exceeds the 5 MB limit`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error(`Refusing to install ${url}: ${(buf.byteLength / 1048576).toFixed(1)} MB exceeds the 5 MB limit`);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'application/octet-stream';
  return { text: new TextDecoder().decode(buf), bytes: buf, mime, finalUrl: res.url || parsed.toString() };
}

export async function fetchText(url: string): Promise<string> {
  return (await fetchBinary(url)).text;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Download a script and describe it, without saving anything. */
export async function previewFromUrl(url: string): Promise<ScriptPreview> {
  const source = await fetchText(url);
  if (!/\/\/\s*==UserScript==/.test(source)) {
    throw new Error(`That URL does not look like a userscript (no ==UserScript== header): ${url}`);
  }
  return previewFromSource(source, url);
}

/**
 * Fetch every @require and @resource named in the mod's header and store them on the mod.
 * Registered scripts cannot fetch these themselves, so a failure here fails the install.
 */
export async function resolveDependencies(mod: Mod): Promise<Mod> {
  const h = parseHeader(mod.source);
  const requires: Mod['requires'] = [];
  for (const url of h.requires) {
    try {
      requires.push({ url, code: await fetchText(url) });
    } catch (e) {
      throw new Error(`@require failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const resources: Mod['resources'] = [];
  for (const r of h.resources) {
    try {
      const got = await fetchBinary(r.url);
      resources.push({ name: r.name, url: r.url, mime: got.mime, text: got.text, base64: toBase64(got.bytes) });
    } catch (e) {
      throw new Error(`@resource ${r.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  mod.requires = requires;
  mod.resources = resources;
  return mod;
}

/**
 * An edited source as a Mod, keeping everything about the existing mod that is its identity rather
 * than its text: the id, the enabled flag, when it was created, where it came from, and the
 * dependency bodies already fetched for it. Everything the header decides comes from the new text.
 *
 * modFromSource(source, existing) already does most of this: passing the existing mod carries its
 * id, enabled flag, createdAt, downloadUrl (when the edited header names none) and its already
 * fetched @require/@resource bodies forward, which is exactly what an edit should keep.
 *
 * The one field it gets wrong for an edit is `matches`: it falls back to the existing mod's
 * patterns when the new header has none, which is right for an install (a missing @match is an
 * error the caller rejects) and wrong here, where deleting the last @match line has to actually
 * delete it — otherwise the mod goes on running on a site the user just told it to stop running on,
 * and the caller never gets the chance to reject the save. So the shared parse is reused and that
 * one field is overridden with what the header really said.
 */
export function reparseEditedSource(existing: Mod, source: string): Mod {
  return { ...modFromSource(source, existing), matches: parseHeader(source).matches };
}

/**
 * Does this source's @require / @resource set differ from the bodies a mod already carries?
 *
 * The dashboard's source editor asks this before saving: refetching every dependency on every
 * keystroke-sized edit would put a network round trip in front of a one-character CSS change, and
 * NOT refetching when the header's dependency lines moved is the bug that makes the saved mod throw
 * ReferenceError on the next page load, because it is re-registered with the old bodies (or with
 * none at all) under a header that says it needs new ones.
 *
 * Order matters: a script that loads jQuery then a plugin is not the same as one that loads them
 * the other way round, and the registered code concatenates the bodies in header order. A resource
 * is identified by name AND url, since renaming a resource changes what GM_getResourceText returns
 * for a given name even when the bytes are identical.
 *
 * `have.requires` is compared on url alone: the body is whatever that url served at fetch time, and
 * a mod whose header still names the same urls keeps the bodies it has rather than refetching them.
 */
export function dependenciesChanged(
  source: string,
  have: Pick<Mod, 'requires' | 'resources'>,
): boolean {
  const h = parseHeader(source);
  const wantRequires = h.requires;
  const haveRequires = (have.requires ?? []).map((r) => r.url);
  if (wantRequires.length !== haveRequires.length || wantRequires.some((u, i) => u !== haveRequires[i])) return true;
  // A NUL separator, written as an escape rather than an invisible byte in the source, so that no
  // name/url pair can be spelled two ways and compare equal.
  const wantResources = h.resources.map((r) => `${r.name}\u0000${r.url}`);
  const haveResources = (have.resources ?? []).map((r) => `${r.name}\u0000${r.url}`);
  return wantResources.length !== haveResources.length || wantResources.some((k, i) => k !== haveResources[i]);
}
