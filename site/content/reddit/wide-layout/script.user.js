// ==UserScript==
// @name         Make Reddit use the full width of the screen
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Removes Reddit's fixed 1120px content width so the feed and posts grow with the window, keeping the sidebar.
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/reddit/wide-layout.user.js
// @updateURL    https://usermods.kennethballenegger.com/reddit/wide-layout.user.js
// ==/UserScript==

// Right of the left-hand menu, Reddit centres a content column that is 1120px
// wide on large screens. Inside it, the feed and the 316px sidebar sit in a grid
// whose first column has a fixed width too. Both limits go: the content column
// fills the space, and the feed column takes whatever the sidebar doesn't.
GM_addStyle(`
  #subgrid-container {
    width: 100% !important;
    max-width: none !important;
  }
  .main-container.fixed-sidebar:has(> #right-sidebar-container) {
    grid-template-columns: minmax(0, 1fr) 316px !important;
  }
`);
