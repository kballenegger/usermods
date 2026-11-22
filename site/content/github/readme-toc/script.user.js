// ==UserScript==
// @name         Add a table of contents to GitHub READMEs
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a table of contents for the README to the right sidebar of a GitHub repository page and keeps it in view while you scroll.
// @match        https://github.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/github/readme-toc.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/readme-toc.user.js
// ==/UserScript==

const TOC_ID = 'usermods-readme-toc';

GM_addStyle(`
  /* The pane is overflow: auto, which would make it the sticky container and stop the
     list from following the page scroll. */
  [class*="prc-PageLayout-Pane-"]:has(> #${TOC_ID}) { overflow: visible !important; }
  #${TOC_ID} {
    position: sticky;
    top: 16px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    margin-top: 16px;
    padding: 12px 0 12px 0;
    border-top: 1px solid var(--borderColor-muted, #d0d7de);
    font-size: 13px;
  }
  #${TOC_ID} h2 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
  #${TOC_ID} ol { list-style: none; margin: 0; padding: 0; }
  #${TOC_ID} li { margin: 0; padding: 2px 0; line-height: 1.4; }
  #${TOC_ID} li[data-level="2"] { padding-left: 12px; }
  #${TOC_ID} li[data-level="3"] { padding-left: 24px; }
  #${TOC_ID} a { color: var(--fgColor-default, #1f2328); }
  #${TOC_ID} a:hover { color: var(--fgColor-accent, #0969da); }
`);

// The README on a repository's front page is the article.markdown-body. Each heading sits in a
// .markdown-heading wrapper next to an a.anchor whose href is the heading's #fragment.
// The right sidebar is the Primer PageLayout pane that holds the "About" section; its class
// names end in a build hash, so they are matched by prefix. The pane is as tall as the page,
// which lets a position: sticky box inside it follow the scroll.
function update() {
  const article = document.querySelector('article.markdown-body');
  const pane = document.querySelector('[class*="prc-PageLayout-Pane-"]:has([class*="sidebarSection"])');
  const existing = document.getElementById(TOC_ID);
  if (!article || !pane) {
    existing?.remove();
    return;
  }
  // h1-h3 only; deeper levels make the list too long to scan. Levels are shifted so the
  // shallowest heading in the README starts at the left edge.
  const heads = [...article.querySelectorAll('.markdown-heading')]
    .map((wrap) => ({ h: wrap.querySelector('h1, h2, h3'), a: wrap.querySelector('a.anchor[href^="#"]') }))
    .filter((x) => x.h && x.a);
  const key = heads.map((x) => x.a.getAttribute('href')).join('|');
  if (existing && existing.parentElement === pane && existing.dataset.key === key) return;
  existing?.remove();
  if (heads.length < 2) return;

  const top = Math.min(...heads.map((x) => Number(x.h.tagName[1])));
  const box = document.createElement('nav');
  box.id = TOC_ID;
  box.dataset.key = key;
  box.setAttribute('aria-label', 'README contents');
  const title = document.createElement('h2');
  title.textContent = 'Contents';
  const list = document.createElement('ol');
  for (const { h, a } of heads) {
    const li = document.createElement('li');
    li.dataset.level = String(Number(h.tagName[1]) - top + 1);
    const link = document.createElement('a');
    link.href = a.getAttribute('href');
    // Badge images leave separators such as "React ·" behind; drop them.
    link.textContent = h.textContent.trim().replace(/[\s·|]+$/, '');
    li.append(link);
    list.append(li);
  }
  box.append(title, list);
  pane.append(box);
}

// GitHub swaps pages in place when you navigate, and the README renders after the first
// paint, so rebuild whenever the DOM changes (at most once per frame).
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    update();
  });
}).observe(document, { childList: true, subtree: true });
