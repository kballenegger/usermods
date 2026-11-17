// Every page the site serves, each as HTML plus its markdown twin.

import type { GuideDoc, Site, TaskPage } from '../build/content.ts';
import { renderMarkdown } from '../markdown.ts';
import {
  CWS_URL, GITHUB_URL, esc, installHref, layout, longDate, metaDescription, monthYear, timeTag,
} from './layout.ts';

export interface Rendered { html: string; md: string }

const SOFTWARE_APP = {
  '@type': 'SoftwareApplication',
  name: 'usermods',
  applicationCategory: 'BrowserApplication',
  operatingSystem: 'Chrome',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  downloadUrl: CWS_URL,
  url: CWS_URL,
};

function breadcrumbs(origin: string, items: [string, string][]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: origin + path })),
  };
}

function mdFront(label: 'Checked' | 'Updated', iso: string, origin: string, path: string): string {
  return `${label}: ${longDate(iso)}\nCanonical: ${origin}${path}\n\n`;
}

const scriptUrl = (p: TaskPage) => `${p.path}.user.js`;

const ALT_LABEL: Record<string, string> = {
  'site-setting': 'Site setting',
  ublock: 'uBlock Origin filter',
  extension: 'Extension',
  other: 'Other',
};

/** The usermods steps, shared by the HTML, the twin and the HowTo JSON-LD. */
function applySteps(p: TaskPage): { name: string; text: string }[] {
  return [
    { name: 'Add usermods to Chrome', text: 'Open usermods in the Chrome Web Store and click Add to Chrome. It is free.' },
    {
      name: 'Allow user scripts',
      text: 'Open chrome://extensions, click Details on usermods and turn on Allow User Scripts. Chrome requires this for any extension that runs userscripts.',
    },
    {
      name: 'Install this script',
      text: 'Click Install this script on this page. usermods opens its install page with a preview of the script; click Install.',
    },
    { name: `Reload ${p.site.name}`, text: `Reload any open ${p.site.name} tab. The script runs on every matching page from then on.` },
  ];
}

export function taskPage(origin: string, p: TaskPage, related: TaskPage[]): Rendered {
  const { doc, site } = p;
  const steps = applySteps(p);
  const failLine = p.failedAt
    ? `<p class="warn">This script failed its check on ${timeTag(p.failedAt)}. It is being fixed.</p>`
    : '';
  const alternatives = doc.alternatives.length
    ? `<section aria-labelledby="alts"><h2 id="alts">Other ways to do it</h2>
${doc.alternatives.map((a) => `<h3><span class="tag">${esc(ALT_LABEL[a.kind] ?? a.kind)}</span> ${esc(a.title)}</h3>\n${renderMarkdown(a.body, { headingOffset: 3 })}`).join('\n')}
</section>`
    : '';
  const relatedHtml = related.length
    ? `<section aria-labelledby="related"><h2 id="related">Related</h2><ul>${related.map((r) => `<li><a href="${r.path}">${esc(r.doc.title)}</a></li>`).join('')}</ul></section>`
    : '';

  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">usermods</a> / <a href="/${site.slug}">${esc(site.name)}</a></nav>
<article>
<h1>${esc(doc.title)}</h1>
<p class="answer">${esc(doc.answer)}</p>
<p class="checked">Checked ${timeTag(p.checked)}</p>
${failLine}
<div class="actions">
  <a class="btn primary" href="${scriptUrl(p)}" data-umami-event="install-script">Install this script</a>
  <a class="btn" href="${installHref(p.path)}" rel="nofollow" data-umami-event="get-usermods">Get usermods</a>
</div>
<section aria-labelledby="script"><h2 id="script">The script</h2>
<div class="code"><button type="button" class="copy" data-copy="script-src">Copy</button><pre><code id="script-src">${esc(p.script.toString('utf8'))}</code></pre></div>
</section>
<section aria-labelledby="apply"><h2 id="apply">Apply it with usermods</h2>
<ol class="steps">
${steps.map((s, i) => `<li><strong>${esc(s.name)}.</strong> ${i === 0
    ? `Open <a href="${installHref(p.path)}" rel="nofollow">usermods in the Chrome Web Store</a> and click Add to Chrome. It is free.`
    : i === 2 ? `Click <a href="${scriptUrl(p)}">Install this script</a>. usermods opens its install page with a preview of the script; click <strong>Install</strong>.`
    : esc(s.text)}</li>`).join('\n')}
</ol>
<p>Or write it yourself: open the usermods side panel on ${esc(site.name)} and type this. The panel needs a model provider first (Settings, then Add provider).</p>
<div class="code"><button type="button" class="copy" data-copy="prompt">Copy</button><pre><code id="prompt">${esc(doc.prompt)}</code></pre></div>
</section>
${doc.details ? `<section aria-labelledby="details"><h2 id="details">What it changes</h2>\n${renderMarkdown(doc.details, { headingOffset: 2 })}\n</section>` : ''}
${alternatives}
${relatedHtml}
<p class="more"><a href="/${site.slug}">All ${esc(site.name)} userscripts</a></p>
</article>`;

  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: doc.title,
      description: doc.answer,
      url: origin + p.path,
      datePublished: p.firstPassed,
      dateModified: p.checked,
      tool: SOFTWARE_APP,
      step: steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text })),
    },
    breadcrumbs(origin, [['usermods', '/'], [site.name, `/${site.slug}`], [doc.title, p.path]]),
  ];

  const html = layout({
    origin, path: p.path, mdPath: `${p.path}.md`, indexable: p.indexable, jsonld, body, ogType: 'article',
    title: `${doc.title} (${site.name} userscript, checked ${monthYear(p.checked)})`,
    description: metaDescription(doc.answer),
  });

  const md = mdFront('Checked', p.checked, origin, p.path) +
    `# ${doc.title}\n\n${doc.answer}\n\n` +
    (p.failedAt ? `This script failed its check on ${longDate(p.failedAt)}. It is being fixed.\n\n` : '') +
    `Install this script: ${origin}${scriptUrl(p)}\n` +
    `Get usermods: ${origin}${installHref(p.path)}\n\n` +
    `## The script\n\n\`\`\`js\n${p.script.toString('utf8').replace(/\n$/, '')}\n\`\`\`\n\n` +
    `## Apply it with usermods\n\n` +
    steps.map((s, i) => `${i + 1}. **${s.name}.** ${s.text}`).join('\n') +
    `\n\nOr open the usermods side panel on ${site.name} (with a model provider set up under Settings) and type:\n\n` +
    `\`\`\`text\n${doc.prompt}\n\`\`\`\n` +
    (doc.details ? `\n## What it changes\n\n${doc.details}\n` : '') +
    (doc.alternatives.length
      ? `\n## Other ways to do it\n\n` + doc.alternatives.map((a) => `### ${ALT_LABEL[a.kind] ?? a.kind}: ${a.title}\n\n${a.body}\n`).join('\n')
      : '') +
    (related.length ? `\n## Related\n\n` + related.map((r) => `- [${r.doc.title}](${origin}${r.path}.md)`).join('\n') + '\n' : '') +
    `\nAll ${site.name} userscripts: ${origin}/${site.slug}.md\n`;

  return { html, md };
}

/** "1 tweak" / "N tweaks". */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return (m?.[1] ?? s).trim();
}

export function hubPage(origin: string, site: Site, pages: TaskPage[], date: string | null, indexable: boolean): Rendered {
  const path = `/${site.slug}`;
  const n = pages.length;
  const h1 = date
    ? `${site.name} userscripts: ${plural(n, 'tweak', 'tweaks')} checked ${monthYear(date)}`
    : `${site.name} userscripts`;
  const lede = date
    ? `${plural(n, 'script', 'scripts')} for ${site.name}, last checked ${longDate(date)}.`
    : `No ${site.name} scripts are passing their checks right now.`;
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">usermods</a></nav>
<h1>${esc(h1)}</h1>
<p class="lede">${esc(lede)}</p>
<p>${esc(site.intro)}</p>
<ul class="cards">
${pages.map((p) => `<li><a href="${p.path}">${esc(p.doc.title)}</a><p>${esc(firstSentence(p.doc.answer))}</p><p class="checked">Checked ${timeTag(p.checked)}</p></li>`).join('\n')}
</ul>
<div class="actions"><a class="btn" href="${installHref(path)}" rel="nofollow" data-umami-event="get-usermods">Get usermods</a></div>`;
  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: h1,
      description: lede,
      url: origin + path,
      ...(date ? { dateModified: date } : {}),
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: n,
        itemListElement: pages.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.doc.title, url: origin + p.path })),
      },
    },
    breadcrumbs(origin, [['usermods', '/'], [site.name, path]]),
  ];
  const html = layout({ origin, path, mdPath: `${path}.md`, indexable, jsonld, body, title: h1, description: metaDescription(`${lede} ${site.intro}`) });
  const md = (date ? mdFront('Checked', date, origin, path) : `Canonical: ${origin}${path}\n\n`) +
    `# ${h1}\n\n${lede}\n\n${site.intro}\n\n` +
    pages.map((p) => `- [${p.doc.title}](${origin}${p.path}.md): ${firstSentence(p.doc.answer)} Checked ${longDate(p.checked)}.`).join('\n') +
    `\n\nGet usermods: ${origin}${installHref(path)}\n`;
  return { html, md };
}

export interface HubSummary { site: Site; count: number; date: string }

export const HOME_INTRO = [
  'usermods is a Chrome extension that writes userscripts with AI. Open its side panel on any site, say what you want changed, and it writes, runs and saves the script for you.',
  'It works with any LLM provider you connect, and it installs ordinary .user.js scripts the way Tampermonkey does.',
];

export function homePage(origin: string, hubs: HubSummary[], newest: TaskPage[], total: number, date: string | null): Rendered {
  const title = 'usermods: AI userscript generator for Chrome';
  const stats = date
    ? `${plural(total, 'script', 'scripts')} for ${plural(hubs.length, 'site', 'sites')}, last checked ${longDate(date)}.`
    : '';
  const body = `<h1>AI userscript generator for Chrome</h1>
<p class="lede">${esc(HOME_INTRO[0]!)}</p>
<p>${esc(HOME_INTRO[1]!)}</p>
<div class="actions"><a class="btn primary" href="${installHref('/')}" rel="nofollow" data-umami-event="get-usermods">Add to Chrome</a> <a class="btn" href="/guide">Read the guide</a></div>
${stats ? `<p class="checked">${esc(stats)}</p>` : ''}
<section aria-labelledby="sites"><h2 id="sites">Scripts by site</h2>
${hubs.length ? `<ul class="hubs">${hubs.map((h) => `<li><a href="/${h.site.slug}">${esc(h.site.name)}</a> <span class="count">${plural(h.count, 'script', 'scripts')}</span></li>`).join('')}</ul>` : '<p>No scripts yet.</p>'}
</section>
${newest.length ? `<section aria-labelledby="newest"><h2 id="newest">Recently checked</h2><ul class="cards">${newest.map((p) => `<li><a href="${p.path}">${esc(p.doc.title)}</a><p class="checked">${esc(p.site.name)}, checked ${timeTag(p.checked)}</p></li>`).join('')}</ul></section>` : ''}
<p class="more"><a href="/guide">How usermods works: the guide</a></p>`;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'usermods', url: origin + '/' },
    { '@context': 'https://schema.org', ...SOFTWARE_APP, description: HOME_INTRO.join(' '), sameAs: [GITHUB_URL] },
  ];
  const html = layout({ origin, path: '/', mdPath: '/index.md', indexable: true, jsonld, body, title, description: metaDescription(HOME_INTRO[0]!) });
  const md = (date ? mdFront('Checked', date, origin, '/') : `Canonical: ${origin}/\n\n`) +
    `# AI userscript generator for Chrome\n\n${HOME_INTRO.join('\n\n')}\n\nAdd to Chrome: ${origin}${installHref('/')}\n\n` +
    (stats ? `${stats}\n\n` : '') +
    `## Scripts by site\n\n` +
    (hubs.length ? hubs.map((h) => `- [${h.site.name}](${origin}/${h.site.slug}.md): ${plural(h.count, 'script', 'scripts')}`).join('\n') : 'No scripts yet.') +
    (newest.length ? `\n\n## Recently checked\n\n` + newest.map((p) => `- [${p.doc.title}](${origin}${p.path}.md): ${p.site.name}, checked ${longDate(p.checked)}`).join('\n') : '') +
    `\n\nGuide: ${origin}/guide.md\n`;
  return { html, md };
}

export function guideIndex(origin: string, docs: GuideDoc[], date: string | null): Rendered {
  const title = 'usermods guide';
  const lede = 'How each part of usermods works, one page per feature.';
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">usermods</a></nav>
<h1>${title}</h1>
<p class="lede">${lede}</p>
<ul class="cards">${docs.map((d) => `<li><a href="/guide/${d.slug}">${esc(d.title)}</a><p>${esc(d.description)}</p></li>`).join('')}</ul>`;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url: `${origin}/guide`, ...(date ? { dateModified: date } : {}) },
    breadcrumbs(origin, [['usermods', '/'], ['Guide', '/guide']]),
  ];
  const html = layout({ origin, path: '/guide', mdPath: '/guide.md', indexable: true, jsonld, body, title, description: lede });
  const md = (date ? mdFront('Updated', date, origin, '/guide') : `Canonical: ${origin}/guide\n\n`) +
    `# ${title}\n\n${lede}\n\n` + docs.map((d) => `- [${d.title}](${origin}/guide/${d.slug}.md): ${d.description}`).join('\n') + '\n';
  return { html, md };
}

export function guidePage(origin: string, d: GuideDoc): Rendered {
  const path = `/guide/${d.slug}`;
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">usermods</a> / <a href="/guide">Guide</a></nav>
<article>
<h1>${esc(d.title)}</h1>
<p class="checked">Updated ${timeTag(d.date)}</p>
${renderMarkdown(d.markdown, { headingOffset: 1 })}
<div class="actions"><a class="btn" href="${installHref(path)}" rel="nofollow" data-umami-event="get-usermods">Get usermods</a></div>
</article>`;
  const jsonld = [
    {
      '@context': 'https://schema.org', '@type': 'TechArticle', headline: d.title, description: d.description,
      url: origin + path, dateModified: d.date, about: SOFTWARE_APP,
    },
    breadcrumbs(origin, [['usermods', '/'], ['Guide', '/guide'], [d.title, path]]),
  ];
  const html = layout({ origin, path, mdPath: `${path}.md`, indexable: true, jsonld, body, ogType: 'article', title: `${d.title} (usermods guide)`, description: metaDescription(d.description) });
  const md = mdFront('Updated', d.date, origin, path) + `# ${d.title}\n\n${d.markdown}\n`;
  return { html, md };
}

export function notFoundPage(origin: string): Rendered {
  const body = `<h1>Page not found</h1>
<p>There is nothing at this address. <a href="/">See every script</a> or <a href="/guide">read the guide</a>.</p>`;
  const html = layout({ origin, path: '/404', mdPath: '/index.md', indexable: false, jsonld: [], body, title: 'Page not found (usermods)', description: 'Page not found.' });
  return { html, md: `# Page not found\n\nThere is nothing at this address. Every script: ${origin}/index.md\n` };
}
