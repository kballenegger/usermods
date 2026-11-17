// ==UserScript==
// @name         Collapse Hacker News comment threads
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a "collapse all" link to Hacker News comment pages that folds every top-level thread, and toggles back to "expand all".
// @match        https://news.ycombinator.com/item*
// @run-at       document-end
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/collapse-comments.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/collapse-comments.user.js
// ==/UserScript==

(() => {
  // Each comment is a tr.athing.comtr; top-level ones have td.ind[indent="0"]. Hacker News
  // folds a thread when its [–] link (a.togg) is clicked and marks the row with class "coll".
  // The link below clicks those same toggles, so HN's own code does the folding.
  const topLevel = () =>
    [...document.querySelectorAll('tr.athing.comtr')].filter(
      (row) => row.querySelector('td.ind')?.getAttribute('indent') === '0',
    );
  const subline = document.querySelector('.fatitem .subline, .fatitem .subtext');
  if (!subline || topLevel().length === 0) return;

  const link = document.createElement('a');
  link.id = 'usermods-collapse-all';
  link.href = 'javascript:void(0)';
  link.textContent = 'collapse all';
  link.addEventListener('click', () => {
    const collapse = link.textContent === 'collapse all';
    for (const row of topLevel()) {
      // Only click threads that are not already in the wanted state.
      if (row.classList.contains('coll') !== collapse) row.querySelector('a.togg')?.click();
    }
    link.textContent = collapse ? 'expand all' : 'collapse all';
  });
  subline.append(' | ', link);
})();
