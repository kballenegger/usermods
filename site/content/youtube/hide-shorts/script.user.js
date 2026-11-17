// ==UserScript==
// @name         Hide YouTube Shorts
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides Shorts shelves, Shorts in search results and feeds, and the Shorts entry in the sidebar on YouTube desktop.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/hide-shorts.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/hide-shorts.user.js
// ==/UserScript==

// CSS only, injected before the page renders, so Shorts never flash on screen and
// YouTube's in-page navigation needs no extra handling.
GM_addStyle(`
  /* Shorts shelves on search, home and subscriptions */
  grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
  ytd-reel-shelf-renderer,
  ytd-rich-shelf-renderer[is-shorts],
  ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
  /* Single Shorts mixed into results, feeds and the watch-page sidebar */
  ytd-video-renderer:has(a[href^="/shorts/"]),
  ytd-rich-item-renderer:has(a[href^="/shorts/"]),
  ytd-grid-video-renderer:has(a[href^="/shorts/"]),
  ytd-compact-video-renderer:has(a[href^="/shorts/"]),
  ytm-shorts-lockup-view-model,
  /* The Shorts entry in the left sidebar and the collapsed sidebar */
  ytd-guide-entry-renderer:has(a[title="Shorts"]),
  ytd-mini-guide-entry-renderer[aria-label="Shorts"],
  /* The Shorts tab on channel pages */
  yt-tab-shape[tab-title="Shorts"] {
    display: none !important;
  }
`);
