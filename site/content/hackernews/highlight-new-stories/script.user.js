// ==UserScript==
// @name         Highlight stories you have not seen on Hacker News
// @namespace    https://usermods.kennethballenegger.com
// @version      1.1.0
// @description  Marks Hacker News stories that were not on any list you loaded before, so you can skip what you have already seen.
// @match        https://news.ycombinator.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/highlight-new-stories.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/highlight-new-stories.user.js
// ==/UserScript==

// Story ids you have been shown are kept in localStorage for news.ycombinator.com, with the
// time they were last shown. Ids not shown for 30 days are dropped so the record doesn't
// grow until it hits the storage quota. Nothing leaves the browser.
const KEY = 'usermods-hn-seen';
const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

GM_addStyle(`
  tr.um-new .titleline > a { font-weight: bold; }
  tr.um-new td.title:last-child { box-shadow: inset 3px 0 0 #ff6600; padding-left: 6px; }
`);

// Story rows on every list page (front page, newest, ask, show, past) are tr.athing.submission
// with the story id as the row id. Item pages have one such row; skip them so opening a
// story doesn't count as seeing a list.
const rows = [...document.querySelectorAll('tr.athing.submission[id]')];
if (rows.length > 1) {
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(KEY)); } catch { seen = null; }
  // On the very first run every story is new, which tells you nothing; just record them.
  const firstRun = !seen;
  seen = seen || {};
  const now = Date.now();
  for (const row of rows) {
    if (!firstRun && !(row.id in seen)) row.classList.add('um-new');
    seen[row.id] = now;
  }
  for (const id of Object.keys(seen)) {
    if (now - seen[id] > FORGET_AFTER_MS) delete seen[id];
  }
  localStorage.setItem(KEY, JSON.stringify(seen));
}
