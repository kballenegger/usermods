// ==UserScript==
// @name         Hide YouTube sign-in prompts
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Hides the "Sign in to like videos" box in the YouTube side menu and the sign-in popups that open when you click Like, Dislike or Subscribe while logged out.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/hide-sign-in-prompt.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/hide-sign-in-prompt.user.js
// ==/UserScript==

// The side menu box ("Sign in to like videos, comment, and subscribe") has its own element.
// The click popups ("Like this video? Sign in to make your opinion count.") are dropdowns
// in ytd-popup-container holding a modal with a link to Google's sign-in page. Matching
// on that link leaves other dropdowns (share, menus, playlists) alone.
// The Sign in button at the top right stays, so you can still sign in.
GM_addStyle(`
  ytd-guide-signin-promo-renderer,
  ytd-popup-container tp-yt-iron-dropdown:has(ytd-modal-with-title-and-button-renderer a[href*="ServiceLogin"]) {
    display: none !important;
  }
`);
