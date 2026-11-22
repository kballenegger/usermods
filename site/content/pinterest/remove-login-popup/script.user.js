// ==UserScript==
// @name         Remove Pinterest's login popup
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the "Welcome to Pinterest" login popup for logged-out visitors and lets the page scroll again.
// @match        https://www.pinterest.com/*
// @match        https://pinterest.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/pinterest/remove-login-popup.user.js
// @updateURL    https://usermods.kennethballenegger.com/pinterest/remove-login-popup.user.js
// ==/UserScript==

// The popup and its dark backdrop both sit inside the element Pinterest tags
// data-test-id="fullPageSignupModal". While it is open, Pinterest also adds
// `body { overflow: hidden !important }` so the page can't scroll. The second rule
// wins over that one because "html body" is more specific than "body".
GM_addStyle(`
  [data-test-id="fullPageSignupModal"] { display: none !important; }
  html body { overflow: visible !important; }
`);
