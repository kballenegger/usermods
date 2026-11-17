// ==UserScript==
// @name         Show the exact Letterboxd average rating
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Replaces the rounded average rating on Letterboxd film pages with the two-decimal weighted average from its tooltip.
// @match        https://letterboxd.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/letterboxd/exact-average-rating.user.js
// @updateURL    https://usermods.kennethballenegger.com/letterboxd/exact-average-rating.user.js
// ==/UserScript==

// The ratings histogram is loaded after the page, so watch for it. Its average link shows a
// rounded number ("4.5") and keeps the exact one in a tooltip: "Weighted average of 4.51
// based on 6,040,703 ratings". Letterboxd's tooltip code may move that text from title to
// data-original-title, so read both.
function showExact() {
  for (const link of document.querySelectorAll('a.averagerating')) {
    const tip = link.getAttribute('data-original-title') || link.getAttribute('title') || '';
    const m = /average of ([\d.]+)/i.exec(tip);
    if (m && link.textContent.trim() !== m[1]) link.textContent = m[1];
  }
}
new MutationObserver(showExact).observe(document, { childList: true, subtree: true });
