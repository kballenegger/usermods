// ==UserScript==
// @name         Remove ads from DuckDuckGo results
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Hides the sponsored results and sponsored shopping rows DuckDuckGo shows among the web results.
// @match        https://duckduckgo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/duckduckgo/remove-ads.user.js
// @updateURL    https://usermods.kennethballenegger.com/duckduckgo/remove-ads.user.js
// ==/UserScript==

// DuckDuckGo marks each sponsored result in the list with data-layout="ad" and wraps it in an
// element with data-testid="ad". Both are hidden, so an ad is caught if either marker is there.
// The "Shopping for ..." product rows are ads too; they carry an Ad badge whose test id starts
// with ad-badge-ad-tooltip-products, and the list item holding one is hidden. The rule is CSS, so it also covers ads loaded with "More results" and new searches.
GM_addStyle(`
  li[data-layout="ad"],
  li:has(> [data-testid="ad"]),
  li:has([data-testid^="ad-badge-ad-tooltip-products"]) {
    display: none !important;
  }
`);
