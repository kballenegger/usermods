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

export interface HubSummary { site: Site; count: number; date: string; pages: TaskPage[] }

export const HOME_INTRO = [
  'usermods is a Chrome extension that writes userscripts with AI. Open its side panel on any site, say what you want changed, and it writes, runs and saves the script for you.',
  'It works with any LLM provider you connect, and it installs ordinary .user.js scripts the way Tampermonkey does.',
];

const HOME_TAGLINE = 'Your web. Your rules. Vibe-code userscripts in place.';

const HOME_ABOUT = 'The model inspects the page, writes a userscript, tests it live, and hands it to you with Try and Save buttons. ' +
  'Saved mods run on every matching page load. Export them as standard .user.js files, share them as a GitHub gist or on Greasy Fork, ' +
  'install scripts from Greasy Fork or any page that offers one, or bring your whole Tampermonkey library across in one file.';

const COMPANION = 'This website is the companion to the usermods extension. It hosts a library of tested userscripts and the guide. ' +
  'The extension itself runs in Chrome, in a side panel next to the page you want to change.';

const gh = (path: string) => `${GITHUB_URL}/blob/main/${path}`;

/** Lead-in plus detail, shared by the HTML and the twin. Text is plain; `code` spans are marked with backticks. */
const WHY: [string, string][] = [
  ['Any backend.', 'Anthropic, OpenAI, xAI, OpenRouter, or anything OpenAI-compatible: Ollama, LM Studio, vLLM, mlx_lm. Your key, your machine. No account, no hosted service.'],
  ['Use the subscription you already pay for.', 'Sign in with ChatGPT (Plus, Pro, Team) or SuperGrok / X Premium+ from Settings. No API key, no local proxy, no per-token bill.'],
  ['The model sees the page.', 'It reads a pruned DOM, lists elements, reads computed styles, takes screenshots, and runs scripts to test its work before it proposes anything.'],
  ['One-off tasks too.', '"Scroll to the bottom, open every carousel, and give me download links for all the photos" runs as a script. No mod required.'],
  ['Portable.', 'Mods are plain userscripts with a `==UserScript==` header. Nothing proprietary, and the extension is MIT licensed.'],
];

const FEATURES: [string, string][] = [
  ['Chat that inspects the page and writes a mod.', 'It reads the real DOM, tries things with `run_script`, and tests the finished script the way the saved mod will run, on a fresh page load when that matters. Only then does it propose something you can Try and Save, and the proposal says how it was tested.'],
  ['Any provider, including subscriptions.', 'Anthropic, OpenAI, xAI, OpenRouter, any OpenAI-compatible endpoint, and ChatGPT or SuperGrok sign-in. Connect several, pick the model and thinking level per chat, and switch mid-conversation.'],
  ['Edit any installed mod in chat.', 'Imported ones too. Update mod writes back over the same mod, with its header and stored values intact.'],
  ['Tampermonkey import and GM compatibility.', 'One backup file brings the whole library across, with the `GM_*` API, `@require`, `@resource` and `@connect` the scripts expect.'],
  ['Images and screenshots.', 'Paste or drop a mockup into the composer, and the model can capture the tab to check its own work. Text-only endpoints are detected and told to work from the page structure instead.'],
  ['Drafts with versions.', 'Each chat keeps one draft mod with a version strip, line diffs and a roll back you can undo.'],
  ['Dashboard.', 'Every chat and every mod across every site in a full tab, with search, bulk actions and a source editor.'],
  ['Safari.', 'The same extension builds for Mac, iPhone and iPad, subscription sign-in included.'],
];

interface Shot { file: string; w: number; h: number; alt: string; title: string; caption: string }

const SHOTS: Shot[] = [
  { file: '02-chat-refs.webp', w: 560, h: 1094, title: 'Point at an element.',
    caption: 'Choose Point at element from the + menu, then click something on the page. An `@reference` drops into your message, so "this" means that element.',
    alt: 'The composer holding an @img.mw-file-element chip produced by the element picker.' },
  { file: '12-model-picker.webp', w: 560, h: 1094, title: 'Pick the model in the chat.',
    caption: 'One chip holds every connected provider\'s models and the thinking level. Change it mid-conversation and the next turn goes to the new model.',
    alt: 'The model dropdown open from the chip in the chat bar: a filter field, the models of two connected providers grouped under their names, and a Thinking row.' },
  { file: '03-mods.webp', w: 560, h: 1094, title: 'Mods.',
    caption: 'Saved scripts, split by whether they match the page you are on. Toggle, run, export or delete each one.',
    alt: 'The Mods view listing three saved mods, split into the ones matching this site and the rest.' },
  { file: '01-chat-proposal-light.webp', w: 560, h: 1094, title: 'Light and dark.',
    caption: 'The panel follows your OS theme. The day theme has its own design, not night inverted.',
    alt: 'The proposal conversation in the day theme: white panels on a cool blue-white page, a blue active tab and the hero card edged in magenta.' },
  { file: '07-dashboard.webp', w: 1600, h: 1052, title: 'Dashboard.',
    caption: 'Every chat and every mod across every site, in a full tab.',
    alt: 'The dashboard, showing the overview strip, chats grouped by host, and a transcript preview.' },
  { file: '05-install.webp', w: 1200, h: 1096, title: 'Installing an outside script.',
    caption: 'A `.user.js` link shows what the script matches, what it is granted and what it loads, before anything is saved.',
    alt: 'The install page previewing a script fetched from Greasy Fork, with its matches, GM permissions and required library.' },
];

const HERO_ALT = 'usermods in the Chrome side panel next to a GitHub repository page, mid-conversation: a proposed mod that collapses the file list is saved and enabled, and the user is asking for a follow-up change.';

const STEPS_TEXT = [
  'Add usermods to Chrome from the Chrome Web Store. It is free and needs Chrome 135 or later.',
  'Open chrome://extensions, click Details on usermods, and turn on Allow User Scripts. Chrome requires this toggle for any extension that runs userscripts, Tampermonkey included.',
  'Click the usermods icon to open the side panel on that tab. Go to Settings and click a preset under Add provider. Paste an API key or a local server URL, or sign in with ChatGPT or SuperGrok. It saves as you go. Back in Chat, the model is the chip in the chat bar.',
];

const PRIVACY = [
  'usermods has no server, no account and no telemetry. The author receives nothing.',
  'To change a page, the model has to see it. When you send a message, usermods sends your message, the page\'s address and title, a pruned copy of its HTML, details of elements it looks up or you point at, and a screenshot of the visible tab when the model asks for one. All of it goes from your browser straight to the provider you picked for that chat, and nowhere else. If the page is your mailbox or your bank, that content goes too, so close the panel on pages you would rather not share. Point usermods at a local model and nothing leaves your machine.',
  'Your API keys, subscription tokens, saved mods, their GM_setValue stores and your chat history stay in extension storage on your device. Keys and tokens go only to the endpoint they authenticate.',
];

/** `code` spans to <code>, everything else escaped. */
const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const LINKS: [string, string, string][] = [
  ['Guide', '/guide', 'Providers, models, subscriptions, editing, importing, the dashboard.'],
  ['Source on GitHub', GITHUB_URL, 'The code, issues and the build-from-source steps, including Safari.'],
  ['GM API compatibility', gh('docs/gm-api.md'), 'The GM_* table, @connect and the page world.'],
  ['Architecture', gh('docs/architecture.md'), 'The agent loop, drafts, compaction, storage and security notes.'],
  ['Every screenshot', gh('docs/screenshots.md'), 'Every screen in both themes, plus the iPhone build.'],
  ['Changelog', gh('CHANGELOG.md'), 'What changed in each version.'],
];

export function homePage(origin: string, hubs: HubSummary[], total: number, date: string | null): Rendered {
  const title = 'usermods: AI userscript generator for Chrome';
  const stats = date
    ? `${plural(total, 'script', 'scripts')} for ${plural(hubs.length, 'site', 'sites')}, last checked ${longDate(date)}.`
    : '';
  const install = installHref('/');

  const library = hubs.length
    ? `<div class="filter" hidden><label for="filter">Filter scripts</label> <input type="search" id="filter" placeholder="youtube, shorts, dark mode" autocomplete="off"> <span id="filter-count" class="count" aria-live="polite"></span></div>
<div class="library">
${hubs.map((h) => `<section class="hub" aria-labelledby="hub-${h.site.slug}"><h3 id="hub-${h.site.slug}"><a href="/${h.site.slug}">${esc(h.site.name)}</a> <span class="count">${plural(h.count, 'script', 'scripts')}</span></h3>
<ul>${h.pages.map((p) => `<li><a href="${p.path}">${esc(p.doc.title)}</a></li>`).join('')}</ul></section>`).join('\n')}
</div>
<p class="empty" hidden>No script matches that. <a href="/guide">Write your own with usermods</a>.</p>`
    : '<p>No scripts yet.</p>';

  const body = `<section class="hero" aria-labelledby="top">
<div class="wrap">
<img class="banner" src="/assets/home/banner.webp" width="1600" height="534" alt="usermods. ${esc(HOME_TAGLINE)}" fetchpriority="high">
<div class="hero-text">
<h1 id="top">AI userscript generator for Chrome</h1>
<p class="lede">${esc(HOME_INTRO[0]!)}</p>
<p>${esc(HOME_INTRO[1]!)} ${esc(HOME_ABOUT)}</p>
<div class="actions"><a class="btn primary" href="${install}" rel="nofollow" data-umami-event="get-usermods">Add to Chrome, free</a> <a class="btn" href="#library">Browse ${total ? `${total} ` : ''}scripts</a> <a class="btn" href="${GITHUB_URL}" rel="noopener">GitHub</a></div>
${stats ? `<p class="checked">${esc(stats)}</p>` : ''}
</div>
<p class="companion"><strong>New here?</strong> ${esc(COMPANION)}</p>
</div>
</section>

<section class="band dark" aria-labelledby="video"><div class="wrap">
<h2 id="video">See it work</h2>
<video class="frame" controls preload="none" playsinline width="1280" height="720" poster="/assets/home/launch-poster.webp">
<source src="/assets/home/launch.mp4" type="video/mp4">
<a href="/assets/home/launch.mp4">Download the one-minute launch video (MP4)</a>.
</video>
<figure class="shot wide"><img src="/assets/home/hero-github.webp" width="1600" height="1046" loading="lazy" alt="${esc(HERO_ALT)}">
<figcaption>The side panel on a GitHub repository page. A saved mod collapses the file list, and the chat continues with a follow-up change.</figcaption></figure>
</div></section>

<section class="band" aria-labelledby="why"><div class="wrap">
<h2 id="why">Why usermods</h2>
<ul class="why">${WHY.map(([h, t]) => `<li><strong>${esc(h)}</strong> ${inline(t)}</li>`).join('')}</ul>
</div></section>

<section class="band alt" aria-labelledby="screens"><div class="wrap">
<h2 id="screens">Screenshots</h2>
<div class="shots">
${SHOTS.map((s) => `<figure class="shot${s.w > s.h ? ' wide' : ''}"><img src="/assets/home/${s.file}" width="${s.w}" height="${s.h}" loading="lazy" alt="${esc(s.alt)}"><figcaption><strong>${esc(s.title)}</strong> ${inline(s.caption)}</figcaption></figure>`).join('\n')}
</div>
<p class="more"><a href="${gh('docs/screenshots.md')}" rel="noopener">Every screen in both themes, and the iPhone build</a></p>
</div></section>

<section class="band" aria-labelledby="features"><div class="wrap">
<h2 id="features">Features</h2>
<ul class="features">${FEATURES.map(([h, t]) => `<li><strong>${esc(h)}</strong> ${inline(t)}</li>`).join('')}</ul>
</div></section>

<section class="band alt" aria-labelledby="install"><div class="wrap two">
<div>
<h2 id="install">Install</h2>
<ol class="steps big">
<li><a href="${install}" rel="nofollow" data-umami-event="get-usermods">Add usermods to Chrome</a> from the Chrome Web Store. It is free and needs Chrome 135 or later.</li>
<li>Open <code>chrome://extensions</code>, click <strong>Details</strong> on usermods, and turn on <strong>Allow User Scripts</strong>. Chrome requires this toggle for any extension that runs userscripts, Tampermonkey included.</li>
<li>Click the usermods icon to open the side panel on that tab. Go to <strong>Settings</strong> and click a preset under <strong>Add provider</strong>. Paste an API key or a local server URL, or sign in with ChatGPT or SuperGrok. It saves as you go. Back in <strong>Chat</strong>, the model is the chip in the chat bar.</li>
</ol>
<p>To build from source, or for Safari on Mac, iPhone and iPad, follow the <a href="${GITHUB_URL}#install-from-source" rel="noopener">README on GitHub</a>.</p>
</div>
<div>
<h2 id="privacy">Privacy</h2>
<div class="box">${PRIVACY.map((p) => `<p>${esc(p)}</p>`).join('')}
<p>The panel shows this notice before your first message. The full policy is <a href="${gh('PRIVACY.md')}" rel="noopener">PRIVACY.md</a>.</p></div>
</div>
</div></section>

<section class="band" aria-labelledby="more"><div class="wrap">
<h2 id="more">Learn more</h2>
<ul class="links">${LINKS.map(([t, href, d]) => `<li><a href="${href}"${href.startsWith('http') ? ' rel="noopener"' : ''}>${esc(t)}</a> <span>${esc(d)}</span></li>`).join('')}</ul>
</div></section>

<section class="band lib" id="library" aria-labelledby="sites"><div class="wrap">
<h2 id="sites">Scripts by site</h2>
<p>Every script below is a tested userscript with its own page: the script, a one-click install link, and the steps. Each one passed a check against the live site, logged out.${stats ? ` ${esc(stats)}` : ''}</p>
${library}
<p class="more"><a href="/guide">How usermods works: the guide</a></p>
</div></section>`;

  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'usermods', url: origin + '/' },
    {
      '@context': 'https://schema.org', ...SOFTWARE_APP,
      description: `${HOME_INTRO.join(' ')} ${HOME_ABOUT}`,
      operatingSystem: 'Chrome 135+',
      license: 'https://opensource.org/licenses/MIT',
      screenshot: `${origin}/assets/home/hero-github.webp`,
      featureList: FEATURES.map(([h]) => h.replace(/\.$/, '')),
      sameAs: [GITHUB_URL],
    },
  ];
  const html = layout({ origin, path: '/', mdPath: '/index.md', indexable: true, jsonld, body, title, home: true,
    description: metaDescription(HOME_INTRO[0]!) });

  const mdList = (items: [string, string][]) => items.map(([h, t]) => `- **${h}** ${t}`).join('\n');
  const md = (date ? mdFront('Checked', date, origin, '/') : `Canonical: ${origin}/\n\n`) +
    `# AI userscript generator for Chrome\n\n${HOME_TAGLINE}\n\n${HOME_INTRO.join('\n\n')}\n\n${HOME_ABOUT}\n\n${COMPANION}\n\n` +
    `Add to Chrome: ${origin}${install}\n\nSource: ${GITHUB_URL}\n\n` +
    (stats ? `${stats}\n\n` : '') +
    `Launch video (one minute): ${origin}/assets/home/launch.mp4\n\n` +
    `## Why usermods\n\n${mdList(WHY)}\n\n` +
    `## Screenshots\n\n` + SHOTS.map((s) => `- ![${s.alt}](${origin}/assets/home/${s.file}) **${s.title}** ${s.caption}`).join('\n') + '\n\n' +
    `## Features\n\n${mdList(FEATURES)}\n\n` +
    `## Install\n\n` + STEPS_TEXT.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    `\n\nTo build from source, or for Safari, see ${GITHUB_URL}#install-from-source\n\n` +
    `## Privacy\n\n${PRIVACY.join('\n\n')}\n\nFull policy: ${gh('PRIVACY.md')}\n\n` +
    `## Learn more\n\n` + LINKS.map(([t, href, d]) => `- [${t}](${href.startsWith('/') ? `${origin}${href}.md` : href}): ${d}`).join('\n') + '\n\n' +
    `## Scripts by site\n\n` +
    (hubs.length
      ? hubs.map((h) => `### [${h.site.name}](${origin}/${h.site.slug}.md)\n\n` +
        h.pages.map((p) => `- [${p.doc.title}](${origin}${p.path}.md)`).join('\n')).join('\n\n')
      : 'No scripts yet.') +
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
