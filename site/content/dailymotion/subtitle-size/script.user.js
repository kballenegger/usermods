// ==UserScript==
// @name         Make Dailymotion subtitles bigger
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Makes subtitles in the Dailymotion player larger. Change SCALE to pick the size.
// @match        https://geo.dailymotion.com/player/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/dailymotion/subtitle-size.user.js
// @updateURL    https://usermods.kennethballenegger.com/dailymotion/subtitle-size.user.js
// ==/UserScript==

// 1.6 makes subtitles 60% bigger than Dailymotion's default. 2 doubles them.
const SCALE = 1.6;

// The player runs in its own frame on geo.dailymotion.com, both on dailymotion.com and on
// sites that embed it, so the script matches that frame. The player sets the size in a CSS
// variable on .subtitles_placeholder; the rule scales whatever size it picked.
GM_addStyle(`
  .subtitles_placeholder > div {
    font-size: calc(var(--subtitle-font-size, 1.5rem) * ${SCALE}) !important;
    line-height: 1.25 !important;
  }
`);
