// ==UserScript==
// @name         Show more videos per row on YouTube
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Shows 5 videos per row on the YouTube home page, subscriptions and channel video grids instead of 3 or 4. Change PER_ROW to pick another number.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/more-videos-per-row.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/more-videos-per-row.user.js
// ==/UserScript==

// How many videos to show in each row of the grid.
const PER_ROW = 5;

// YouTube sizes each video in its grids from CSS variables it writes into the grid's inline
// style as the window resizes, with a minimum card width that caps a 1366 px window at 3
// per row. An !important rule beats an inline style without one, so these values win.
// Shorts and posts shelves inside the grid have their own sizes and are left alone.
GM_addStyle(`
  ytd-rich-grid-renderer {
    --ytd-rich-grid-items-per-row: ${PER_ROW} !important;
    --ytd-rich-grid-item-min-width: 0px !important;
  }
  ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer {
    width: calc(100% / ${PER_ROW} - var(--ytd-rich-grid-item-margin)) !important;
    min-width: 0 !important;
  }
`);
