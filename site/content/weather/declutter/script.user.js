// ==UserScript==
// @name         Remove ads and clutter from weather.com
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides ad slots, news, trending and sponsored blocks on weather.com forecast pages, leaving the forecast.
// @match        https://weather.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/weather/declutter.user.js
// @updateURL    https://usermods.kennethballenegger.com/weather/declutter.user.js
// ==/UserScript==

// weather.com labels its blocks with aria-label: every ad slot is a
// <section aria-label="Advertisement">, and the news blocks are "Your News", "Trending Now"
// and "Editor's Pick". The sponsored block at the bottom is a Taboola widget with no label,
// so it is found by Taboola's .thumbBlock tiles inside it.
GM_addStyle(`
  section[aria-label="Advertisement"],
  section[aria-label="Your News"],
  section[aria-label="Trending Now"],
  section[aria-label="Editor's Pick"],
  section:has(.thumbBlock, [id^="taboola"]) {
    display: none !important;
  }

  /* The right-hand column holds only ads and Editor's Pick. Drop it and let the forecast
     column take a readable width in the middle of the page. */
  main .grid > [style*="grid-area:sidebar"] { display: none !important; }
  main .grid:has(> [style*="grid-area:sidebar"]) {
    grid-template-columns: minmax(0, 1fr) !important;
    grid-template-areas: "contentTop" "main" "contentBottom" !important;
    max-width: 860px !important;
  }
`);
