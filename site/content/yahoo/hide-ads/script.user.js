// ==UserScript==
// @name         Hide ads on Yahoo News
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the banner, sidebar and in-feed ad slots and the sponsored Taboola stories on Yahoo News and the Yahoo homepage.
// @match        https://www.yahoo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/yahoo/hide-ads.user.js
// @updateURL    https://usermods.kennethballenegger.com/yahoo/hide-ads.user.js
// ==/UserScript==

// This hides the ad slots; it does not stop the ad scripts from loading. An ad
// blocker such as uBlock Origin does that.
GM_addStyle(`
  /* The grey band under the header that holds the top banner ad. */
  .cls-ad-top-center,
  /* The right-rail ads. */
  .cls-ad-rail,
  /* Every display ad slot, wherever it sits. */
  .ad-container,
  [id^="sda-"],
  section[id*="-ad-"],
  li:has(> div > section[id*="-ad-"]),
  /* Sponsored stories from Taboola, in the feed and under articles. */
  .trc_related_container,
  li:has(> div > div.trc_related_container) {
    display: none !important;
  }
`);
