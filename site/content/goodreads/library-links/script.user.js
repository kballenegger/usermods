// ==UserScript==
// @name         Search your library from Goodreads
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds WorldCat, OverDrive and Open Library search links for the book under the buttons on Goodreads book pages.
// @match        https://www.goodreads.com/book/show/*
// @run-at       document-idle
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/goodreads/library-links.user.js
// @updateURL    https://usermods.kennethballenegger.com/goodreads/library-links.user.js
// ==/UserScript==

// The links are plain search URLs built from the title and first author on the page.
// Nothing is fetched: the script cannot tell you whether a library has the book, only
// take you to the search that answers it.

GM_addStyle(`
  .um-library-links { margin: 12px 0 0; padding: 10px 12px; border: 1px solid #d8d8d8; border-radius: 8px; font-size: 14px; }
  .um-library-links strong { display: block; margin-bottom: 6px; }
  .um-library-links a { display: block; padding: 3px 0; color: #00635d; text-decoration: underline; }
`);

function buildLinks() {
  const titleEl = document.querySelector('h1[data-testid="bookTitle"]');
  const authorEl = document.querySelector('.ContributorLink__name');
  if (!titleEl) return null;
  // Drop a subtitle after a colon so the search matches more editions.
  const title = titleEl.textContent.trim().split(/:\s/)[0];
  const author = authorEl ? authorEl.textContent.trim() : '';
  const q = (s) => encodeURIComponent(s);
  const box = document.createElement('div');
  box.className = 'um-library-links';
  box.dataset.umTitle = titleEl.textContent;
  const head = document.createElement('strong');
  head.textContent = 'Find it at a library';
  box.append(head);
  const links = [
    ['WorldCat (libraries near you)', `https://search.worldcat.org/search?q=${q(`ti:${title}${author ? ` au:${author}` : ''}`)}`],
    ['OverDrive / Libby', `https://www.overdrive.com/search?q=${q(`${title} ${author}`.trim())}`],
    ['Open Library', `https://openlibrary.org/search?title=${q(title)}${author ? `&author=${q(author)}` : ''}`],
  ];
  for (const [label, href] of links) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(a);
  }
  return box;
}

// Goodreads is a React app; it can re-render the button column or move to another book
// without a full page load. Re-add the box whenever it is missing or out of date.
function ensure() {
  const actions = document.querySelector('.BookPage__leftColumn .BookActions');
  const titleEl = document.querySelector('h1[data-testid="bookTitle"]');
  if (!actions || !titleEl) return;
  const existing = document.querySelector('.um-library-links');
  if (existing && existing.previousElementSibling === actions && existing.dataset.umTitle === titleEl.textContent) return;
  if (existing) existing.remove();
  const box = buildLinks();
  if (box) actions.after(box);
}

ensure();
new MutationObserver(ensure).observe(document.body, { childList: true, subtree: true });
