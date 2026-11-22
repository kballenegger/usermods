// ==UserScript==
// @name         Hide Hot Network Questions on Stack Overflow
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the Hot Network Questions list in the Stack Overflow sidebar and leaves the rest of the sidebar in place.
// @match        https://stackoverflow.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/stackoverflow/hide-hot-network-questions.user.js
// @updateURL    https://usermods.kennethballenegger.com/stackoverflow/hide-hot-network-questions.user.js
// ==/UserScript==

// The list has had the same id for years. Linked and Related questions sit in separate
// modules and stay visible.
GM_addStyle('#hot-network-questions { display: none !important; }');
