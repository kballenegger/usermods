// ==UserScript==
// @name         Turn off YouTube autoplay
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.4
// @description  Switches off YouTube's autoplay toggle so the next video does not start on its own.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/disable-autoplay.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/disable-autoplay.user.js
// ==/UserScript==

// The autoplay switch sits in the player's control bar; its inner element carries
// aria-checked="true" while autoplay is on. The script clicks it, the same as you would, so
// YouTube stores the choice its own way. While the player is still loading its settings it
// can ignore the click or set the switch back, so the script tries again each time the
// player announces an update ("yt-player-updated") and when the video starts playing. Once
// the video is playing with the switch off, it stops. That happens once per page load: if
// you turn autoplay back on, it stays on until the next full page load.
let done = false;

function switchOff(event) {
  if (done) return;
  const toggle = document.querySelector('#movie_player .ytp-autonav-toggle-button');
  if (!toggle) return; // not a video page yet
  if (toggle.getAttribute('aria-checked') === 'true') toggle.click();
  if (event.type === 'playing' && toggle.getAttribute('aria-checked') === 'false') done = true;
}

document.addEventListener('yt-player-updated', switchOff);
// Media events don't bubble; listening in the capture phase catches the player's <video>.
document.addEventListener('playing', switchOff, true);
