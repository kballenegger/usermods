// ==UserScript==
// @name         Make Wikipedia text bigger
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Always shows Wikipedia articles at the Large text size, on every language edition, without an account.
// @match        https://*.wikipedia.org/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/wikipedia/larger-font.user.js
// @updateURL    https://usermods.kennethballenegger.com/wikipedia/larger-font.user.js
// ==/UserScript==

(() => {
  // The Vector skin picks the article text size from a class on <html>:
  // vector-feature-custom-font-size-clientpref-0 (Small), -1 (Standard) or -2 (Large).
  // Switching it to -2 uses the site's own Large size for text, tables and references.
  const root = document.documentElement;
  const SIZES = ['vector-feature-custom-font-size-clientpref-0', 'vector-feature-custom-font-size-clientpref-1'];
  const LARGE = 'vector-feature-custom-font-size-clientpref-2';
  const force = () => {
    if (root.classList.contains(LARGE)) return;
    root.classList.remove(...SIZES);
    root.classList.add(LARGE);
  };
  force();
  // Wikipedia's startup code rewrites the class from its saved preference as the
  // page loads, so put Large back whenever the class changes.
  new MutationObserver(force).observe(root, { attributes: true, attributeFilter: ['class'] });
})();
