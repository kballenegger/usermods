// ==UserScript==
// @name         Sort markdown tables on GitHub
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Click a column header in a rendered markdown table on GitHub to sort the table by that column; click again to reverse.
// @match        https://github.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/github/sort-tables.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/sort-tables.user.js
// ==/UserScript==

GM_addStyle(`
  .markdown-body table th { cursor: pointer; user-select: none; }
  .markdown-body table th:hover { text-decoration: underline; }
  .markdown-body table th[aria-sort="ascending"]::after { content: " \\25B2"; font-size: 0.75em; }
  .markdown-body table th[aria-sort="descending"]::after { content: " \\25BC"; font-size: 0.75em; }
`);

// Numbers inside text compare as numbers ("9.x" before "10.x"), and dates in ISO form sort
// as text. Empty cells and "-" stay at the bottom in both directions.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isEmpty = (s) => s === '' || s === '-' || s === '—';

function sortBy(th) {
  const table = th.closest('table');
  const body = table.tBodies[0];
  if (!body) return;
  const col = [...th.parentElement.children].indexOf(th);
  const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
  for (const other of th.parentElement.children) other.removeAttribute('aria-sort');
  th.setAttribute('aria-sort', dir);
  const sign = dir === 'ascending' ? 1 : -1;
  const key = (row) => (row.cells[col]?.textContent || '').trim();
  const rows = [...body.rows];
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (isEmpty(x) || isEmpty(y)) return isEmpty(x) - isEmpty(y);
    return sign * collator.compare(x, y);
  });
  body.append(...rows);
}

// One listener on the document covers every table, including ones GitHub renders later or
// swaps in when you navigate. Clicks on links inside a header still follow the link.
document.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  const th = event.target.closest('.markdown-body table thead th');
  if (th) sortBy(th);
});
