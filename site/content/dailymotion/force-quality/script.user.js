// ==UserScript==
// @name         Set Dailymotion video quality
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Switches every Dailymotion video from Auto to the highest quality it offers.
// @match        https://www.dailymotion.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/dailymotion/force-quality.user.js
// @updateURL    https://usermods.kennethballenegger.com/dailymotion/force-quality.user.js
// ==/UserScript==

// Change MAX to a number such as 720 to cap the quality instead of taking the highest.
const MAX = Infinity;

// The player lives in an iframe on geo.dailymotion.com, but the page loads Dailymotion's own
// player API as window.dailymotion, which can read the list of qualities and set one.
const done = new Set(); // video ids already switched, so a manual change sticks
const seen = new WeakSet(); // players already hooked

const pick = async (player) => {
  const state = await player.getState();
  const list = (state.videoQualitiesList || []).map(Number).filter((q) => q > 0 && q <= MAX);
  if (!state.videoId || !list.length || done.has(state.videoId)) return;
  // The player ignores a quality set before the video itself (not an ad) is playing.
  if (!state.playerIsPlaying || state.adIsPlaying) return;
  done.add(state.videoId);
  player.setQuality(String(Math.max(...list)));
};

const hook = (player) => {
  if (seen.has(player)) return;
  seen.add(player);
  const ev = window.dailymotion.events;
  player.on(ev.VIDEO_QUALITIESREADY, () => pick(player));
  player.on(ev.VIDEO_START, () => pick(player));
  player.on(ev.VIDEO_PLAYING, () => pick(player));
  // The video may be playing before the hooks went on.
  pick(player);
};

// window.dailymotion appears some time after document-start, and the site creates new players
// as you move between pages without a reload, so look for players every second.
setInterval(async () => {
  if (!window.dailymotion || !window.dailymotion.getAllPlayers) return;
  // getAllPlayers resolves to a list of promises, one per player.
  const players = await Promise.all(await window.dailymotion.getAllPlayers());
  for (const p of players) hook(p);
}, 1000);
