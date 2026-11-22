// ==UserScript==
// @name         Remove the Reddit sidebar
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Removes the right-hand sidebar on Reddit and lets posts and comments use the freed width.
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/reddit/remove-sidebar.user.js
// @updateURL    https://usermods.kennethballenegger.com/reddit/remove-sidebar.user.js
// ==/UserScript==

// Reddit lays the feed and the sidebar out as a two-column grid with fixed widths.
// Hiding the sidebar alone leaves an empty column, so the grid becomes one column too.
GM_addStyle(`
  #right-sidebar-container {
    display: none !important;
  }
  .main-container:has(> #right-sidebar-container) {
    grid-template-columns: minmax(0, 1fr) !important;
  }
`);
