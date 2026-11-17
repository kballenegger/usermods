// Loads and validates site content, check results and guide sources, and applies the
// publication rule. Any malformed file fails the build with the file and field named.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CATEGORIES = ['video', 'social', 'search', 'shopping', 'news', 'work', 'reference', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
const RESERVED = new Set(['guide', 'install', 'assets']);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Site {
  slug: string;
  name: string;
  domains: string[];
  category: Category;
  intro: string;
}

export interface Alternative {
  kind: 'site-setting' | 'ublock' | 'extension' | 'other';
  title: string;
  body: string;
}

export interface Check {
  urls: string[];
  loggedOut: true;
  waitFor?: string;
  settleMs: number;
  baseline: string;
  expect: string;
  intact: string;
  actions?: string;
}

export interface PageDoc {
  slug: string;
  title: string;
  question: string;
  answer: string;
  prompt: string;
  details?: string;
  alternatives: Alternative[];
  related: string[];
  check: Check;
}

export interface CheckEntry {
  at: string;
  result: 'pass' | 'fail' | 'blocked';
  url: string;
  scriptSha: string;
  browser: string;
  via: 'local' | 'browserbase';
  note?: string;
}

export interface TaskPage {
  site: Site;
  doc: PageDoc;
  key: string; // "<site>/<task>"
  path: string; // "/<site>/<task>"
  script: Buffer;
  scriptSha: string;
  /** Newest pass for the current script sha: the page date. */
  checked: string;
  /** Oldest pass in checks.json for this page (any sha). */
  firstPassed: string;
  indexable: boolean;
  /** Set when the newest result for the current sha is a fail. */
  failedAt?: string;
}

export interface GuideDoc {
  slug: string;
  title: string;
  description: string;
  markdown: string;
  date: string;
}

export interface Library {
  sites: Map<string, Site>;
  pages: TaskPage[];
  guide: GuideDoc[];
  redirects: Record<string, string>;
  warnings: string[];
}

class ContentError extends Error {}

function fail(file: string, field: string, why: string): never {
  throw new ContentError(`${file}: ${field}: ${why}`);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ContentError(`${file}: not valid JSON: ${(e as Error).message}`);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Obj, field: string, file: string, required = true): string | undefined {
  const v = o[field];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.trim() === '') fail(file, field, 'must be a non-empty string');
  return v;
}

function strArr(o: Obj, field: string, file: string, required: boolean): string[] {
  const v = o[field];
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x !== '')) {
    fail(file, field, 'must be an array of non-empty strings');
  }
  if (required && v.length === 0) fail(file, field, 'must not be empty');
  return v as string[];
}

function loadSite(dir: string, slug: string): Site {
  const file = join(dir, 'site.json');
  const o = readJson(file);
  if (!isObj(o)) fail(file, '(root)', 'must be an object');
  const s = str(o, 'slug', file)!;
  if (s !== slug) fail(file, 'slug', `must equal the directory name "${slug}"`);
  const category = str(o, 'category', file)!;
  if (!(CATEGORIES as readonly string[]).includes(category)) fail(file, 'category', `must be one of ${CATEGORIES.join(', ')}`);
  return {
    slug,
    name: str(o, 'name', file)!,
    domains: strArr(o, 'domains', file, true),
    category: category as Category,
    intro: str(o, 'intro', file)!,
  };
}

function loadPage(dir: string, slug: string): PageDoc {
  const file = join(dir, 'page.json');
  const o = readJson(file);
  if (!isObj(o)) fail(file, '(root)', 'must be an object');
  const s = str(o, 'slug', file)!;
  if (s !== slug) fail(file, 'slug', `must equal the directory name "${slug}"`);

  const alternatives: Alternative[] = [];
  if (o.alternatives !== undefined) {
    if (!Array.isArray(o.alternatives)) fail(file, 'alternatives', 'must be an array');
    o.alternatives.forEach((a, i) => {
      const f = `alternatives[${i}]`;
      if (!isObj(a)) fail(file, f, 'must be an object');
      const kind = str(a, 'kind', file)!;
      if (!['site-setting', 'ublock', 'extension', 'other'].includes(kind)) {
        fail(file, `${f}.kind`, 'must be site-setting, ublock, extension or other');
      }
      alternatives.push({ kind: kind as Alternative['kind'], title: str(a, 'title', file)!, body: str(a, 'body', file)! });
    });
  }

  const c = o.check;
  if (!isObj(c)) fail(file, 'check', 'must be an object');
  if (c.loggedOut !== true) fail(file, 'check.loggedOut', 'must be true');
  if (typeof c.settleMs !== 'number' || c.settleMs < 0) fail(file, 'check.settleMs', 'must be a non-negative number');
  const cf = (field: string, required = true) => {
    const v = c[field];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || v.trim() === '') fail(file, `check.${field}`, 'must be a non-empty string');
    return v;
  };
  const urls = c.urls;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === 'string' && /^https?:\/\//.test(u))) {
    fail(file, 'check.urls', 'must be a non-empty array of http(s) URLs');
  }
  const check: Check = {
    urls: urls as string[],
    loggedOut: true,
    settleMs: c.settleMs,
    baseline: cf('baseline')!,
    expect: cf('expect')!,
    intact: cf('intact')!,
  };
  const waitFor = cf('waitFor', false);
  if (waitFor) check.waitFor = waitFor;
  const actions = cf('actions', false);
  if (actions) check.actions = actions;

  const doc: PageDoc = {
    slug,
    title: str(o, 'title', file)!,
    question: str(o, 'question', file)!,
    answer: str(o, 'answer', file)!,
    prompt: str(o, 'prompt', file)!,
    alternatives,
    related: strArr(o, 'related', file, false),
    check,
  };
  const details = str(o, 'details', file, false);
  if (details) doc.details = details;
  return doc;
}

/** ISO 8601 UTC to the second: 2026-11-17T09:12:00Z. */
export function isoSeconds(d: Date | string): string {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function sha256(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

export function loadChecks(file: string): Record<string, CheckEntry[]> {
  if (!existsSync(file)) return {};
  const o = readJson(file);
  if (!isObj(o)) fail(file, '(root)', 'must be an object');
  const out: Record<string, CheckEntry[]> = {};
  for (const [key, list] of Object.entries(o)) {
    if (!Array.isArray(list)) fail(file, key, 'must be an array');
    out[key] = list.map((e, i) => {
      const f = `${key}[${i}]`;
      if (!isObj(e)) fail(file, f, 'must be an object');
      if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) fail(file, `${f}.at`, 'must be an ISO date');
      if (!['pass', 'fail', 'blocked'].includes(e.result as string)) fail(file, `${f}.result`, 'must be pass, fail or blocked');
      if (typeof e.scriptSha !== 'string' || !/^[0-9a-f]{64}$/.test(e.scriptSha)) fail(file, `${f}.scriptSha`, 'must be 64 lowercase hex');
      return e as unknown as CheckEntry;
    });
  }
  return out;
}

const byAtDesc = (a: CheckEntry, b: CheckEntry) => Date.parse(b.at) - Date.parse(a.at);

/**
 * The publication rule. Only entries for the current script sha count. No pass: not published
 * (null). Newest counted result a fail: published but not indexable. Page date = newest pass.
 */
export function publication(entries: CheckEntry[], scriptSha: string):
  { checked: string; firstPassed: string; indexable: boolean; failedAt?: string } | null {
  const current = entries.filter((e) => e.scriptSha === scriptSha).sort(byAtDesc);
  const pass = current.find((e) => e.result === 'pass');
  if (!pass) return null;
  const decisive = current.find((e) => e.result !== 'blocked');
  const passes = entries.filter((e) => e.result === 'pass').sort(byAtDesc);
  const firstPassed = passes[passes.length - 1]?.at ?? pass.at;
  const iso = isoSeconds;
  const out: { checked: string; firstPassed: string; indexable: boolean; failedAt?: string } = {
    checked: iso(pass.at),
    firstPassed: iso(firstPassed),
    indexable: decisive?.result !== 'fail',
  };
  if (decisive?.result === 'fail') out.failedAt = iso(decisive.at);
  return out;
}

const dirs = (d: string) =>
  existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith('.') && statSync(join(d, n)).isDirectory()).sort() : [];

/** True if the tree holds any file. Git does not track empty directories, so a tree of them counts as absent. */
const hasFiles = (d: string): boolean =>
  readdirSync(d).some((n) => !n.startsWith('.') && (!statSync(join(d, n)).isDirectory() || hasFiles(join(d, n))));

export function loadGuide(contentDir: string, datesFile: string): GuideDoc[] {
  const dir = join(contentDir, 'guide');
  const indexFile = join(dir, 'index.json');
  if (!existsSync(indexFile)) return [];
  const index = readJson(indexFile);
  if (!Array.isArray(index)) fail(indexFile, '(root)', 'must be an array of { slug, description }');
  const dates = existsSync(datesFile) ? readJson(datesFile) : {};
  if (!isObj(dates)) fail(datesFile, '(root)', 'must be an object');
  return index.map((entry, i) => {
    if (!isObj(entry)) fail(indexFile, `[${i}]`, 'must be an object');
    const slug = str(entry, 'slug', indexFile)!;
    if (!SLUG.test(slug)) fail(indexFile, `[${i}].slug`, 'must be kebab-case');
    const file = join(dir, `${slug}.md`);
    if (!existsSync(file)) fail(indexFile, `[${i}].slug`, `no file ${file}`);
    const markdown = readFileSync(file, 'utf8');
    const title = /^# (.+)$/m.exec(markdown)?.[1]?.trim();
    if (!title) fail(file, '(title)', 'needs a "# " title line');
    const date = dates[slug];
    if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) {
      fail(datesFile, slug, 'no date stamp; run node site/bin/build.ts --stamp-guide-dates');
    }
    return {
      slug,
      title,
      description: str(entry, 'description', indexFile)!,
      // The title is rendered as the page H1; the body is the rest.
      markdown: markdown.replace(/^# .+$/m, '').trim(),
      date: isoSeconds(date),
    };
  });
}

export function loadLibrary(opts: { content: string; checks: string; guideDates: string }): Library {
  const warnings: string[] = [];
  const checks = loadChecks(opts.checks);
  const sites = new Map<string, Site>();
  const pages: TaskPage[] = [];

  for (const siteSlug of dirs(opts.content)) {
    if (siteSlug === 'guide') continue;
    const siteDir = join(opts.content, siteSlug);
    if (!existsSync(join(siteDir, 'site.json'))) {
      if (hasFiles(siteDir)) fail(join(siteDir, 'site.json'), '(file)', 'missing');
      continue;
    }
    if (!SLUG.test(siteSlug)) fail(siteDir, 'slug', 'must be kebab-case [a-z0-9-]+');
    if (RESERVED.has(siteSlug)) fail(siteDir, 'slug', `"${siteSlug}" is reserved`);
    const site = loadSite(siteDir, siteSlug);
    sites.set(siteSlug, site);

    for (const task of dirs(siteDir)) {
      const dir = join(siteDir, task);
      if (!SLUG.test(task)) fail(dir, 'slug', 'must be kebab-case [a-z0-9-]+');
      const doc = loadPage(dir, task);
      const scriptFile = join(dir, 'script.user.js');
      if (!existsSync(scriptFile)) fail(scriptFile, '(file)', 'missing');
      const script = readFileSync(scriptFile);
      if (!script.toString('utf8').includes('==UserScript==')) fail(scriptFile, '(header)', 'needs a ==UserScript== block');
      const key = `${siteSlug}/${task}`;
      const scriptSha = sha256(script);
      const pub = publication(checks[key] ?? [], scriptSha);
      if (!pub) {
        warnings.push(`${key}: not published (no pass for the current script)`);
        continue;
      }
      if (!pub.indexable) warnings.push(`${key}: newest check failed; built noindex`);
      pages.push({ site, doc, key, path: `/${key}`, script, scriptSha, ...pub });
    }
  }

  const published = new Set(pages.map((p) => p.key));
  for (const p of pages) {
    p.doc.related = p.doc.related.filter((r) => {
      if (published.has(r)) return true;
      warnings.push(`${p.key}: related "${r}" is not published; left off`);
      return false;
    });
  }

  const redirectsFile = join(opts.content, 'redirects.json');
  const redirects = existsSync(redirectsFile) ? readJson(redirectsFile) : {};
  if (!isObj(redirects) || !Object.entries(redirects).every(([k, v]) => k.startsWith('/') && typeof v === 'string' && v.startsWith('/'))) {
    fail(redirectsFile, '(root)', 'must map "/old" paths to "/new" paths');
  }

  return {
    sites,
    pages,
    guide: loadGuide(opts.content, opts.guideDates),
    redirects: redirects as Record<string, string>,
    warnings,
  };
}
