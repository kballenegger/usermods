// ==UserScript==
// @name         Set a default YouTube playback speed
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Starts every YouTube video at 1.5x speed. Change SPEED at the top of the script to pick another speed.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/default-playback-speed.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/default-playback-speed.user.js
// ==/UserScript==

// The speed every video starts at. YouTube's menu offers 0.25 to 2 in steps of 0.25.
const SPEED = 1.5;

// YouTube keeps one <video> element and swaps the source when you move to another video,
// so the speed is applied each time a new source loads. Media events don't bubble, but they
// do reach a capturing listener on the document. Changing the speed by hand during a video
// still works: the script only acts when a new video loads.
const applied = new WeakMap();

function apply(video) {
  if (applied.get(video) === video.currentSrc) return;
  applied.set(video, video.currentSrc);
  // The player's own API keeps YouTube's speed menu in sync; fall back to the element only
  // for videos outside the main player (previews, embeds).
  const player = video.closest('#movie_player');
  if (player && typeof player.setPlaybackRate === 'function') player.setPlaybackRate(SPEED);
  else video.playbackRate = SPEED;
}

for (const type of ['loadedmetadata', 'playing']) {
  document.addEventListener(type, (event) => {
    if (event.target instanceof HTMLVideoElement) apply(event.target);
  }, true);
}
