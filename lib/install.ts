// Fetching userscripts from the network: preview before install, and the @require / @resource
// dependencies a script needs baked in at install time (registered code has no network of its own).
import { parseHeader, previewFromSource } from './mods';
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
