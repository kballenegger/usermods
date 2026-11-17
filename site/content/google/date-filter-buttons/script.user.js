// ==UserScript==
// @name         Add one-click date filter buttons to Google Search
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds Any time, Past hour, day, week, month and year links above Google Search results.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/date-filter-buttons.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/date-filter-buttons.user.js
// ==/UserScript==

// Google's own date filter sits behind Tools > Any time. These links load the same
// search with Google's tbs=qdr:<unit> parameter, which is what that menu sets.
const RANGES = [
  ['', 'Any time'],
  ['h', 'Past hour'],
  ['d', 'Past 24 hours'],
  ['w', 'Past week'],
  ['m', 'Past month'],
  ['y', 'Past year'],
];

GM_addStyle(`
  #usermods-date-bar { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 12px; font: 14px/20px Arial, sans-serif; }
  #usermods-date-bar a { padding: 4px 12px; border: 1px solid #dadce0; border-radius: 16px; color: inherit; text-decoration: none; }
  #usermods-date-bar a:hover { background: rgba(127, 127, 127, 0.12); }
  #usermods-date-bar a[aria-current="true"] { border-color: currentColor; font-weight: bold; }
`);

function rangeUrl(unit) {
  const url = new URL(location.href);
  url.searchParams.delete('tbs');
  url.searchParams.delete('start');
  if (unit) url.searchParams.set('tbs', 'qdr:' + unit);
  return url.pathname + url.search;
}

function addBar() {
  const results = document.getElementById('rcnt');
  const column = document.getElementById('center_col');
  if (!results || !column || document.getElementById('usermods-date-bar')) return;
  const current = new URL(location.href).searchParams.get('tbs') || '';
  const bar = document.createElement('nav');
  bar.id = 'usermods-date-bar';
  bar.setAttribute('aria-label', 'Date range');
  for (const [unit, label] of RANGES) {
    const a = document.createElement('a');
    a.href = rangeUrl(unit);
    a.textContent = label;
    a.setAttribute('aria-current', String(current === (unit ? 'qdr:' + unit : '')));
    bar.append(a);
  }
  // Line the bar up with the left edge of the results column.
  bar.style.paddingLeft = Math.max(0, column.getBoundingClientRect().left - results.parentElement.getBoundingClientRect().left) + 'px';
  results.before(bar);
}

new MutationObserver(addBar).observe(document, { childList: true, subtree: true });
