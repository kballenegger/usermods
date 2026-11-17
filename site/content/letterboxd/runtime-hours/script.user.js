// ==UserScript==
// @name         Show Letterboxd runtimes in hours and minutes
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds hours and minutes next to the runtime on Letterboxd film pages, so "133 mins" reads "133 mins (2h 13m)".
// @match        https://letterboxd.com/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/letterboxd/runtime-hours.user.js
// @updateURL    https://usermods.kennethballenegger.com/letterboxd/runtime-hours.user.js
// ==/UserScript==

// The runtime is the first text in the film page's footer line, before the IMDb and TMDB
// links: "133 mins". It is in the page HTML, so one pass after the document is parsed is enough.
for (const footer of document.querySelectorAll('p.text-footer')) {
  const node = footer.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) continue;
  node.textContent = node.textContent.replace(/(\d+)\s*mins?\b(?!\s*\()/, (all, n) => {
    const mins = Number(n);
    if (mins < 60) return all;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${all} (${h}h${m ? ` ${m}m` : ''})`;
  });
}
