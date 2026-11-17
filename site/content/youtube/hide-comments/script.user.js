// ==UserScript==
// @name         Hide YouTube comments
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the comments section under YouTube videos.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/hide-comments.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/hide-comments.user.js
// ==/UserScript==

// CSS only. YouTube serves two watch-page layouts. In the classic one, ytd-comments#comments
// is the whole section under the video: the count, the sort menu, the comment box and the
// threads. In the newer one, comments open in a side panel with target-id
// "engagement-panel-comments-section". Both are hidden; the description and the
// recommended videos stay.
GM_addStyle(`
  ytd-comments#comments,
  ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"] {
    display: none !important;
  }
`);
