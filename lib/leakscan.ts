// The pre-share leak check: look through a script for things that should not be published before
// it goes to a gist or to Greasy Fork.
//
// A mod written in a chat about your own dashboard can easily carry the API key you pasted to get it
// working, the address of the box on your tailnet, or a bearer token copied out of the network tab.
// A secret gist is still readable by anyone with the link, and everything on Greasy Fork is public,
// so this runs before either and the panel shows what it found with "Share anyway" / "Cancel".
//
// Pure and local: it reads the text and nothing else, makes no request, and does not try to decide
// whether a key is live. It errs towards saying something; the user decides.

export type LeakKind =
  | 'openai-key'
  | 'xai-key'
  | 'anthropic-key'
  | 'aws-key'
  | 'github-token'
  | 'jwt'
  | 'bearer'
  | 'api-key'
  | 'private-ip'
  | 'private-host'
  | 'localhost';

export interface Leak {
  kind: LeakKind;
  /** What it looks like, in words. */
  label: string;
  /** 1-based line number. */
  line: number;
  /** The match with its middle masked, so the warning itself does not display the secret. */
  preview: string;
}

interface Rule {
  kind: LeakKind;
  label: string;
  re: RegExp;
  /** Which capture group is the sensitive part (0 = the whole match). */
  group?: number;
  /** Extra check on the match, for patterns a regex alone is too loose for. */
  accept?: (m: RegExpExecArray) => boolean;
}

const RULES: Rule[] = [
  // Anthropic before OpenAI: "sk-ant-…" also starts with "sk-".
  { kind: 'anthropic-key', label: 'an Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', label: 'an OpenAI-style API key (sk-…)', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'xai-key', label: 'an xAI API key', re: /\bxai-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-key', label: 'an AWS access key id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'github-token', label: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: 'jwt', label: 'a JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: 'bearer',
    label: 'a Bearer token',
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g,
    group: 1,
    // `Bearer ${token}` and `'Bearer ' + key` are the code that USES a token, not a token.
    accept: (m) => !/^\$\{|^['"`]/.test(m[1]!),
  },
  {
    kind: 'api-key',
    label: 'a hard-coded API key or secret',
    re: /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*(['"`])([^'"`\s]{12,})\1/gi,
    group: 2,
    // A placeholder is not a secret: YOUR_API_KEY, xxxxxxxxxxxx, <key here>.
    accept: (m) => !/^(?:your|my|<|x{6,}|\*{6,}|placeholder|changeme|example|insert|todo)/i.test(m[2]!) && !/[_-]?here$/i.test(m[2]!),
  },
  {
    kind: 'private-ip',
    label: 'a private network address',
    // 10/8, 192.168/16, 172.16/12, and 100.64/10 (carrier-grade NAT, which is where Tailscale lives).
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g,
    accept: (m) => m[0].split('.').every((o) => Number(o) <= 255),
  },
  {
    kind: 'private-host',
    label: 'a private host name',
    re: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:local|internal|lan|home\.arpa|ts\.net|corp)\b(?![.\w-])/gi,
    // Only where a host can actually be: after `://`, at the start of a string, or on a header line
    // (@connect, @match, @include). `this.internal` and `config.local` are property access.
    accept: (m) => {
      const before = m.input.slice(Math.max(0, m.index - 3), m.index);
      if (/:\/\/$/.test(before) || /['"`@]$/.test(before)) return true;
      const lineStart = m.input.lastIndexOf('\n', m.index) + 1;
      return /^\s*\/\/\s*@(connect|match|include|exclude)\b/.test(m.input.slice(lineStart, m.index));
    },
  },
  { kind: 'localhost', label: 'a localhost address', re: /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/g },
];

/** Mask the middle of a secret: keep enough of each end to recognise it, never the whole thing. */
export function mask(s: string): string {
  if (s.length <= 8) return s.slice(0, 2) + '…';
  const keep = Math.min(6, Math.floor(s.length / 4));
  return `${s.slice(0, keep)}…${s.slice(-Math.min(4, keep))}`;
}

/** Hosts and addresses are not secrets in themselves; show them whole so the user knows which. */
const SHOW_WHOLE = new Set<LeakKind>(['private-ip', 'private-host', 'localhost']);

/**
 * Every likely leak in the source, in order, at most one finding per kind per line. The header's
 * `@match`/`@include`/`@connect` lines are scanned too: a `@connect my-nas.local` is exactly the kind
 * of thing this is for.
 */
export function scanForLeaks(source: string): Leak[] {
  const out: Leak[] = [];
  const seen = new Set<string>();
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const claimed: Array<[number, number]> = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(source))) {
      if (rule.accept && !rule.accept(m)) continue;
      const start = m.index;
      const end = start + m[0].length;
      // A span an earlier (more specific) rule already reported is not reported twice.
      if (claimed.some(([a, b]) => start < b && end > a)) continue;
      const line = lineOf(start);
      const key = `${rule.kind}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claimed.push([start, end]);
      const secret = m[rule.group ?? 0] ?? m[0];
      out.push({ kind: rule.kind, label: rule.label, line, preview: SHOW_WHOLE.has(rule.kind) ? secret : mask(secret) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** One line for the panel: "Line 12: an OpenAI-style API key (sk-…) · sk-pro…9f2c". */
export function describeLeak(l: Leak): string {
  return `Line ${l.line}: ${l.label} · ${l.preview}`;
}
