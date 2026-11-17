// ==UserScript==
// @name         Hide sponsored products on Amazon
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides sponsored products, sponsored brand banners and sponsored carousels in Amazon search results.
// @match        https://www.amazon.com/s?*
// @match        https://www.amazon.com/s/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/amazon/hide-sponsored.user.js
// @updateURL    https://usermods.kennethballenegger.com/amazon/hide-sponsored.user.js
// ==/UserScript==

// Amazon marks every ad slot in search results with the AdHolder class, and every sponsored
// product carries a "Sponsored" label (puis-sponsored-label-text). The rules hide any result
// slot that is an ad or holds a sponsored label, so organic results stay where they are.
// Injected CSS also covers results Amazon swaps in when you change filters or pages.
GM_addStyle(`
  .s-result-item.AdHolder,
  .s-result-item:has(.puis-sponsored-label-text),
  .s-result-item:has([aria-label="View Sponsored information or leave ad feedback"]) {
    display: none !important;
  }
`);
