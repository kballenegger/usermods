// ==UserScript==
// @name         Dark mode for Goodreads
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Turns Goodreads dark by inverting the page colours, while keeping book covers, photos and avatars as they are.
// @match        https://www.goodreads.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/goodreads/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/goodreads/dark-mode.user.js
// ==/UserScript==

// Goodreads has two page designs (the newer book pages and the older list, series and shelf
// pages) with separate stylesheets. Rather than recolour each one, this inverts the whole
// page and rotates the hues back, so white turns black and Goodreads' green and orange
// stay roughly the same colour. Covers, photos and other pictures are inverted a second time
// so they look normal.
GM_addStyle(`
  html {
    filter: invert(1) hue-rotate(180deg) !important;
    background: #fff !important;
  }
  :is(img, video, canvas, picture, iframe, svg image, [style*="background-image"]) {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  /* Don't flip an image twice when its container was already flipped back. */
  :is(picture, [style*="background-image"]) img { filter: none !important; }
`);
