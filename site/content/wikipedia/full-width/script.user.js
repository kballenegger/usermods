// ==UserScript==
// @name         Make Wikipedia full width
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Switches Wikipedia's Vector 2022 layout to Wide and moves the contents and appearance side panels into their menus, so the article fills the window.
// @match        https://*.wikipedia.org/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/wikipedia/full-width.user.js
// @updateURL    https://usermods.kennethballenegger.com/wikipedia/full-width.user.js
// ==/UserScript==

(() => {
  // Vector 2022 reads its layout from classes on <html>. Each pair below is the
  // site's own setting: Width "Wide", the contents panel unpinned (it moves to a
  // button next to the title) and the appearance panel unpinned (it moves to the
  // Appearance menu at the top). Pinning a panel again with its "move to sidebar"
  // button lasts until the next page.
  const SWAP = [
    ['vector-feature-limited-width-clientpref-1', 'vector-feature-limited-width-clientpref-0'],
    ['vector-feature-toc-pinned-clientpref-1', 'vector-feature-toc-pinned-clientpref-0'],
    ['vector-feature-appearance-pinned-clientpref-1', 'vector-feature-appearance-pinned-clientpref-0'],
  ];
  const root = document.documentElement;
  const apply = () => {
    for (const [from, to] of SWAP) {
      if (root.classList.contains(from)) root.classList.replace(from, to);
    }
  };
  apply();
  // Wikipedia's startup code rewrites these classes from saved preferences while the
  // page loads, so apply again when the class list changes during loading.
  const observer = new MutationObserver(apply);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('load', () => observer.disconnect());
})();
