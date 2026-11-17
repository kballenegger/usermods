// ==UserScript==
// @name         Make YouTube always play in HD
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Sets every YouTube video to the highest quality it offers when it starts playing.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/force-hd-quality.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/force-hd-quality.user.js
// ==/UserScript==

// YouTube's player element (#movie_player) has methods for reading and setting the quality.
// They belong to the page, which is why this script runs with "@grant none".
//
// Media events don't bubble, so the script listens for "playing" in the capture phase on the
// whole document. The first time each video plays, it picks the top entry of the video's
// quality list ("auto" aside) and locks the player to it. After that it leaves the video
// alone, so a quality you pick yourself from the gear menu sticks.
let doneFor = null;

document.addEventListener('playing', (event) => {
  const player = document.querySelector('#movie_player');
  if (!player || !player.contains(event.target)) return;
  if (player.classList.contains('ad-showing')) return; // wait for the real video
  const id = player.getVideoData?.().video_id;
  if (!id || id === doneFor) return;
  const best = (player.getAvailableQualityLevels?.() ?? []).find((q) => q !== 'auto');
  if (!best) return;
  doneFor = id;
  if (player.getPlaybackQuality() !== best) player.setPlaybackQualityRange(best, best);
}, true);
