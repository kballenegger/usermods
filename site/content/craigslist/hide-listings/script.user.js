// ==UserScript==
// @name         Hide Craigslist listings by keyword
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Adds a box to Craigslist search pages where you list words; listings whose title contains any of them are hidden.
// @match        https://*.craigslist.org/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/craigslist/hide-listings.user.js
// @updateURL    https://usermods.kennethballenegger.com/craigslist/hide-listings.user.js
// ==/UserScript==

// Each search result is a .cl-search-result element whose title attribute holds the listing
// title, in list, gallery and thumbnail views alike. The words you type are saved in this
// browser's localStorage for craigslist.org, so they apply to every search until you change them.
(() => {
  const KEY = 'usermods-hide-words';
  const read = () => (localStorage.getItem(KEY) || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

  GM_addStyle(`
    .usermods-hidden { display: none !important; }
    #usermods-hide-box { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; padding: 8px 10px;
      background: #fff; color: #222; border: 1px solid #999; border-radius: 6px; font: 13px/1.4 sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    #usermods-hide-box input { width: 220px; margin-left: 6px; font: inherit; }
  `);

  // Recomputed from the current page on every change: Craigslist renders results as you scroll
  // and when you change the view, sort or search.
  const apply = () => {
    const words = read();
    let hidden = 0;
    for (const r of document.querySelectorAll('.cl-search-result')) {
      const title = (r.getAttribute('title') || r.textContent || '').toLowerCase();
      const hide = words.some((w) => title.includes(w));
      r.classList.toggle('usermods-hidden', hide);
      if (hide) hidden++;
    }
    // Write the count only when it changes: replacing the text node is itself a mutation the
    // observer below sees, and rewriting it every time would rerun apply() on every frame.
    const count = document.getElementById('usermods-hide-count');
    const text = hidden ? ` (${hidden} hidden)` : '';
    if (count && count.textContent !== text) count.textContent = text;
  };

  const addBox = () => {
    if (!document.querySelector('.cl-search-result, .cl-search-results-pageless, .results') || document.getElementById('usermods-hide-box')) return;
    const box = document.createElement('label');
    box.id = 'usermods-hide-box';
    box.append('Hide titles with:');
    const input = document.createElement('input');
    input.id = 'usermods-hide-words';
    input.placeholder = 'words, separated by commas';
    input.value = localStorage.getItem(KEY) || '';
    input.addEventListener('input', () => { localStorage.setItem(KEY, input.value); apply(); });
    const count = document.createElement('span');
    count.id = 'usermods-hide-count';
    box.append(input, count);
    document.body.append(box);
  };

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; addBox(); apply(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
