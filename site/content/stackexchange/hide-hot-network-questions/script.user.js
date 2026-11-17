// ==UserScript==
// @name         Hide Hot Network Questions on Stack Exchange
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the Hot Network Questions list in the sidebar on Stack Exchange sites, Super User, Server Fault, Ask Ubuntu and MathOverflow.
// @match        https://*.stackexchange.com/*
// @match        https://superuser.com/*
// @match        https://serverfault.com/*
// @match        https://askubuntu.com/*
// @match        https://mathoverflow.net/*
// @match        https://*.mathoverflow.net/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/stackexchange/hide-hot-network-questions.user.js
// @updateURL    https://usermods.kennethballenegger.com/stackexchange/hide-hot-network-questions.user.js
// ==/UserScript==

// Every site on the network renders the list with the same id. Linked and Related questions
// sit in separate sidebar modules and stay visible.
GM_addStyle('#hot-network-questions { display: none !important; }');
