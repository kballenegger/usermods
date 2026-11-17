// ==UserScript==
// @name         Stop Twitch front page autoplay
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Keeps the featured stream on the Twitch front page paused until you click it.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/twitch/disable-autoplay.user.js
// @updateURL    https://usermods.kennethballenegger.com/twitch/disable-autoplay.user.js
// ==/UserScript==

// The front page carousel ([data-a-target="front-page-carousel"]) starts a muted stream on
// load and again each time it moves to another channel. "play" events don't bubble, but a
// capturing listener on the document still sees them, so every start of a video inside the
// carousel is paused straight away. Once you click or press a key inside the carousel, its
// videos are left alone until the next page load. Channel pages are not affected.
let userStarted = false;

function inCarousel(node) {
  return node instanceof Element && node.closest('[data-a-target="front-page-carousel"]') !== null;
}

document.addEventListener('pointerdown', (e) => { if (inCarousel(e.target)) userStarted = true; }, true);
document.addEventListener('keydown', (e) => { if (inCarousel(e.target)) userStarted = true; }, true);

function stop(e) {
  const video = e.target;
  if (userStarted || !(video instanceof HTMLVideoElement) || !inCarousel(video)) return;
  video.pause();
}

document.addEventListener('play', stop, true);
document.addEventListener('playing', stop, true);
