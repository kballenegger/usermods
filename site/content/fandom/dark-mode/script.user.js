// ==UserScript==
// @name         Keep Fandom wikis in dark mode
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Turns on Fandom's own dark theme on every wiki and keeps it on after the browser restarts.
// @match        https://*.fandom.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/fandom/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/fandom/dark-mode.user.js
// ==/UserScript==

// Fandom picks the theme on the server from a "theme" cookie on .fandom.com. Its own
// switch sets that cookie only for the browser session, so a logged-out visitor is back
// on the light theme after a restart. When no theme cookie is set, this script sets
// theme=dark for a year and reloads once so the server sends the dark page.
// If you click Fandom's switch to go back to light, its cookie replaces this one and the
// light theme stays until the browser closes.
(() => {
  if (/(?:^|;\s*)theme=/.test(document.cookie)) return;
  document.cookie = 'theme=dark; domain=.fandom.com; path=/; max-age=31536000; secure; samesite=lax';
  // Only reload if the cookie stuck, so a browser that blocks it can't loop.
  if (/(?:^|;\s*)theme=dark/.test(document.cookie)) {
    window.stop();
    location.reload();
  }
})();
