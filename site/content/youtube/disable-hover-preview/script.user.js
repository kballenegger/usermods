// ==UserScript==
// @name         Stop YouTube previews on hover
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Stops YouTube from playing a video preview when you hover over a thumbnail.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/disable-hover-preview.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/disable-hover-preview.user.js
// ==/UserScript==

// YouTube plays hover previews in a floating #video-preview element laid over the
// thumbnail. The CSS rule hides it, so the plain thumbnail stays on screen. Hidden is not
// stopped, so the listener also pauses any video that starts playing inside the preview,
// which keeps it from using bandwidth or playing sound. The watch page player is not inside
// #video-preview and is left alone.
GM_addStyle('#video-preview { display: none !important; }');

document.addEventListener('playing', (e) => {
  const video = e.target;
  if (video instanceof HTMLVideoElement && video.closest('#video-preview')) video.pause();
}, true);
