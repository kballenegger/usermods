// Finds pages under site/content and reads what the harness needs from each: the check block
// and the script. The generator validates the rest of page.json.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckSpec } from './run.ts';

export interface PageRef {
  key: string; // "<site>/<task>"
  dir: string;
}

export interface LoadedPage extends PageRef {
  check: CheckSpec;
  script: Buffer;
}

export function listPages(contentDir: string): PageRef[] {
  const out: PageRef[] = [];
  for (const site of readdirSync(contentDir).sort()) {
    const siteDir = join(contentDir, site);
    if (!statSync(siteDir).isDirectory() || !existsSync(join(siteDir, 'site.json'))) continue;
    for (const task of readdirSync(siteDir).sort()) {
      const dir = join(siteDir, task);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'page.json'))) out.push({ key: `${site}/${task}`, dir });
    }
  }
  return out;
}

function fail(file: string, field: string, why: string): never {
  throw new Error(`${file}: ${field} ${why}`);
}

export function loadPage(ref: PageRef): LoadedPage {
  const file = join(ref.dir, 'page.json');
  const page = JSON.parse(readFileSync(file, 'utf8')) as { check?: Record<string, unknown> };
  const c = page.check;
  if (!c || typeof c !== 'object') fail(file, 'check', 'is missing');
  if (c['loggedOut'] !== true) fail(file, 'check.loggedOut', 'must be true (the harness only runs logged out)');
  const urls = c['urls'];
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === 'string' && /^https?:\/\//.test(u))) {
    fail(file, 'check.urls', 'must be a non-empty array of http(s) URLs');
  }
  if (typeof c['settleMs'] !== 'number' || c['settleMs'] < 0) fail(file, 'check.settleMs', 'must be a number >= 0');
  for (const k of ['baseline', 'expect', 'intact'] as const) {
    if (typeof c[k] !== 'string' || c[k] === '') fail(file, `check.${k}`, 'must be a non-empty JS expression string');
  }
  for (const k of ['waitFor', 'actions'] as const) {
    if (c[k] !== undefined && typeof c[k] !== 'string') fail(file, `check.${k}`, 'must be a string');
  }
  const scriptFile = join(ref.dir, 'script.user.js');
  if (!existsSync(scriptFile)) fail(scriptFile, 'file', 'is missing');
  return { ...ref, check: c as unknown as CheckSpec, script: readFileSync(scriptFile) };
}
