// ==UserScript==
// @name         Dark mode for Wiktionary
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Turns on Wiktionary's own dark theme on every page, logged out, without relying on saved site data.
// @match        https://*.wiktionary.org/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/wiktionary/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/wiktionary/dark-mode.user.js
// ==/UserScript==

(() => {
  // MediaWiki skins pick their colours from a class on <html>:
  // skin-theme-clientpref-day, -night or -os. Switching it to -night uses
  // Wiktionary's own dark palette, so tables and templates stay readable.
  const root = document.documentElement;
  const force = () => {
    if (root.classList.contains('skin-theme-clientpref-night')) return;
    root.classList.remove('skin-theme-clientpref-day', 'skin-theme-clientpref-os');
    root.classList.add('skin-theme-clientpref-night');
  };
  force();
  // The site's startup code rewrites the class from the saved preference as the
  // page loads, so put night back whenever the class changes.
  new MutationObserver(force).observe(root, { attributes: true, attributeFilter: ['class'] });
})();
