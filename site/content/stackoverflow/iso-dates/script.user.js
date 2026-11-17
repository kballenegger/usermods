// ==UserScript==
// @name         Show exact dates on Stack Overflow
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Replaces "14 years ago" and "Jun 27, 2012 at 13:51" on Stack Overflow with exact ISO dates and times such as 2012-06-27 13:51 UTC.
// @match        https://stackoverflow.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/stackoverflow/iso-dates.user.js
// @updateURL    https://usermods.kennethballenegger.com/stackoverflow/iso-dates.user.js
// ==/UserScript==

// Every date on a question page carries the exact UTC time in its title or datetime
// attribute ("2012-06-27 13:51:36Z", sometimes followed by ", License: ..."). The script
// rewrites the visible text of those elements to "2012-06-27 13:51 UTC". It only touches
// elements with no child elements, so links and icons around a date are left as they are.
const STAMP = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d):\d\dZ/;

function rewrite() {
  for (const el of document.querySelectorAll('[title], time[datetime]')) {
    if (el.children.length) continue;
    const m = STAMP.exec(el.getAttribute('datetime') || el.getAttribute('title') || '');
    if (!m) continue;
    const text = `${m[1]} ${m[2]} UTC`;
    if (el.textContent !== text) el.textContent = text;
  }
}

// Comments and answers can load after the page (for example "Show more comments"), and the
// site refreshes relative times now and then, so the dates are rewritten on every change.
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; rewrite(); });
}).observe(document, { childList: true, subtree: true, characterData: true });
