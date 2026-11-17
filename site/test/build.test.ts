import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, type Manifest } from '../src/build/build.ts';
import { publication, type CheckEntry } from '../src/build/content.ts';
import { renderMarkdown } from '../src/markdown.ts';

const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const content = join(fx, 'content');
const sha = (key: string) => createHash('sha256').update(readFileSync(join(content, key, 'script.user.js'))).digest('hex');
const OLD = 'a'.repeat(64);
const entry = (at: string, result: CheckEntry['result'], scriptSha: string): CheckEntry =>
  ({ at, result, url: 'https://x.example/', scriptSha, browser: 'chromium 140', via: 'local' });

function buildFixture(origin?: string): { out: string; m: Manifest; warnings: string[]; read: (rel: string) => string } {
  const tmp = mkdtempSync(join(tmpdir(), 'usermods-site-'));
  const checks = {
    // Pass, then a newer pass: date is the newest pass. The oldest pass (old sha) is datePublished.
    'tube/hide-shorts': [
      entry('2026-11-15T10:00:00Z', 'pass', sha('tube/hide-shorts')),
      entry('2026-11-10T10:00:00Z', 'pass', sha('tube/hide-shorts')),
      entry('2026-10-01T10:00:00Z', 'pass', OLD),
    ],
    // Newest is blocked: the last pass stands, still indexable.
    'tube/blocked-later': [
      entry('2026-11-16T10:00:00Z', 'blocked', sha('tube/blocked-later')),
      entry('2026-11-12T10:00:00Z', 'pass', sha('tube/blocked-later')),
    ],
    // Passed only for an older script: not published.
    'tube/stale-sha': [entry('2026-11-14T10:00:00Z', 'pass', OLD)],
    // Newest is a fail after a pass: published, noindex.
    'tube/fails-now': [
      entry('2026-11-16T09:00:00Z', 'fail', sha('tube/fails-now')),
      entry('2026-11-11T09:00:00Z', 'pass', sha('tube/fails-now')),
    ],
    'forum/only-fails': [
      entry('2026-11-13T09:00:00Z', 'fail', sha('forum/only-fails')),
      entry('2026-11-09T09:00:00Z', 'pass', sha('forum/only-fails')),
    ],
  };
  const checksFile = join(tmp, 'checks.json');
  writeFileSync(checksFile, JSON.stringify(checks));
  const out = join(tmp, 'dist');
  const { manifest, warnings } = build({
    content, checks: checksFile, out, guideDates: join(fx, 'guide-dates.json'), assets: join(fx, 'assets'),
    origin: origin ?? 'https://usermods.kennethballenegger.com', commit: 'abc123', now: new Date('2026-11-17T12:00:00Z'),
  });
  return { out, m: manifest, warnings, read: (rel) => readFileSync(join(out, rel), 'utf8') };
}

const b = buildFixture();

test('publication rule: only passes for the current sha publish', () => {
  assert.deepEqual(Object.keys(b.m.pages).filter((p) => b.m.pages[p]!.kind === 'task').sort(),
    ['/forum/only-fails', '/tube/blocked-later', '/tube/fails-now', '/tube/hide-shorts']);
  assert.ok(!existsSync(join(b.out, 'tube/stale-sha/index.html')));
  assert.ok(!existsSync(join(b.out, 'tube/never-checked/index.html')));
  assert.equal(b.m.files['/tube/stale-sha.user.js'], undefined);
  assert.ok(b.warnings.some((w) => w.startsWith('tube/stale-sha: not published')));
  assert.equal(publication([entry('2026-11-01T00:00:00Z', 'fail', 'b'.repeat(64))], 'b'.repeat(64)), null);
});

test('dates: newest current pass, blocked keeps the last pass', () => {
  assert.equal(b.m.pages['/tube/hide-shorts']!.lastmod, '2026-11-15T10:00:00Z');
  assert.equal(b.m.pages['/tube/blocked-later']!.lastmod, '2026-11-12T10:00:00Z');
  assert.equal(b.m.pages['/tube/blocked-later']!.indexable, true);
  const html = b.read('tube/hide-shorts/index.html');
  assert.match(html, /Checked <time datetime="2026-11-15T10:00:00Z">15 November 2026<\/time>/);
  assert.match(html, /<title>Hide Shorts \(Tube userscript, checked November 2026\)<\/title>/);
  assert.match(html, /"dateModified":"2026-11-15T10:00:00Z"/);
  assert.match(html, /"datePublished":"2026-10-01T10:00:00Z"/);
  assert.match(b.read('tube/hide-shorts.md'), /^Checked: 15 November 2026\nCanonical: https:\/\/usermods\.kennethballenegger\.com\/tube\/hide-shorts\n/);
  // Hub date = max of indexable pages; the failing page does not count. Home = max of all.
  assert.equal(b.m.pages['/tube']!.lastmod, '2026-11-15T10:00:00Z');
  assert.equal(b.m.pages['/']!.lastmod, '2026-11-15T10:00:00Z');
  assert.equal(b.m.pages['/guide/first-steps']!.lastmod, '2026-10-01T08:00:00Z');
  assert.match(b.read('guide/first-steps.md'), /^Updated: 1 October 2026\n/);
});

test('a failing page is noindex, flagged, and left out of every list', () => {
  const p = b.m.pages['/tube/fails-now']!;
  assert.equal(p.indexable, false);
  const html = b.read('tube/fails-now/index.html');
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /This script failed its check on <time datetime="2026-11-16T09:00:00Z">16 November 2026<\/time>\. It is being fixed\./);
  for (const rel of ['sitemap-pages.xml', 'sitemap-hubs.xml', 'llms.txt', 'scripts.json', 'index.html', 'tube/index.html', 'tube/hide-shorts/index.html']) {
    assert.ok(!b.read(rel).includes('/tube/fails-now'), `${rel} mentions the failing page`);
  }
  // A site whose only page fails: hub built, noindex, off the home page.
  assert.equal(b.m.pages['/forum']!.indexable, false);
  assert.ok(!b.read('index.html').includes('href="/forum"'));
  assert.ok(!b.read('sitemap-hubs.xml').includes('/forum'));
  assert.deepEqual(b.m.counts, { pages: 2, sites: 1 });
});

test('task page carries the install flow, script and JSON-LD', () => {
  const html = b.read('tube/hide-shorts/index.html');
  assert.equal(html.split('</head>').length, 2);
  assert.match(html, /<a class="btn primary" href="\/tube\/hide-shorts\.user\.js" data-umami-event="install-script">Install this script<\/a>/);
  assert.match(html, /href="\/install\?from=%2Ftube%2Fhide-shorts" rel="nofollow" data-umami-event="get-usermods"/);
  assert.ok(!/href="https:\/\/chromewebstore/.test(html), 'CWS links go through /install');
  assert.match(html, /"@type":"HowTo"/);
  assert.match(html, /"@type":"BreadcrumbList"/);
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="https:\/\/usermods\.kennethballenegger\.com\/tube\/hide-shorts\.md">/);
  assert.match(html, /@description  Hide Shorts &lt;\/script&gt; &amp; &lt;b&gt;/);
  // Related: unpublished and failing pages are left off, the blocked-but-passing one stays.
  assert.match(html, /<a href="\/tube\/blocked-later">Hide comments<\/a>/);
  assert.ok(!html.includes('never-checked'));
  // The served script is the checked file, byte for byte.
  assert.equal(b.read('tube/hide-shorts.user.js'), readFileSync(join(content, 'tube/hide-shorts/script.user.js'), 'utf8'));
  assert.match(b.read('tube/hide-shorts.md'), /```js\n\/\/ ==UserScript==/);
});

test('markdown twins and llms.txt link the store only through /install', () => {
  const o = 'https://usermods.kennethballenegger.com';
  const twins: [string, string][] = [['tube/hide-shorts.md', '%2Ftube%2Fhide-shorts'], ['tube.md', '%2Ftube'], ['index.md', '%2F'], ['llms.txt', '%2Fllms.txt']];
  for (const [file, from] of twins) {
    const text = b.read(file);
    assert.ok(!text.includes('chromewebstore'), `${file} links the store directly`);
    assert.ok(text.includes(`${o}/install?from=${from}`), `${file} lacks the /install link`);
  }
});

test('manifest shape', () => {
  assert.equal(b.m.origin, 'https://usermods.kennethballenegger.com');
  assert.equal(b.m.commit, 'abc123');
  assert.equal(b.m.builtAt, '2026-11-17T12:00:00Z');
  assert.deepEqual(b.m.pages['/'], { kind: 'home', title: 'usermods: AI userscript generator for Chrome', lastmod: '2026-11-15T10:00:00Z', indexable: true, html: 'index.html', md: 'index.md' });
  assert.equal(b.m.pages['/tube']!.html, 'tube/index.html');
  assert.equal(b.m.pages['/tube']!.md, 'tube.md');
  assert.equal(b.m.pages['/guide']!.md, 'guide.md');
  assert.deepEqual(b.m.files['/tube/hide-shorts.user.js'], { file: 'tube/hide-shorts.user.js', type: 'text/javascript; charset=utf-8', lastmod: '2026-11-15T10:00:00Z', format: 'js' });
  assert.equal(b.m.files['/assets/site.css']!.format, 'asset');
  assert.equal(b.m.files['/llms.txt']!.format, 'llms');
  assert.deepEqual(b.m.notFound, { html: '404.html', md: '404.md' });
  assert.deepEqual(b.m.redirects, { '/tube/old-shorts': '/tube/hide-shorts' });
  for (const p of Object.values(b.m.pages)) {
    assert.ok(existsSync(join(b.out, p.html)) && existsSync(join(b.out, p.md)));
    assert.equal(readFileSync(join(b.out, p.html), 'utf8').split('</head>').length, 2, p.html);
  }
  for (const f of Object.values(b.m.files)) assert.ok(existsSync(join(b.out, f.file)), f.file);
  assert.deepEqual(JSON.parse(b.read('manifest.json')), b.m);
});

test('robots, sitemaps, llms.txt, scripts.json', () => {
  const robots = b.read('robots.txt');
  for (const bot of ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot', 'Googlebot', 'GrokBot', '*']) {
    assert.ok(robots.includes(`User-agent: ${bot}\nAllow: /\nDisallow: /install\n`), bot);
  }
  assert.match(robots, /Sitemap: https:\/\/usermods\.kennethballenegger\.com\/sitemap\.xml\n$/);
  assert.match(b.read('sitemap.xml'), /<loc>https:\/\/usermods\.kennethballenegger\.com\/sitemap-pages\.xml<\/loc>/);
  const pages = b.read('sitemap-pages.xml');
  assert.match(pages, /<loc>https:\/\/usermods\.kennethballenegger\.com\/tube\/hide-shorts<\/loc><lastmod>2026-11-15T10:00:00Z<\/lastmod>/);
  assert.match(pages, /\/guide\/first-steps</);
  const hubs = b.read('sitemap-hubs.xml');
  assert.match(hubs, /<loc>https:\/\/usermods\.kennethballenegger\.com\/<\/loc>/);
  assert.match(hubs, /\/tube<\/loc>/);
  assert.match(hubs, /\/guide<\/loc>/);
  const llms = b.read('llms.txt');
  assert.match(llms, /^# usermods\n/);
  assert.match(llms, /- \[Tube\]\(https:\/\/usermods\.kennethballenegger\.com\/tube\.md\): 2 scripts/);
  assert.match(llms, /- \[Hide Shorts\]\(https:\/\/usermods\.kennethballenegger\.com\/tube\/hide-shorts\.md\)/);
  assert.match(llms, /scripts\.json/);
  const scripts = JSON.parse(b.read('scripts.json')) as { task: string; checked: string; scriptUrl: string }[];
  assert.deepEqual(scripts.map((s) => s.task).sort(), ['blocked-later', 'hide-shorts']);
  assert.equal(scripts.find((s) => s.task === 'hide-shorts')!.scriptUrl, 'https://usermods.kennethballenegger.com/tube/hide-shorts.user.js');
  assert.match(b.read('index.html'), /2 scripts for 1 site, last checked 15 November 2026\./);
  assert.match(b.read('tube/index.html'), /<h1>Tube userscripts: 2 tweaks checked November 2026<\/h1>/);
});

test('SITE_ORIGIN reaches every absolute URL', () => {
  const o = buildFixture('https://staging.example');
  assert.equal(o.m.origin, 'https://staging.example');
  assert.match(o.read('robots.txt'), /Sitemap: https:\/\/staging\.example\/sitemap\.xml/);
  assert.match(o.read('tube/hide-shorts/index.html'), /<link rel="canonical" href="https:\/\/staging\.example\/tube\/hide-shorts">/);
});

test('an empty library still builds', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'usermods-empty-'));
  const { manifest } = build({ content: join(tmp, 'none'), checks: join(tmp, 'none.json'), out: join(tmp, 'dist'),
    guideDates: join(tmp, 'none.json'), assets: join(fx, 'assets') });
  assert.deepEqual(manifest.counts, { pages: 0, sites: 0 });
  for (const path of ['/', '/guide']) assert.ok(manifest.pages[path]);
  for (const path of ['/robots.txt', '/llms.txt', '/sitemap.xml', '/scripts.json']) assert.ok(manifest.files[path]);
});

test('validation names the file and field', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'usermods-bad-'));
  assert.throws(() => build({ content, checks: join(tmp, 'none.json'), out: join(tmp, 'dist'), guideDates: join(tmp, 'none.json'), assets: join(fx, 'assets') }),
    /none\.json: first-steps: no date stamp/);
});

test('a site directory without site.json fails the build', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'usermods-nosite-'));
  mkdirSync(join(tmp, 'content', 'tube', 'hide-shorts'), { recursive: true });
  writeFileSync(join(tmp, 'content', 'tube', 'hide-shorts', 'page.json'), '{}');
  mkdirSync(join(tmp, 'content', 'empty', 'task'), { recursive: true });
  const run = () => build({ content: join(tmp, 'content'), checks: join(tmp, 'none.json'), out: join(tmp, 'dist'),
    guideDates: join(tmp, 'none.json'), assets: join(fx, 'assets') });
  assert.throws(run, /content\/tube\/site\.json: \(file\): missing/);
  rmSync(join(tmp, 'content', 'tube'), { recursive: true });
  run(); // a tree of empty directories is skipped
});

test('markdown renderer', () => {
  const html = renderMarkdown('# T\n\nA **b** and `<c>` [l](https://x.y).\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<x>\n```');
  assert.equal(html, [
    '<h1 id="t">T</h1>',
    '<p>A <strong>b</strong> and <code>&lt;c&gt;</code> <a href="https://x.y" rel="noopener">l</a>.</p>',
    '<ul><li>one</li><li>two</li></ul>',
    '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    '<pre><code>&lt;x&gt;</code></pre>',
  ].join('\n'));
});
