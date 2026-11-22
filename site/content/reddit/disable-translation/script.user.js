// ==UserScript==
// @name         Stop Reddit auto-translating posts
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Removes Reddit's ?tl= translation parameter from the address and from links so posts show in their original language.
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/reddit/disable-translation.user.js
// @updateURL    https://usermods.kennethballenegger.com/reddit/disable-translation.user.js
// ==/UserScript==

(() => {
  // Reddit machine-translates a page when its address carries ?tl=<language>, which is how
  // links from search engines arrive. Every link on a translated page carries the same
  // parameter, so the translation follows you from page to page.
  const withoutTl = (href) => {
    const url = new URL(href, location.href);
    if (!url.searchParams.has('tl')) return null;
    url.searchParams.delete('tl');
    return url.href;
  };

  // 1. Reload the current page without the parameter, before Reddit draws it.
  const clean = withoutTl(location.href);
  if (clean) {
    location.replace(clean);
    return;
  }

  // 2. Strip it from links as they appear, so in-page navigation stays untranslated too.
  const fixLinks = () => {
    for (const a of document.querySelectorAll('a[href*="tl="]')) {
      const href = withoutTl(a.href);
      if (href) a.href = href;
    }
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fixLinks();
    });
  }).observe(document, { childList: true, subtree: true });
})();
