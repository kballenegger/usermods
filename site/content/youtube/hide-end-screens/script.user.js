// ==UserScript==
// @name         Remove YouTube end screen cards
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the end screen cards that cover the last seconds of YouTube videos, the info card teasers, and the suggestion grid after a video ends.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/hide-end-screens.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/hide-end-screens.user.js
// ==/UserScript==

// CSS only. The player draws every end screen card (video, playlist, channel, subscribe and
// link cards) as a .ytp-ce-element, so one rule covers them all, on every video.
GM_addStyle(`
  /* End screen cards over the last 5 to 20 seconds of a video */
  #movie_player .ytp-ce-element,
  /* The "i" info card teaser that slides in during a video */
  #movie_player .ytp-cards-teaser,
  /* The grid of suggested videos after a video ends */
  #movie_player .ytp-endscreen-content {
    display: none !important;
  }
`);
