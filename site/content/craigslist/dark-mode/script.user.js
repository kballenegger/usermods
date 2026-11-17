// ==UserScript==
// @name         Use dark mode on Craigslist
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Gives Craigslist a dark background with light text while keeping listing photos as they are.
// @match        https://*.craigslist.org/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/craigslist/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/craigslist/dark-mode.user.js
// ==/UserScript==

// Craigslist has no dark theme and its pages are mostly white boxes, so the script inverts
// the whole page and turns the hues back by 180 degrees: white becomes near black, dark text
// becomes light, and link blue and price green stay blue and green. Photos and map tiles are
// inverted a second time so they look as they should. The off-white base keeps the result
// from being pure black.
GM_addStyle(`
  html { filter: invert(0.92) hue-rotate(180deg) !important; background: #fff !important; color-scheme: light !important; }
  img, video, picture, canvas, iframe, [style*="background-image"] {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  picture img, [style*="background-image"] img { filter: none !important; }
`);
