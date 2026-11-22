// ==UserScript==
// @name         Sort Goodreads lists by rating
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Adds buttons above a Goodreads list to sort the books on the page by average rating or by number of ratings.
// @match        https://www.goodreads.com/list/show/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/goodreads/sort-list-by-rating.user.js
// @updateURL    https://usermods.kennethballenegger.com/goodreads/sort-list-by-rating.user.js
// ==/UserScript==

// List pages are server-rendered tables (table.tableList), 100 books per page. Each row has
// a line with its average rating and number of ratings. The script reads those numbers and
// reorders the rows in place. It only sees the books on the current page.

GM_addStyle(`
  .um-sort-bar { margin: 8px 0 12px; font-size: 13px; }
  .um-sort-bar button { margin-right: 6px; padding: 3px 9px; border: 1px solid #ccc; border-radius: 3px; background: #f4f1ea; cursor: pointer; }
  .um-sort-bar button[aria-pressed="true"] { background: #382110; color: #fff; border-color: #382110; }
`);

const table = document.querySelector('table.tableList');
if (table) {
  const body = table.tBodies[0] || table;
  const rows = [...body.querySelectorAll(':scope > tr')];
  const info = new Map(rows.map((row, i) => {
    const text = row.querySelector('.minirating')?.textContent || '';
    const avg = parseFloat((text.match(/([\d.]+)\s+avg rating/) || [])[1]) || 0;
    const count = parseInt(((text.match(/([\d,]+)\s+ratings?/) || [])[1] || '0').replace(/,/g, ''), 10);
    return [row, { i, avg, count }];
  }));

  const sorts = {
    list: (a, b) => info.get(a).i - info.get(b).i,
    rating: (a, b) => info.get(b).avg - info.get(a).avg || info.get(b).count - info.get(a).count,
    count: (a, b) => info.get(b).count - info.get(a).count,
  };

  const bar = document.createElement('div');
  bar.className = 'um-sort-bar';
  bar.append('Sort this page: ');
  const buttons = [['list', 'List order'], ['rating', 'Average rating'], ['count', 'Number of ratings']].map(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.umSort = key;
    b.textContent = label;
    b.setAttribute('aria-pressed', String(key === 'list'));
    b.addEventListener('click', () => {
      // appendChild moves each row, so this reorders without copying anything.
      [...rows].sort(sorts[key]).forEach((row) => body.appendChild(row));
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    return b;
  });
  bar.append(...buttons);
  table.before(bar);
}
