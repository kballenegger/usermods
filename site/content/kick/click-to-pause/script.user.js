// ==UserScript==
// @name         Click the Kick player to pause
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Pauses or plays a Kick stream or VOD when you click the video.
// @match        https://kick.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/kick/click-to-pause.user.js
// @updateURL    https://usermods.kennethballenegger.com/kick/click-to-pause.user.js
// ==/UserScript==

// Kick's player ignores clicks on the video itself. The listener sits on the document,
// so it keeps working when Kick swaps the page without a reload. It only reacts to a
// plain left click that lands on the <video> element; the control bar and its buttons
// are separate elements and behave as before.
document.addEventListener('click', (e) => {
  const video = e.target;
  if (e.button !== 0 || !(video instanceof HTMLVideoElement) || video.id !== 'video-player') return;
  if (video.paused) video.play();
  else video.pause();
}, true);
