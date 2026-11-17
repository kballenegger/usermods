// ==UserScript==
// @name         Hide YouTube recommendations
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the recommended videos beside and below a YouTube video and the suggestion grid at its end.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/hide-recommendations.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/hide-recommendations.user.js
// ==/UserScript==

// CSS only, injected before the page renders, so recommendations never flash on screen and
// YouTube's in-page navigation needs no extra handling.
GM_addStyle(`
  /* The "Up next" list beside the video, or below it in a narrow window. Playlist and
     live chat panels live elsewhere in the sidebar and stay. */
  ytd-watch-next-secondary-results-renderer,
  /* The grid of suggested videos when a video ends, and in the paused full-screen player */
  .ytp-endscreen-content,
  .ytp-fullscreen-grid-stills-container {
    display: none !important;
  }
`);
