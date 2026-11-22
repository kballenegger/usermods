// ==UserScript==
// @name         Remove clutter from Fandom wikis
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides Fandom's ad slots, autoplay video, right rail, left Fandom bar, pop-up notices and recommendation footer, and lets the article use the freed width.
// @match        https://*.fandom.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/fandom/remove-clutter.user.js
// @updateURL    https://usermods.kennethballenegger.com/fandom/remove-clutter.user.js
// ==/UserScript==

GM_addStyle(`
  /* Ad slots: the leaderboard above the wiki header, in-article and bottom slots,
     and the sticky ad at the bottom of the window. */
  .top-ads-container,
  .bottom-ads-container,
  [id$="_leaderboard"],
  [id^="incontent_"],
  [id^="floor_adhesion"],
  .ad-slot-placeholder,

  /* The video player Fandom places at the top of articles. */
  #featured-video__player-container,
  .featured-video__wrapper,

  /* Right rail: promotions, "Popular pages", more ads. */
  .page__right-rail,

  /* The Fandom-wide bar on the left (Home, Explore, Fandom Four...). */
  #global-explore-navigation,

  /* "Welcome to the wiki" and other pop-up notices, and the "Fan Feed"
     recommendation grid under the article. */
  .notifications-placeholder,
  #mixed-content-footer,
  .mcf-wrapper {
    display: none !important;
  }

  /* With the left bar gone, centre the page instead of leaving room for it. */
  .main-container {
    margin-left: auto !important;
    margin-right: auto !important;
  }
`);
