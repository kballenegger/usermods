import type { Mod, ModProposal } from './types';

const STORAGE_KEY = 'mods';

export function newId(): string {
  return crypto.randomUUID();
}

/** Parse the ==UserScript== header block. Unknown keys are kept in `extra`. */
export function parseHeader(source: string): {
  name: string;
  description: string;
  matches: string[];
  extra: Record<string, string[]>;
} {
  const m = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  const extra: Record<string, string[]> = {};
  let name = '';
  let description = '';
  const matches: string[] = [];
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const kv = line.match(/^\s*\/\/\s*@(\S+)\s*(.*?)\s*$/);
      if (!kv) continue;
      const [, key, value] = kv as [string, string, string];
      if (key === 'name') name = value;
      else if (key === 'description') description = value;
      else if (key === 'match' || key === 'include') matches.push(value);
      else (extra[key] ??= []).push(value);
    }
  }
  return { name, description, matches, extra };
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

export function modFromProposal(p: ModProposal, existing?: Mod): Mod {
  const now = Date.now();
  return {
    id: existing?.id ?? newId(),
    name: p.name,
    description: p.description,
    matches: p.matches,
    source: buildSource(p),
    enabled: existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function modFromSource(source: string, existing?: Mod): Mod {
  const h = parseHeader(source);
  const now = Date.now();
  return {
    id: existing?.id ?? newId(),
    name: h.name || existing?.name || 'Untitled mod',
    description: h.description,
    matches: h.matches.length ? h.matches : existing?.matches ?? [],
    source,
    enabled: existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function loadMods(): Promise<Mod[]> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return (r[STORAGE_KEY] as Mod[] | undefined) ?? [];
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

/** Does a URL match any of the mod's patterns? Only used for display; Chrome does the real matching. */
export function urlMatches(url: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp(
      '^' +
        p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/^\*:/, '[a-z]+:')
          .replace(/\\\*\\\*/g, '.*')
          .replace(/\*/g, '.*') +
        '$',
    );
    return re.test(url);
  });
}
