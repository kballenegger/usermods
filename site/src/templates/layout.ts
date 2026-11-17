// The page shell shared by every HTML page, plus small formatting helpers.

import { escapeHtml } from '../markdown.ts';

export const CWS_URL = 'https://chromewebstore.google.com/detail/usermods/dhmdjekbeinhhnfhcgnkgdpgdafpboic';
export const GITHUB_URL = 'https://github.com/kballenegger/usermods';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

/** "17 November 2026", UTC. */
export function longDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "November 2026", UTC. */
export function monthYear(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function timeTag(iso: string): string {
  return `<time datetime="${iso}">${longDate(iso)}</time>`;
}

export const esc = escapeHtml;

/** Link to the Chrome Web Store through the counted /install redirect. */
export function installHref(fromPath: string): string {
  return `/install?from=${encodeURIComponent(fromPath)}`;
}

/** Trim to about 155 characters on a word boundary. */
export function metaDescription(s: string, max = 155): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.]$/, '') + '…';
}

export interface LayoutOpts {
  origin: string;
  path: string;
  title: string;
  description: string;
  mdPath: string;
  indexable: boolean;
  jsonld: object[];
  body: string;
  ogType?: 'website' | 'article';
  /** The home page: a wide main column, a large share image and the library filter script. */
  home?: boolean;
}

export function layout(o: LayoutOpts): string {
  const canonical = o.origin + o.path;
  const ld = o.jsonld
    .map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
${o.indexable ? '' : '<meta name="robots" content="noindex, follow">\n'}<link rel="canonical" href="${esc(canonical)}">
<link rel="alternate" type="text/markdown" href="${esc(o.origin + o.mdPath)}">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/icon-32.png" sizes="32x32" type="image/png">
<link rel="stylesheet" href="/assets/site.css">
<meta property="og:type" content="${o.ogType ?? 'website'}">
<meta property="og:site_name" content="usermods">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(canonical)}">
${o.home
    ? `<meta property="og:image" content="${esc(o.origin)}/assets/home/banner.jpg">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="400">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${esc(o.origin)}/assets/home/banner.jpg">`
    : `<meta property="og:image" content="${esc(o.origin)}/assets/icon-512.png">\n<meta name="twitter:card" content="summary">`}
${ld}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="brand" href="/"><img src="/assets/icon-32.png" width="32" height="32" alt=""> usermods</a>
  <nav aria-label="Site"><a href="/#sites">Scripts</a> <a href="/guide">Guide</a> <a href="${installHref(o.path)}" rel="nofollow">Add to Chrome</a></nav>
</header>
<main id="main"${o.home ? ' class="home"' : ''}>
${o.body}
</main>
<footer class="foot">
  <p>usermods is a Chrome extension that writes userscripts with AI, in a side panel on the page you want to change. <a href="${GITHUB_URL}" rel="noopener">Source on GitHub</a>.</p>
</footer>
<script src="/assets/copy.js" defer></script>
${o.home ? '<script src="/assets/filter.js" defer></script>\n' : ''}
</body>
</html>
`;
}
