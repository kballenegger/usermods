// ==UserScript==
// @name         Dismiss Substack subscribe popups
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Hides the full-screen subscribe popup on Substack publication home pages and lets the page scroll again.
// @match        https://*.substack.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/substack/dismiss-popups.user.js
// @updateURL    https://usermods.kennethballenegger.com/substack/dismiss-popups.user.js
// ==/UserScript==

// Logged-out visitors to a publication's home page get a full-screen "intro popup" with an
// email box. While it is up, Substack puts show-intro-popup on <html>, sets overflow: hidden on
// it and visibility: hidden on the page under the popup. Hide the popup and undo both.
GM_addStyle(`
  .intro-popup { display: none !important; }
  html.show-intro-popup { overflow: auto !important; }
  html.show-intro-popup #entry > .main { visibility: visible !important; }
`);
