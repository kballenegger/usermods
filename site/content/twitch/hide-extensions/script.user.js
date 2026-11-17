// ==UserScript==
// @name         Hide extension overlays on Twitch
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Hides Twitch extension overlays and the extension icon dock on top of the video player.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/twitch/hide-extensions.user.js
// @updateURL    https://usermods.kennethballenegger.com/twitch/hide-extensions.user.js
// ==/UserScript==

// Overlay extensions are iframes inside .extensions-video-overlay-size-container, laid over
// the video. The dock is the column of extension icons on the right edge of the player;
// the popovers and info balloons open from it. Extension panels under the stream (in the
// About section) are left alone. CSS applies at once and on every channel you open.
// Twitch's own styles also use !important, so each rule is prefixed with `html body` to
// outrank them.
GM_addStyle(`
  html body .extensions-video-overlay-size-container,
  html body .extensions-dock__layout,
  html body .extensions-dock__dock,
  html body .extensions-dock-card,
  html body .extensions-popover,
  html body .extensions-info-balloon,
  html body .extensions-notifications { display: none !important; }
`);
