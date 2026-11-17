// ==UserScript==
// @name         Hide member-only stories on Medium
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides story previews marked "Member-only story" from Medium's tag pages, search results and other story lists.
// @match        https://medium.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/medium/hide-member-only.user.js
// @updateURL    https://usermods.kennethballenegger.com/medium/hide-member-only.user.js
// ==/UserScript==

// Each story in a Medium list is an <article data-testid="post-preview">. Paywalled ones
// carry a star button labelled "Member-only story". One CSS rule hides every preview that
// contains that button, including previews added later as you scroll.
GM_addStyle(`
  article[data-testid="post-preview"]:has(button[aria-label="Member-only story"]) {
    display: none !important;
  }
`);
