// ==UserScript==
// @name         Hide the sidebars on DEV
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the left and right sidebars on dev.to and lets the feed or article use the freed width.
// @match        https://dev.to/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/devto/hide-sidebars.user.js
// @updateURL    https://usermods.kennethballenegger.com/devto/hide-sidebars.user.js
// ==/UserScript==

// DEV lays every page out on a grid (.crayons-layout) with the sidebars as named children.
// Hiding them and collapsing the grid to one column centres the main content. The article's
// own reaction and bookmark buttons live in the left sidebar on wide screens, so they go too;
// the comment section below the article stays.
GM_addStyle(`
  .crayons-layout__sidebar-left,
  .crayons-layout__sidebar-right { display: none !important; }
  .crayons-layout {
    grid-template-columns: minmax(0, 1fr) !important;
    max-width: 960px !important;
  }
`);
