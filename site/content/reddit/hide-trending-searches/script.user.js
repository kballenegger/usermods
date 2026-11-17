// ==UserScript==
// @name         Hide trending searches on Reddit
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the "Trending" and "Trending Communities" lists that open under Reddit's search box.
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/reddit/hide-trending-searches.user.js
// @updateURL    https://usermods.kennethballenegger.com/reddit/hide-trending-searches.user.js
// ==/UserScript==

(() => {
  // The search box is a <reddit-search-large> element whose dropdown lives in its shadow root,
  // where page-level CSS can't reach. The trending lists are rendered into
  // ul#reddit-trending-searches-partial-container under a heading whose id ends in
  // "trending_query". The rule only matches while that heading is present, so the list Reddit
  // shows once you start typing is left alone.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    #reddit-trending-searches-partial-container:has([id*="trending_query"]) {
      display: none !important;
    }
  `);

  const patch = () => {
    const root = document.querySelector('reddit-search-large')?.shadowRoot;
    if (root && !root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
  };

  // The search element is created after this script starts and again after in-page navigation.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      patch();
    });
  }).observe(document, { childList: true, subtree: true });
})();
