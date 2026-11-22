// site/data/checks.json: { "<site>/<task>": [entry, ...] }, newest first, last 10 kept.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type CheckResult = 'pass' | 'fail' | 'blocked';

export interface CheckEntry {
  at: string;
  result: CheckResult;
  url: string;
  scriptSha: string;
  browser: string;
  via: 'local' | 'browserbase';
  note?: string;
}

export type ChecksFile = Record<string, CheckEntry[]>;

export const KEEP = 10;

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// UTC to the second: 2026-11-17T09:12:00Z
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function readChecks(path: string): ChecksFile {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as ChecksFile;
}

export function addEntry(file: ChecksFile, key: string, entry: CheckEntry): ChecksFile {
  const list = [entry, ...(file[key] ?? [])]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, KEEP);
  const out: ChecksFile = {};
  for (const k of [...new Set([...Object.keys(file), key])].sort()) {
    out[k] = k === key ? list : (file[k] ?? []);
  }
  return out;
}

export function writeChecks(path: string, file: ChecksFile): void {
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
}

// One entry per page per run: pass only if every URL passed, fail if any failed, else blocked.
// url is the first URL that did not pass, or the first URL.
export function combine(results: { url: string; result: CheckResult; note?: string }[]): { result: CheckResult; url: string; note?: string } {
  const first = results[0];
  if (!first) throw new Error('no URL results');
  const bad = results.filter((r) => r.result !== 'pass');
  const firstBad = bad[0];
  if (!firstBad) return { result: 'pass', url: first.url };
  const result: CheckResult = bad.some((r) => r.result === 'fail') ? 'fail' : 'blocked';
  const note = bad.map((r) => (bad.length > 1 ? `${r.url}: ${r.note ?? r.result}` : (r.note ?? r.result))).join('; ');
  return { result, url: firstBad.url, note };
}
