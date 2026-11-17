// ==UserScript==
// @name         Hide the Stack Overflow right sidebar
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the right-hand sidebar on Stack Overflow question pages and lets the question and answers use the freed space.
// @match        https://stackoverflow.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/stackoverflow/hide-sidebar.user.js
// @updateURL    https://usermods.kennethballenegger.com/stackoverflow/hide-sidebar.user.js
// ==/UserScript==

// The right column is #sidebar (promotions, the blog, linked and related questions, Hot
// Network Questions). Once it is hidden, #mainbar is given the full width of the content
// area instead of its fixed width. The left navigation is left alone.
GM_addStyle(`
  #sidebar { display: none !important; }
  #mainbar { width: auto !important; float: none !important; }
`);
