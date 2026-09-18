// Reading a Tampermonkey backup. Extensions cannot read each other's storage, so migration goes
// through the file Tampermonkey's Utilities tab writes: either a JSON document or a ZIP.
//
// Both shapes are tolerated because Tampermonkey has used several over the years:
//
//   JSON  { "scripts": [ { name, source, enabled, options, storage, file_url, uuid, position } ] }
//         or a bare array of those entries, or a single entry object.
//   ZIP   one entry per script. Older builds write JSON-in-.txt (one script object per file);
//         current builds write <name>.user.js plus optional <name>.options.json and
//         <name>.storage.json siblings.
//
// Everything here is pure: no chrome APIs, no network. The background worker turns these into mods.

/** One script recovered from a backup, in the form the installer wants. */
export interface TmScript {
  name: string;
  source: string;
  enabled: boolean;
  /** GM_setValue store, seeded into gm:<modId>. */
  values: Record<string, unknown>;
  /** Tampermonkey's @downloadURL equivalent, used for updates. */
  downloadUrl?: string;
  uuid?: string;
  position?: number;
}

export interface TmParseResult {
  scripts: TmScript[];
  /** Entries we recognised but could not use, with the reason. */
  skipped: string[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Tampermonkey wraps stored values as {"origin": "...", "value": ...} in some builds and stores
 * them bare in others; and the whole store is sometimes a JSON string. Unwrap both.
 */
export function normalizeValues(raw: unknown): Record<string, unknown> {
  let store = raw;
  if (typeof store === 'string') {
    try {
      store = JSON.parse(store) as unknown;
    } catch {
      return {};
    }
  }
  if (!isObject(store)) return {};
  // Tampermonkey writes the GM store as { data: { key: … }, ts: … }; older builds store it flat.
  // A lone `data` object is that wrapper, so unwrap it before reading the entries.
  if (isObject(store['data']) && !('origin' in (store['data'] as Json) || 'value' in (store['data'] as Json))) {
    store = store['data'];
  }
  if (!isObject(store)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(store)) {
    if (isObject(v) && 'value' in v && ('origin' in v || Object.keys(v).length === 1)) out[k] = (v as { value: unknown }).value;
    else out[k] = v;
  }
  return out;
}

function nameFromSource(source: string): string {
  return source.match(/^\s*\/\/\s*@name\s+(.+?)\s*$/m)?.[1] ?? '';
}

/** Tampermonkey stores the enabled flag on the entry or inside `options`, and it may be a string. */
function enabledOf(entry: Json, options: Json | undefined): boolean {
  for (const v of [entry['enabled'], options?.['enabled']]) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== 'false' && v !== '0';
  }
  return true;
}

function downloadUrlOf(entry: Json, options: Json | undefined): string | undefined {
  const meta = isObject(options?.['meta']) ? (options['meta'] as Json) : undefined;
  for (const v of [entry['file_url'], entry['downloadURL'], entry['download_url'], options?.['file_url'], meta?.['file_url']]) {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return undefined;
}

/** Turn one backup entry (however it was spelled) into a TmScript, or null if it carries no source. */
export function scriptFromEntry(entry: unknown, fallbackName = ''): TmScript | null {
  if (!isObject(entry)) return null;
  const source = [entry['source'], entry['script'], entry['code'], entry['value']].find((v) => typeof v === 'string' && v.includes('==UserScript==')) as
    | string
    | undefined;
  if (!source) return null;
  const options = isObject(entry['options']) ? (entry['options'] as Json) : undefined;
  const storage = entry['storage'] ?? options?.['storage'] ?? entry['values'] ?? entry['data'];
  const name =
    nameFromSource(source) ||
    (typeof entry['name'] === 'string' ? (entry['name'] as string) : '') ||
    (isObject(options?.['meta']) && typeof (options['meta'] as Json)['name'] === 'string' ? ((options['meta'] as Json)['name'] as string) : '') ||
    fallbackName ||
    'Untitled script';
  const position = Number(entry['position'] ?? options?.['position']);
  return {
    name,
    source,
    enabled: enabledOf(entry, options),
    values: normalizeValues(storage),
    downloadUrl: downloadUrlOf(entry, options),
    uuid: typeof entry['uuid'] === 'string' ? (entry['uuid'] as string) : undefined,
    position: Number.isFinite(position) ? position : undefined,
  };
}

/** Parse the JSON export (object with `scripts`, bare array, or single entry). */
export function parseTampermonkeyJson(text: string): TmParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`That file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const entries: unknown[] = Array.isArray(doc)
    ? doc
    : isObject(doc) && Array.isArray(doc['scripts'])
      ? (doc['scripts'] as unknown[])
      : isObject(doc) && isObject(doc['data']) && Array.isArray((doc['data'] as Json)['scripts'])
        ? ((doc['data'] as Json)['scripts'] as unknown[])
        : [doc];
  const scripts: TmScript[] = [];
  const skipped: string[] = [];
  entries.forEach((e, i) => {
    const s = scriptFromEntry(e);
    if (s) scripts.push(s);
    else {
      const label = isObject(e) && typeof e['name'] === 'string' ? (e['name'] as string) : `entry ${i + 1}`;
      skipped.push(`${label} (no userscript source)`);
    }
  });
  if (!scripts.length && !skipped.length) throw new Error('No scripts found in that file.');
  return { scripts, skipped };
}

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

/**
 * Parse the ZIP export, given its already-unzipped entries as text.
 * Handles both JSON-in-.txt entries and <name>.user.js + <name>.options.json/.storage.json sets.
 */
export function parseTampermonkeyZipEntries(files: Record<string, string>): TmParseResult {
  const scripts: TmScript[] = [];
  const skipped: string[] = [];
  // Group the sidecar files by the stem their .user.js shares with them.
  const options = new Map<string, Json>();
  const storages = new Map<string, unknown>();
  const sources = new Map<string, string>();

  for (const [path, text] of Object.entries(files)) {
    const file = baseName(path);
    if (!file || file.startsWith('.') || path.endsWith('/')) continue;
    const optionsStem = file.match(/^(.*?)\.options\.json$/i)?.[1];
    const storageStem = file.match(/^(.*?)\.storage\.json$/i)?.[1];
    const sourceStem = file.match(/^(.*?)\.user\.js$/i)?.[1];
    try {
      if (optionsStem != null) {
        const j = JSON.parse(text) as unknown;
        if (isObject(j)) options.set(optionsStem, j);
      } else if (storageStem != null) {
        storages.set(storageStem, JSON.parse(text) as unknown);
      } else if (sourceStem != null) {
        sources.set(sourceStem, text);
      } else if (/\.(txt|json)$/i.test(file)) {
        // Older exports: one JSON script object per .txt entry.
        const s = scriptFromEntry(JSON.parse(text) as unknown, file.replace(/\.(txt|json)$/i, ''));
        if (s) scripts.push(s);
        else skipped.push(`${file} (no userscript source)`);
      } else if (text.includes('==UserScript==')) {
        sources.set(file, text);
      }
    } catch (e) {
      skipped.push(`${file} (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  for (const [stem, source] of sources) {
    const opts = options.get(stem);
    const entry: Json = { source, name: stem };
    if (opts) entry['options'] = opts;
    if (storages.has(stem)) entry['storage'] = storages.get(stem);
    const s = scriptFromEntry(entry, stem);
    if (s) scripts.push(s);
    else skipped.push(`${stem}.user.js (no userscript header)`);
  }

  if (!scripts.length && !skipped.length) throw new Error('No scripts found in that archive.');
  return { scripts, skipped };
}

/** True when the bytes start with a ZIP local-file signature ("PK\3\4"). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}
