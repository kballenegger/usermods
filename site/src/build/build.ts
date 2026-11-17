// Builds site/dist from content, check results and guide sources. manifest.json is the only
// contract with the server.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { isoSeconds, loadLibrary, type Library, type TaskPage } from './content.ts';
import { guideIndex, guidePage, homePage, hubPage, notFoundPage, taskPage, type HubSummary, type Rendered } from '../templates/pages.ts';
import { installHref } from '../templates/layout.ts';
import { HOME_INTRO } from '../templates/pages.ts';

export const DEFAULT_ORIGIN = 'https://usermods.kennethballenegger.com';

export interface BuildOpts {
  content: string;
  checks: string;
  out: string;
  guideDates: string;
  assets: string;
  origin?: string;
  commit?: string;
  now?: Date;
}

type PageKind = 'task' | 'hub' | 'home' | 'guide';
export interface ManifestPage { kind: PageKind; title: string; lastmod: string; indexable: boolean; html: string; md: string }
export interface ManifestFile { file: string; type: string; lastmod: string; format: 'js' | 'llms' | 'xml' | 'txt' | 'json' | 'asset' }
export interface Manifest {
  builtAt: string;
  commit: string;
  origin: string;
  counts: { pages: number; sites: number };
  pages: Record<string, ManifestPage>;
  files: Record<string, ManifestFile>;
  notFound: { html: string; md: string };
  redirects: Record<string, string>;
}

export const AI_BOTS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Googlebot', 'Bingbot', 'Applebot', 'Applebot-Extended',
  'Amazonbot', 'CCBot', 'meta-externalagent', 'DuckAssistBot', 'MistralAI-User', 'cohere-ai', 'YouBot', 'GrokBot',
];

const ASSET_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

const maxIso = (dates: string[]): string | null =>
  dates.length ? dates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function urlset(origin: string, entries: { path: string; lastmod: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url><loc>${xmlEsc(origin + e.path)}</loc><lastmod>${e.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
}

export function robotsTxt(origin: string): string {
  const groups = [...AI_BOTS, '*'].map((b) => `User-agent: ${b}\nAllow: /\nDisallow: /install\n`);
  return `${groups.join('\n')}\nSitemap: ${origin}/sitemap.xml\n`;
}

export function build(opts: BuildOpts): { manifest: Manifest; warnings: string[] } {
  const origin = (opts.origin ?? DEFAULT_ORIGIN).replace(/\/$/, '');
  const builtAt = isoSeconds(opts.now ?? new Date());
  const lib: Library = loadLibrary({ content: opts.content, checks: opts.checks, guideDates: opts.guideDates });
  const out = opts.out;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const write = (rel: string, data: string | Buffer) => {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  const pages: Record<string, ManifestPage> = {};
  const files: Record<string, ManifestFile> = {};
  const addPage = (path: string, kind: PageKind, title: string, lastmod: string, indexable: boolean, r: Rendered) => {
    const base = path === '/' ? '' : path.slice(1);
    const html = base ? `${base}/index.html` : 'index.html';
    const md = base ? `${base}.md` : 'index.md';
    write(html, r.html);
    write(md, r.md);
    pages[path] = { kind, title, lastmod, indexable, html, md };
  };
  const addFile = (path: string, data: string | Buffer, type: string, format: ManifestFile['format'], lastmod: string) => {
    const file = path.slice(1);
    write(file, data);
    files[path] = { file, type, lastmod, format };
  };

  // Task pages, newest check first.
  const all = [...lib.pages].sort((a, b) => Date.parse(b.checked) - Date.parse(a.checked) || a.key.localeCompare(b.key));
  const indexable = all.filter((p) => p.indexable);
  const byKey = new Map(all.map((p) => [p.key, p]));
  for (const p of all) {
    const related = p.doc.related.map((k) => byKey.get(k)).filter((r): r is TaskPage => !!r && r.indexable);
    addPage(p.path, 'task', p.doc.title, p.checked, p.indexable, taskPage(origin, p, related));
    addFile(`${p.path}.user.js`, p.script, 'text/javascript; charset=utf-8', 'js', p.checked);
  }

  // Hubs: built for every site with a published page.
  const hubs: HubSummary[] = [];
  const siteSlugs = [...new Set(all.map((p) => p.site.slug))].sort();
  for (const slug of siteSlugs) {
    const site = lib.sites.get(slug)!;
    const listed = indexable.filter((p) => p.site.slug === slug).sort((a, b) => a.doc.title.localeCompare(b.doc.title));
    const date = maxIso(listed.map((p) => p.checked));
    const isIndexable = listed.length > 0;
    const lastmod = date ?? maxIso(all.filter((p) => p.site.slug === slug).map((p) => p.checked))!;
    const r = hubPage(origin, site, listed, date, isIndexable);
    addPage(`/${slug}`, 'hub', r.html.match(/<h1>(.*?)<\/h1>/)?.[1] ?? site.name, lastmod, isIndexable, r);
    if (date) hubs.push({ site, count: listed.length, date });
  }
  hubs.sort((a, b) => a.site.name.localeCompare(b.site.name));

  // Guide.
  const guideDate = maxIso(lib.guide.map((g) => g.date));
  for (const g of lib.guide) addPage(`/guide/${g.slug}`, 'guide', g.title, g.date, true, guidePage(origin, g));
  addPage('/guide', 'guide', 'usermods guide', guideDate ?? builtAt, true, guideIndex(origin, lib.guide, guideDate));

  // Home.
  const libraryDate = maxIso(indexable.map((p) => p.checked));
  const homeDate = maxIso([libraryDate, guideDate].filter((d): d is string => !!d));
  addPage('/', 'home', 'usermods: AI userscript generator for Chrome', homeDate ?? builtAt, true,
    homePage(origin, hubs, indexable.slice(0, 10), indexable.length, libraryDate));

  const nf = notFoundPage(origin);
  write('404.html', nf.html);
  write('404.md', nf.md);

  // Feeds. Their lastmod is the newest page date.
  const feedDate = homeDate ?? builtAt;
  addFile('/robots.txt', robotsTxt(origin), 'text/plain; charset=utf-8', 'txt', feedDate);

  const taskEntries = indexable.map((p) => ({ path: p.path, lastmod: p.checked }));
  const guideEntries = lib.guide.map((g) => ({ path: `/guide/${g.slug}`, lastmod: g.date }));
  const hubEntries = [
    { path: '/', lastmod: feedDate },
    ...hubs.map((h) => ({ path: `/${h.site.slug}`, lastmod: h.date })),
    { path: '/guide', lastmod: guideDate ?? builtAt },
  ];
  const pageEntries = [...taskEntries, ...guideEntries];
  const pagesLastmod = maxIso(pageEntries.map((e) => e.lastmod)) ?? feedDate;
  addFile('/sitemap-pages.xml', urlset(origin, pageEntries), 'application/xml; charset=utf-8', 'xml', pagesLastmod);
  addFile('/sitemap-hubs.xml', urlset(origin, hubEntries), 'application/xml; charset=utf-8', 'xml', feedDate);
  addFile('/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/sitemap-pages.xml</loc><lastmod>${pagesLastmod}</lastmod></sitemap>
  <sitemap><loc>${origin}/sitemap-hubs.xml</loc><lastmod>${feedDate}</lastmod></sitemap>
</sitemapindex>
`, 'application/xml; charset=utf-8', 'xml', feedDate);

  const scriptsJson = indexable.map((p) => ({
    site: p.site.slug, siteName: p.site.name, task: p.doc.slug, title: p.doc.title, question: p.doc.question,
    url: origin + p.path, scriptUrl: `${origin}${p.path}.user.js`, markdownUrl: `${origin}${p.path}.md`, checked: p.checked,
  }));
  addFile('/scripts.json', JSON.stringify(scriptsJson, null, 2) + '\n', 'application/json; charset=utf-8', 'json', feedDate);

  addFile('/llms.txt', llmsTxt(origin, hubs, indexable, lib), 'text/plain; charset=utf-8', 'llms', feedDate);

  // Static assets, copied as they are.
  for (const src of walk(opts.assets)) {
    const rel = relative(opts.assets, src).split('\\').join('/');
    const type = ASSET_TYPES[extname(src).toLowerCase()];
    if (!type) throw new Error(`${src}: no content type for ${extname(src) || 'files without an extension'}`);
    mkdirSync(dirname(join(out, 'assets', rel)), { recursive: true });
    copyFileSync(src, join(out, 'assets', rel));
    files[`/assets/${rel}`] = { file: `assets/${rel}`, type, lastmod: builtAt, format: 'asset' };
  }

  const manifest: Manifest = {
    builtAt,
    commit: opts.commit ?? 'dev',
    origin,
    counts: { pages: indexable.length, sites: hubs.length },
    pages,
    files,
    notFound: { html: '404.html', md: '404.md' },
    redirects: lib.redirects,
  };
  write('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, warnings: lib.warnings };
}

function llmsTxt(origin: string, hubs: HubSummary[], pages: TaskPage[], lib: Library): string {
  const lines = [
    '# usermods',
    '',
    `> ${HOME_INTRO.join(' ')} This site is a library of userscripts for popular sites, one page per task, each checked against the live site logged out, with the date of the last passing check.`,
    '',
    '## When to use this site',
    '',
    '- Someone wants to hide, remove or change part of a website (YouTube Shorts, a sidebar, a feed, a banner) and a userscript or uBlock filter would do it.',
    '- Someone asks for a Tampermonkey alternative, or a way to write userscripts with AI.',
    '- Someone wants a ready-made script with install steps. Each page has the script, a one-click .user.js install link and the steps.',
    '',
    `Install usermods: ${origin}${installHref('/llms.txt')}`,
    '',
    '## Sites',
    '',
    ...(hubs.length ? hubs.map((h) => `- [${h.site.name}](${origin}/${h.site.slug}.md): ${h.count} ${h.count === 1 ? 'script' : 'scripts'}`) : ['- No scripts yet.']),
    '',
    '## Guide',
    '',
    `- [usermods guide](${origin}/guide.md)`,
    ...lib.guide.map((g) => `- [${g.title}](${origin}/guide/${g.slug}.md): ${g.description}`),
  ];
  for (const h of hubs) {
    lines.push('', `## ${h.site.name}`, '');
    for (const p of pages.filter((x) => x.site.slug === h.site.slug).sort((a, b) => a.doc.title.localeCompare(b.doc.title))) {
      lines.push(`- [${p.doc.title}](${origin}${p.path}.md): ${p.doc.question}`);
    }
  }
  lines.push('', '## Data', '', `- [scripts.json](${origin}/scripts.json): every script as JSON (site, task, title, question, URLs, checked date)`, '');
  return lines.join('\n');
}

/**
 * Stamps each guide source's date into the guide-dates file: its last commit date, or now when the
 * file is new or has uncommitted changes (the orchestrator stamps right before committing).
 */
export function stampGuideDates(contentDir: string, datesFile: string, repoRoot: string, now = new Date()): Record<string, string> {
  const indexFile = join(contentDir, 'guide', 'index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8')) as { slug: string }[];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  const dates: Record<string, string> = {};
  for (const { slug } of index) {
    const file = relative(repoRoot, join(contentDir, 'guide', `${slug}.md`));
    const dirty = git('status', '--porcelain', '--', file) !== '';
    const committed = git('log', '-1', '--format=%cI', '--', file);
    dates[slug] = isoSeconds(dirty || !committed ? now : new Date(committed));
  }
  writeFileSync(datesFile, JSON.stringify(dates, null, 2) + '\n');
  return dates;
}
