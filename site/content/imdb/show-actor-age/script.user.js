// ==UserScript==
// @name         Show actors' ages on IMDb
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  On IMDb name pages, shows how old the person was in the year of each credit, worked out from their birth date.
// @match        https://www.imdb.com/name/*
// @match        https://m.imdb.com/name/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/imdb/show-actor-age.user.js
// @updateURL    https://usermods.kennethballenegger.com/imdb/show-actor-age.user.js
// ==/UserScript==

GM_addStyle(`
  .usermods-age { margin-left: 0.4em; opacity: 0.75; white-space: nowrap; }
`);

(() => {
  // IMDb gives only a year for each credit, so the age is a range: the person
  // turned (year - birth year) at some point that year.
  const label = (year, born) => {
    const age = year - born;
    return age > 0 ? `(age ${age - 1}–${age})` : null;
  };

  const birthYear = () => {
    const el = document.querySelector('[data-testid="birth-and-death-birthdate"]');
    const m = el && el.textContent.match(/\b(\d{4})\b/);
    return m ? Number(m[1]) : null;
  };

  // Year labels: the "Known for" cards and each row of the filmography list.
  // A range like "2023–2026" (a TV series) uses its first year.
  const YEARS = [
    '[data-testid^="nm-flmg-title-year-"]',
    'li[data-testid^="cred_"] .ipc-metadata-list-summary-item__ctl > li > span',
    'li[data-testid^="cred_"] span.ipc-metadata-list-summary-item__li',
  ].join(',');

  const update = () => {
    const born = birthYear();
    if (!born) return;
    for (const el of document.querySelectorAll(YEARS)) {
      if (el.querySelector('.usermods-age')) continue;
      const m = el.textContent.trim().match(/^(\d{4})/);
      if (!m) continue;
      const text = label(Number(m[1]), born);
      if (!text) continue;
      const span = document.createElement('span');
      span.className = 'usermods-age';
      span.textContent = text;
      el.append(span);
    }
  };

  // The filmography renders in parts and grows when you expand a section or
  // change the sort, so run again after the page changes.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }).observe(document.body, { childList: true, subtree: true });
  update();
})();
