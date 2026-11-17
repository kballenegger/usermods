// ==UserScript==
// @name         Hide the Twitch sidebar
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Removes Twitch's left sidebar of live and recommended channels and gives its space to the page.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/twitch/hide-sidebar.user.js
// @updateURL    https://usermods.kennethballenegger.com/twitch/hide-sidebar.user.js
// ==/UserScript==

// Twitch marks the sidebar with data-a-target="side-nav-bar". Its wrapper is a flex item
// next to the main column, so hiding the wrapper (not just the bar) lets the main column
// take the full width instead of leaving an empty strip.
GM_addStyle(`
  div:has(> [data-a-target="side-nav-bar"]) { display: none !important; }
`);
