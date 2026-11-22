// ==UserScript==
// @name         Show full video titles on YouTube
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Shows the whole title of every video in YouTube's lists instead of cutting it off after two lines.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/show-full-titles.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/show-full-titles.user.js
// ==/UserScript==

// YouTube cuts titles in its video lists to two lines with -webkit-line-clamp and a
// fixed max-height, ending them with "...". These rules lift both limits so the full
// title wraps onto as many lines as it needs. They cover search results
// (ytd-video-renderer), the home grid and the list beside a video (the newer
// yt-lockup-view-model cards), and grid items on channel pages.
GM_addStyle(`
  ytd-video-renderer #video-title,
  ytd-rich-grid-media #video-title,
  ytd-grid-video-renderer #video-title,
  ytd-compact-video-renderer #video-title,
  yt-lockup-view-model .ytLockupMetadataViewModelTitle,
  yt-lockup-view-model .ytLockupMetadataViewModelTitle span {
    -webkit-line-clamp: unset !important;
    line-clamp: unset !important;
    max-height: none !important;
    overflow: visible !important;
  }
`);
