// ==UserScript==
// @name         Show exact dates on Hacker News
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Replaces "3 hours ago" on Hacker News stories and comments with the exact date and time in your time zone.
// @match        https://news.ycombinator.com/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/absolute-dates.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/absolute-dates.user.js
// ==/UserScript==

// Every story and comment time is a <span class="age"> whose title holds the UTC time,
// "2026-11-17T03:39:26", sometimes followed by a space and a Unix timestamp. The link inside
// shows the relative text. The script swaps the link text for the local date and time and
// keeps the relative text as the tooltip.
const pad = (n) => String(n).padStart(2, '0');

for (const age of document.querySelectorAll('span.age[title]')) {
  const link = age.querySelector('a');
  const iso = age.title.split(' ')[0];
  const when = new Date(iso + 'Z');
  if (!link || Number.isNaN(when.getTime())) continue;
  const text = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  link.title = link.textContent;
  link.textContent = text;
}
