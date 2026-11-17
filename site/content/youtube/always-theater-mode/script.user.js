// ==UserScript==
// @name         Always open YouTube in theater mode
// @namespace    https://usermods.kennethballenegger.com
// @version      1.2.0
// @description  Switches every YouTube video page to theater mode when it opens.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/always-theater-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/always-theater-mode.user.js
// ==/UserScript==

// YouTube marks the watch page layout with a "theater" attribute on <ytd-watch-flexy>.
// When a video page opens without it, the script clicks the player's own theater button
// (the one the T key presses), so YouTube resizes the player and saves the choice its
// usual way. The player ignores clicks until it has finished loading, so the script
// keeps checking as the page changes and clicks again, at most once a second, until the
// page is in theater mode. Then it leaves that video alone: if you switch back to the
// default view, it stays that way, and the next video you open starts in theater mode.
// Full screen is left alone.
let done = '';
let lastClick = 0;

function apply() {
  if (location.pathname !== '/watch') return;
  const id = new URLSearchParams(location.search).get('v');
  if (!id || id === done) return;
  const flexy = document.querySelector('ytd-watch-flexy');
  const button = document.querySelector('#movie_player .ytp-size-button');
  if (!flexy || !button) return;
  if (flexy.hasAttribute('theater') || flexy.hasAttribute('fullscreen')) {
    done = id;
    return;
  }
  if (Date.now() - lastClick < 1000) return;
  lastClick = Date.now();
  button.click();
}

// The player is built after the page shell, and YouTube swaps videos without reloading,
// so check again on every change to the document and when playback starts. Media events
// don't bubble; the capture phase catches the player's <video>.
new MutationObserver(apply).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['theater'] });
document.addEventListener('playing', apply, true);
