// @connect enforcement for GM_xmlhttpRequest (CONTRACT C1). A registered script may only reach
// hosts its header declared, the hosts it already runs on ("self"), or anything at all ("*").
// Pure: no chrome APIs, so it is testable under node.

/** Lowercased hostname of a URL, or '' when the URL is not parsable / not http(s). */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Is `host` the same as `base`, or a subdomain of it? */
function hostCoveredBy(host: string, base: string): boolean {
  if (!host || !base) return false;
  if (host === base) return true;
  return host.endsWith(`.${base}`);
}

/**
 * Hosts a match pattern or glob grants "self" access to. `*://*.example.com/*` yields
 * `example.com` (which then covers its subdomains); a bare `*` host grants nothing, since a
 * script matching every site should still declare what it talks to.
 */
export function hostsFromMatchPatterns(patterns: string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const m = p.match(/^(?:\*|https?|file|ftp):\/\/([^/]*)/);
    let host = m ? m[1]! : p.replace(/^[a-z*]+:\/\//i, '').split('/')[0]!;
    host = host.replace(/:\d+$/, '').toLowerCase();
    if (host.startsWith('*.')) host = host.slice(2);
    if (!host || host === '*' || host.includes('*')) continue;
    out.push(host);
  }
  return [...new Set(out)];
}

/**
 * A mod's @connect list. CONTRACT C1 puts it on Mod as `connect: string[]`; this reads that field
 * where it is present and otherwise recovers the values from the stored header, so mods saved
 * before the field existed are still enforced rather than being silently allowed everything.
 */
export function connectOf(mod: { connect?: string[]; source?: string } | undefined | null): string[] {
  if (!mod) return [];
  if (Array.isArray(mod.connect)) return mod.connect;
  return connectFromSource(mod.source ?? '');
}

/** Raw @connect values from a userscript header. */
export function connectFromSource(source: string): string[] {
  const block = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!block) return [];
  const out: string[] = [];
  for (const line of block[1]!.split('\n')) {
    const m = line.match(/^\s*\/\/\s*@connect\s+(\S+)/);
    if (m) out.push(m[1]!);
  }
  return out;
}

export interface ConnectCheck {
  allowed: boolean;
  /** Set when not allowed: a message naming the host and how to fix it. */
  reason?: string;
}

/**
 * Decide whether a script may request `url`.
 *
 * @param connect  raw @connect values from the header ('api.example.com', '*', 'self', 'localhost')
 * @param matchPatterns  the script's @match/@include entries, for 'self'
 */
export function checkConnect(url: string, connect: string[], matchPatterns: string[]): ConnectCheck {
  const host = hostOf(url);
  if (!host) {
    return { allowed: false, reason: `GM_xmlhttpRequest: only http(s) URLs are allowed (${url}).` };
  }
  const entries = connect.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (entries.includes('*')) return { allowed: true };

  for (const entry of entries) {
    if (entry === 'self') continue;
    // A full URL or a host:port entry: keep just the host part.
    const bare = entry
      .replace(/^[a-z*]+:\/\//, '')
      .split('/')[0]!
      .replace(/:\d+$/, '')
      .replace(/^\*\./, '');
    if (hostCoveredBy(host, bare)) return { allowed: true };
  }

  if (entries.includes('self')) {
    for (const base of hostsFromMatchPatterns(matchPatterns)) {
      if (hostCoveredBy(host, base)) return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `GM_xmlhttpRequest to ${host} is not allowed by this script's @connect list. Add "// @connect ${host}" to its header to permit it.`,
  };
}
