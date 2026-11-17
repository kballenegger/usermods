// ==UserScript==
// @name         Stop the channel trailer autoplaying on YouTube
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Stops the featured video or trailer on YouTube channel pages from playing on its own.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/disable-channel-autoplay.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/disable-channel-autoplay.user.js
// ==/UserScript==

// A channel's home tab can feature a video (a trailer for visitors) in a
// <ytd-channel-video-player-renderer>, and YouTube starts it playing, muted, when the page
// opens. The script pauses that video whenever it starts without you having pressed
// play. Once you click on the featured player, it stops interfering, so you can still
// watch the trailer. Videos on watch pages are not touched.
let userStarted = false;

document.addEventListener('pointerdown', (e) => {
  if (e.target instanceof Element && e.target.closest('ytd-channel-video-player-renderer')) userStarted = true;
}, true);
document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('ytd-channel-video-player-renderer')) userStarted = true;
}, true);
// A new page (another channel) resets the rule.
document.addEventListener('yt-navigate-finish', () => { userStarted = false; });

// Media events don't bubble; listening in the capture phase catches the trailer's
// <video> as soon as it starts.
document.addEventListener('playing', (e) => {
  const video = e.target;
  if (userStarted || !(video instanceof HTMLVideoElement)) return;
  if (video.closest('ytd-channel-video-player-renderer')) video.pause();
}, true);
