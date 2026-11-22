// ==UserScript==
// @name         Hide the Stack Overflow cookie banner
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the cookie consent banner in the bottom corner of Stack Overflow pages without clicking any of its buttons.
// @match        https://stackoverflow.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/stackoverflow/hide-cookie-banner.user.js
// @updateURL    https://usermods.kennethballenegger.com/stackoverflow/hide-cookie-banner.user.js
// ==/UserScript==

// Stack Overflow's cookie banner is a OneTrust banner with a fixed id. Only the banner is
// hidden: the "Cookie Settings" link in the footer still opens the full settings panel
// (#onetrust-pc-sdk), so you can make a choice whenever you want to.
GM_addStyle('#onetrust-banner-sdk { display: none !important; }');
