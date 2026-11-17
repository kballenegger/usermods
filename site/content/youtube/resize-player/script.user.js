// ==UserScript==
// @name         Make the YouTube player fill the window
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Opens YouTube videos in theater mode and makes the player fill the whole window below the top bar, without going full screen.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/resize-player.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/resize-player.user.js
// ==/UserScript==

// Switch to theater mode on each watch page, using the player's own theater button so
// YouTube's layout and its "wide" cookie stay in step. The button ignores clicks until the
// player has loaded its video, which YouTube announces with yt-player-updated.
function theater() {
  if (location.pathname !== '/watch') return;
  const flexy = document.querySelector('ytd-watch-flexy');
  const button = document.querySelector('#movie_player .ytp-size-button');
  if (flexy && button && !flexy.hasAttribute('theater')) button.click();
}
document.addEventListener('yt-player-updated', theater);

// In theater mode the player spans the window's width but stops 169 px short of its
// height. These rules let it take the full height below the top bar instead. Full screen
// and the default (non-theater) layout are left alone, so pressing T still switches back.
GM_addStyle(`
  ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container {
    height: calc(100vh - var(--ytd-masthead-height-accounting-for-hidden, 56px)) !important;
    max-height: none !important;
  }
`);
