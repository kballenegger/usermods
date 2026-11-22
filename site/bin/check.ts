// Live check harness for the content library.
//   node site/bin/check.ts [<site>/<task> ...|--site youtube|--all] [--cdp <wsEndpoint>|--browserbase]
//                          [--content site/content] [--checks site/data/checks.json]
// --browserbase opens a Browserbase session with residential proxies (env BROWSERBASE_API_KEY,
// optional BROWSERBASE_PROJECT_ID) and releases it at the end; --cdp attaches to any CDP endpoint.
// Prints one line per page, appends one entry per page to checks.json, and writes per-load
// details and screenshots to site/data/check-logs/<run>/. Exit status 0 only if every page passed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { createSession, releaseSession, type BrowserbaseSession } from '../src/check/browserbase.ts';
import { listPages, loadPage } from '../src/check/content.ts';
import { addEntry, combine, readChecks, sha256, utcStamp, writeChecks, type CheckEntry } from '../src/check/records.ts';
import { checkUrl, desktopChromeUA, type UrlOutcome } from '../src/check/run.ts';
import { parseMeta } from '../src/check/userscript.ts';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    site: { type: 'string', multiple: true },
    all: { type: 'boolean' },
    cdp: { type: 'string' },
    browserbase: { type: 'boolean' },
    content: { type: 'string', default: join(siteRoot, 'content') },
    checks: { type: 'string', default: join(siteRoot, 'data', 'checks.json') },
  },
});

const all = listPages(values.content);
const wanted = values.all
  ? all
  : all.filter((p) => positionals.includes(p.key) || (values.site ?? []).includes(p.key.split('/')[0] ?? ''));
const unknown = positionals.filter((k) => !all.some((p) => p.key === k));
if (unknown.length > 0) throw new Error(`no such page: ${unknown.join(', ')}`);
if (wanted.length === 0) throw new Error('nothing to check: name pages, --site <slug> or --all');

const pages = wanted.map(loadPage);
const runStamp = utcStamp(new Date()).replace(/:/g, '');
const logDir = join(siteRoot, 'data', 'check-logs', runStamp);
mkdirSync(logDir, { recursive: true });

if (values.cdp && values.browserbase) throw new Error('use --cdp or --browserbase, not both');
const bbKey = process.env['BROWSERBASE_API_KEY'];
const bbProject = process.env['BROWSERBASE_PROJECT_ID'];
if (values.browserbase && !bbKey) throw new Error('--browserbase needs env BROWSERBASE_API_KEY');
let session: BrowserbaseSession | undefined;
if (values.browserbase && bbKey) {
  session = await createSession(bbKey, bbProject, 60 + pages.reduce((n, p) => n + p.check.urls.length, 0) * 150);
  console.log(`browserbase session ${session.id}`);
}
const cdp = session?.connectUrl ?? values.cdp;
const via = cdp ? 'browserbase' : 'local';
const browser: Browser = cdp
  ? await chromium.connectOverCDP(cdp)
  : await chromium.launch({ channel: 'chromium', headless: true });
const browserName = `chromium ${browser.version()}`;
const userAgent = desktopChromeUA(browser.version());

let allPassed = true;
try {
  for (const page of pages) {
    const meta = parseMeta(page.script.toString('utf8'));
    const stem = page.key.replace('/', '__');
    const outcomes: UrlOutcome[] = [];
    for (const [i, url] of page.check.urls.entries()) {
      outcomes.push(
        await checkUrl(browser, url, page.check, { source: page.script.toString('utf8'), meta }, {
          timeoutMs: 60_000,
          userAgent,
          screenshotTo: (label, png) => writeFileSync(join(logDir, `${stem}-${i}-${label}.png`), png),
        }),
      );
    }
    const combined = combine(outcomes);
    const entry: CheckEntry = {
      at: utcStamp(new Date()),
      result: combined.result,
      url: combined.url,
      scriptSha: sha256(page.script),
      browser: browserName,
      via,
      ...(combined.note ? { note: combined.note } : {}),
    };
    writeChecks(values.checks, addEntry(readChecks(values.checks), page.key, entry));
    writeFileSync(join(logDir, `${stem}.json`), JSON.stringify({ entry, outcomes }, null, 2) + '\n');
    if (entry.result !== 'pass') allPassed = false;
    console.log(`${entry.result.padEnd(7)} ${page.key}${entry.note ? `  ${entry.note}` : ''}`);
  }
} finally {
  await browser.close();
  if (session && bbKey) await releaseSession(bbKey, bbProject, session.id);
}
console.log(`logs: ${logDir}`);
process.exitCode = allPassed ? 0 : 1;
