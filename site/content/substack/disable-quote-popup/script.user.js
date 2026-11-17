// ==UserScript==
// @name         Stop the Substack text-selection quote popup
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the Share/Restack popup that appears over Substack posts when you select text.
// @match        https://*.substack.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/substack/disable-quote-popup.user.js
// @updateURL    https://usermods.kennethballenegger.com/substack/disable-quote-popup.user.js
// ==/UserScript==

// When you select text in a post, Substack adds a small floating box (class popover-<hash>)
// inside .available-content with a Share button that turns the selection into a quote card.
// The hash part of the class changes between builds, so match the prefix and the share icon.
// Selecting and copying text keeps working; only the floating box is hidden.
GM_addStyle(`
  .available-content [class*="popover-"]:has(svg.lucide-share) { display: none !important; }
`);
