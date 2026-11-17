// ==UserScript==
// @name         Stop Dailymotion autoplay
// @namespace    https://usermods.kennethballenegger.com
// @version      1.1.0
// @description  Pauses Dailymotion videos when they start on their own, including the next video in the queue, so nothing plays until you press play.
// @match        https://www.dailymotion.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/dailymotion/disable-autoplay.user.js
// @updateURL    https://usermods.kennethballenegger.com/dailymotion/disable-autoplay.user.js
// ==/UserScript==

// The player lives in an iframe on geo.dailymotion.com, but the page loads Dailymotion's own
// player API as window.dailymotion. The script uses that API to pause each video (or the ad in
// front of it) the first time it starts on its own. After that it leaves the player alone, so
// your own play button works as usual.
const handled = new Set(); // video ids already seen starting
const seen = new WeakSet(); // players already hooked

// A click inside the player's iframe never reaches this page, but it moves focus into the iframe,
// which blurs this window. If that happened since the last start, the start was the user's press
// (say the browser blocked autoplay and the user clicked play), so it is left to play.
let clickedPlayer = false;
window.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement && document.activeElement.matches('iframe.dailymotion-player')) clickedPlayer = true;
  });
});

const stopOnce = async (player) => {
  const state = await player.getState();
  if (!state.videoId) return;
  if (handled.has(state.videoId)) {
    // Any click is spent on a video that already started.
    clickedPlayer = false;
    return;
  }
  if (!state.playerIsPlaying && !state.adIsPlaying) return;
  handled.add(state.videoId);
  if (clickedPlayer) {
    clickedPlayer = false;
    return;
  }
  player.pause();
};

const hook = (player) => {
  if (seen.has(player)) return;
  seen.add(player);
  const ev = window.dailymotion.events;
  player.on(ev.VIDEO_START, () => stopOnce(player));
  player.on(ev.VIDEO_PLAYING, () => stopOnce(player));
  player.on(ev.AD_START, () => stopOnce(player));
  // A click during the last video says nothing about whether the next one should start.
  player.on(ev.VIDEO_END, () => {
    clickedPlayer = false;
  });
  // The player may have started before the hooks went on.
  stopOnce(player);
};

// window.dailymotion appears some time after document-start, and the site creates new players
// as you move between pages without a reload, so look for players every second.
setInterval(async () => {
  if (!window.dailymotion || !window.dailymotion.getAllPlayers) return;
  // getAllPlayers resolves to a list of promises, one per player.
  const players = await Promise.all(await window.dailymotion.getAllPlayers());
  for (const p of players) hook(p);
}, 1000);
