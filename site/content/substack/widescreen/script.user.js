// ==UserScript==
// @name         Make Substack posts wider
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Widens the text column of Substack posts from 728px to up to 1100px.
// @match        https://*.substack.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/substack/widescreen.user.js
// @updateURL    https://usermods.kennethballenegger.com/substack/widescreen.user.js
// ==/UserScript==

// A Substack post sits in .single-post-container > .container, which is fixed at 728px wide.
// Everything inside (header, body, images, comments) takes its width from that box, so widening
// it is enough. On narrow windows the column still fits the screen with a 32px gutter each side.
// It matches the whole publication because Substack opens posts from the home page without a
// full page load. The selector only exists on post pages, so other pages are untouched.
GM_addStyle(`
  .single-post-container > .container {
    width: min(1100px, 100vw - 64px) !important;
    max-width: none !important;
  }
`);
