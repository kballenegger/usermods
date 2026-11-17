// ==UserScript==
// @name         Dark mode for Wikipedia
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Turns on Wikipedia's own dark theme on every page, logged out, without relying on a cookie.
// @match        https://*.wikipedia.org/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/wikipedia/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/wikipedia/dark-mode.user.js
// ==/UserScript==

(() => {
  // Wikipedia's skins pick their colours from a class on <html>:
  // skin-theme-clientpref-day, -night or -os. Switching it to -night uses the
  // site's own dark palette, so infoboxes, tables and links stay readable.
  const root = document.documentElement;
  const force = () => {
    if (root.classList.contains('skin-theme-clientpref-night')) return;
    root.classList.remove('skin-theme-clientpref-day', 'skin-theme-clientpref-os');
    root.classList.add('skin-theme-clientpref-night');
  };
  force();
  // Wikipedia's startup code rewrites the class from its saved preference as the
  // page loads, so put night back whenever the class changes.
  new MutationObserver(force).observe(root, { attributes: true, attributeFilter: ['class'] });
})();
