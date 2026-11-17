// ==UserScript==
// @name         Turn off SafeSearch on DuckDuckGo for good
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds kp=-2 (SafeSearch off) to DuckDuckGo searches that don't already choose a SafeSearch level.
// @match        https://duckduckgo.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/duckduckgo/disable-safe-search.user.js
// @updateURL    https://usermods.kennethballenegger.com/duckduckgo/disable-safe-search.user.js
// ==/UserScript==

// DuckDuckGo reads the SafeSearch level from the kp URL parameter before its cookie:
// kp=1 strict, kp=-1 moderate, kp=-2 off. When a search has no kp, the script reloads it
// with kp=-2 before the page draws. A search that already carries kp (for example after
// you pick Strict in the SafeSearch menu) is left as it is.
const url = new URL(location.href);
if (url.searchParams.has('q') && !url.searchParams.has('kp')) {
  url.searchParams.set('kp', '-2');
  location.replace(url.href);
}
