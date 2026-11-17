// ==UserScript==
// @name         Hide the Wayback Machine toolbar
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the Wayback Machine toolbar at the top of archived pages so the snapshot fills the window.
// @match        https://web.archive.org/web/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/archive/hide-wayback-toolbar.user.js
// @updateURL    https://usermods.kennethballenegger.com/archive/hide-wayback-toolbar.user.js
// ==/UserScript==

// The Wayback Machine inserts its toolbar as #wm-ipp-base at the top of every snapshot,
// and #wm-ipp-print holds the notice it prints instead. Hiding both also removes the
// space the toolbar takes up above the archived page.
GM_addStyle('#wm-ipp-base, #wm-ipp-print { display: none !important; }');
