// ==UserScript==
// @name         Table of contents for DEV articles
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a table of contents built from the article's headings to the right sidebar of dev.to articles.
// @match        https://dev.to/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/devto/table-of-contents.user.js
// @updateURL    https://usermods.kennethballenegger.com/devto/table-of-contents.user.js
// ==/UserScript==

// DEV already gives each heading in an article an anchor link (#overview, #branching...).
// The script lists the h2 and h3 headings of #article-body, links them to those anchors and
// puts the list at the top of the right sidebar, where it stays in view as you scroll.
GM_addStyle(`
  .usermods-toc {
    position: sticky; top: calc(var(--header-height, 56px) + 16px);
    max-height: calc(100vh - var(--header-height, 56px) - 32px); overflow-y: auto;
    margin-bottom: 16px; padding: 16px; border-radius: 8px;
    background: var(--card-bg, #fff); box-shadow: 0 0 0 1px var(--card-border, rgba(23, 23, 23, 0.05));
    font-size: 14px; line-height: 1.4;
  }
  .usermods-toc h2 { margin: 0 0 8px; font-size: 16px; font-weight: 700; }
  .usermods-toc ol { margin: 0; padding: 0; list-style: none; }
  .usermods-toc li { margin: 4px 0; }
  .usermods-toc li.h3 { padding-left: 14px; }
  .usermods-toc a { color: var(--card-color-tertiary, #575757); text-decoration: none; }
  .usermods-toc a:hover { color: var(--link-brand-color, #3b49df); }
`);

function build() {
  const body = document.querySelector('#article-body');
  const aside = document.querySelector('aside.crayons-layout__sidebar-right');
  if (!body || !aside || aside.querySelector('.usermods-toc')) return;
  const items = [];
  for (const h of body.querySelectorAll('h2, h3')) {
    // DEV puts an <a name="slug" href="#slug"> inside each heading.
    const anchor = h.querySelector('a[href^="#"]');
    const text = h.textContent.trim();
    if (anchor && text) items.push({ level: h.tagName.toLowerCase(), href: anchor.getAttribute('href'), text });
  }
  if (items.length < 2) return;
  const nav = document.createElement('nav');
  nav.className = 'usermods-toc';
  nav.setAttribute('aria-label', 'Table of contents');
  const title = document.createElement('h2');
  title.textContent = 'Contents';
  const list = document.createElement('ol');
  for (const { level, href, text } of items) {
    const li = document.createElement('li');
    li.className = level;
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    li.append(a);
    list.append(li);
  }
  nav.append(title, list);
  aside.prepend(nav);
}

// DEV loads some pages without a full reload, so rebuild when a new article body appears.
new MutationObserver(build).observe(document.documentElement, { childList: true, subtree: true });
build();
