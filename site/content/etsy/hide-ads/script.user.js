// ==UserScript==
// @name         Hide ads in Etsy search results
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the listings marked "Ad" in Etsy search results and leaves the rest of the grid in place.
// @match        https://www.etsy.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/etsy/hide-ads.user.js
// @updateURL    https://usermods.kennethballenegger.com/etsy/hide-ads.user.js
// ==/UserScript==

// In Etsy's search grid every listing is an <li>. A paid listing's title has an id that
// starts with "ad-listing-title-" (ordinary ones start with "listing-title-"), and its card
// reads "Ad · By <shop>". Hiding the whole <li> lets the next listings move up into the gap.
GM_addStyle(`
  li:has(h3[id^="ad-listing-title-"]) { display: none !important; }
`);
