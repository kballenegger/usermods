// ==UserScript==
// @name         Wider Goodreads pages
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Lets Goodreads book pages use the full width of the window and stops the description from wrapping at a narrow column.
// @match        https://www.goodreads.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/goodreads/wide-layout.user.js
// @updateURL    https://usermods.kennethballenegger.com/goodreads/wide-layout.user.js
// ==/UserScript==

// Goodreads' newer pages (book pages and others built on .PageFrame) sit in a centred frame
// capped at 1260px and a percentage of the window. Inside it, the description and other
// paragraphs only use 7 of the 9 grid columns of the right-hand side.
// Older pages (lists, series, shelves) use a different fixed-width layout and are left alone.
GM_addStyle(`
  .PageFrame {
    width: auto !important;
    max-width: none !important;
    margin-left: 24px !important;
    margin-right: 24px !important;
  }
  .DetailsLayoutRightParagraph__widthConstrained { grid-column: 1 / -1 !important; }
`);
