// ==UserScript==
// @name         Dark mode for DuckDuckGo
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Switches DuckDuckGo to its own dark theme on every visit, even after cookies are cleared or in a private window.
// @match        https://duckduckgo.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/duckduckgo/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/duckduckgo/dark-mode.user.js
// ==/UserScript==

// DuckDuckGo keeps its theme in the "ae" cookie ("d" is Dark) and its page code reads that
// cookie when it starts. Setting it before that code runs gives the dark theme on the first
// load, with no reload. This replaces any other theme picked in Settings.
if (!/(?:^|;\s*)ae=d(?:;|$)/.test(document.cookie)) {
  document.cookie = 'ae=d; path=/; max-age=31536000; secure; samesite=lax';
}
