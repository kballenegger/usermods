// ==UserScript==
// @name         Show only the main books in a Goodreads series
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides novellas, companions, omnibus editions and part-volumes on Goodreads series pages, leaving the numbered main books, with a button to show everything.
// @match        https://www.goodreads.com/series/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/goodreads/series-primary-works.user.js
// @updateURL    https://usermods.kennethballenegger.com/goodreads/series-primary-works.user.js
// ==/UserScript==

// Goodreads counts a book as a "primary work" when its place in the series is a whole
// number ("Book 3"). Everything else is a secondary work: "Book 2.5", "Book 1-4",
// "Book 3 part 1/2", or a book with no number at all. The series page lists both kinds.
// This script marks the secondary ones and hides them; a button next to the
// "N primary works • M total works" line switches between the two views.

GM_addStyle(`
  html:not(.um-show-all) .listWithDividers__item.um-secondary { display: none !important; }
  .um-primary-toggle { margin-left: 10px; padding: 1px 8px; font-size: 12px; border: 1px solid #ccc; border-radius: 3px; background: #f4f1ea; cursor: pointer; }
`);

const isPrimary = (item) => {
  const label = item.querySelector(':scope > h3')?.textContent.trim() || '';
  return /^Book\s+\d+$/.test(label);
};

function mark() {
  for (const item of document.querySelectorAll('.listWithDividers__item')) {
    item.classList.toggle('um-secondary', !isPrimary(item));
  }
  const subtitle = document.querySelector('.responsiveSeriesHeader__subtitle');
  if (subtitle && !subtitle.querySelector('.um-primary-toggle')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'um-primary-toggle';
    const label = () => {
      button.textContent = document.documentElement.classList.contains('um-show-all') ? 'Main books only' : 'Show all works';
    };
    button.addEventListener('click', () => {
      document.documentElement.classList.toggle('um-show-all');
      label();
    });
    label();
    subtitle.append(button);
  }
}

mark();
// The list is rendered by React and can be re-rendered or extended; re-mark on changes.
// Only class changes on items happen in mark(), and the observer ignores attributes, so it doesn't loop.
new MutationObserver(mark).observe(document.body, { childList: true, subtree: true });
