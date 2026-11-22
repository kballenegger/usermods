// ==UserScript==
// @name         Hide the "Includes paid promotion" label on YouTube
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the "Includes paid promotion" notice that YouTube shows over the player at the start of sponsored videos.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/hide-paid-promotion.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/hide-paid-promotion.user.js
// ==/UserScript==

// The notice lives in the player in .ytp-paid-content-overlay and shows for about five
// seconds when a sponsored video starts. One CSS rule keeps it hidden. The sponsorship
// itself, inside the video, is untouched.
GM_addStyle('.ytp-paid-content-overlay { display: none !important; }');
