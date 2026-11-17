// ==UserScript==
// @name         Expand all Reddit comments
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Loads every "more replies" and "View more comments" block on a Reddit post so the whole thread is on the page.
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/reddit/expand-threads.user.js
// @updateURL    https://usermods.kennethballenegger.com/reddit/expand-threads.user.js
// ==/UserScript==

(() => {
  // Each "N more replies" and "View more comments" control is a <faceplate-partial> whose src
  // points at Reddit's more-comments endpoint. Clicking its button makes Reddit fetch and insert
  // the hidden comments, exactly as a manual click would. Newly inserted comments can carry their
  // own "more replies" controls, so the observer keeps going until none are left.
  const clicked = new WeakSet();

  function expand() {
    if (!location.pathname.includes('/comments/')) return;
    for (const partial of document.querySelectorAll('faceplate-partial[src*="/more-comments/"]')) {
      if (clicked.has(partial)) continue;
      const button = partial.querySelector('button');
      if (!button) continue;
      clicked.add(partial);
      button.click();
    }
  }

  // Batch DOM changes into one pass per animation frame.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      expand();
    });
  }).observe(document, { childList: true, subtree: true });
})();
