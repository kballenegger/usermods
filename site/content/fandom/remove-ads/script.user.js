// ==UserScript==
// @name         Remove ads from Fandom wikis
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the ad slots and the autoplay video player on Fandom wikis and leaves the rest of the page as it is.
// @match        https://*.fandom.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/fandom/remove-ads.user.js
// @updateURL    https://usermods.kennethballenegger.com/fandom/remove-ads.user.js
// ==/UserScript==

GM_addStyle(`
  /* The leaderboard above the wiki header and the slot at the bottom of the page. */
  .top-ads-container,
  .bottom-ads-container,
  /* Individual slots: leaderboards, in-article boxes, the right-rail boxes and the
     sticky slot at the bottom of the window. Fandom names them by position. */
  [id$="_leaderboard"],
  [id^="incontent_"],
  [id$="_boxad"],
  [id^="floor_adhesion"],
  .ad-slot-placeholder,
  /* The video player at the top of articles, which plays video ads. */
  #featured-video__player-container,
  .featured-video__wrapper {
    display: none !important;
  }
`);
