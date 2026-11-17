// ==UserScript==
// @name         Reveal Reddit spoilers automatically
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Removes the blur from spoiler-tagged Reddit posts so their text and images show without clicking "View spoiler".
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/reddit/unblur-spoilers.user.js
// @updateURL    https://usermods.kennethballenegger.com/reddit/unblur-spoilers.user.js
// ==/UserScript==

(() => {
  // Reddit wraps a spoiler post's body or media in <shreddit-blurred-container reason="spoiler">.
  // The blur and the "View spoiler" button live in that element's shadow root. Pressing the
  // button is how Reddit itself reveals the content, so the script presses it for you.
  // NSFW blurs use reason="nsfw" and are left alone.
  const SELECTOR = 'shreddit-blurred-container[reason="spoiler"][blurred]';

  function reveal() {
    for (const container of document.querySelectorAll(SELECTOR)) {
      const button = container.shadowRoot?.querySelector('.overlay button');
      if (button) button.click();
    }
  }

  // The containers render after this script starts and new ones arrive as the feed scrolls,
  // so check again whenever the page changes, at most once per animation frame.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      reveal();
    });
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['blurred'] });
})();
