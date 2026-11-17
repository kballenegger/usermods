// ==UserScript==
// @name         Change YouTube volume with the mouse wheel
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Scroll up or down over a YouTube video to turn its volume up or down.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/scroll-volume.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/scroll-volume.user.js
// ==/UserScript==

// Every 100 pixels of scrolling over the video player moves the volume by 5 points out of
// 100. A notched mouse wheel sends about 100 pixels per notch; a trackpad sends many small
// events, which add up until they reach 100 pixels, so a swipe changes the volume
// gradually instead of jumping. The script uses the player's own volume controls, so the
// volume slider and mute button stay in step. The listener is not passive, so the page
// doesn't scroll while the pointer is over the video. Scrolling inside the player's
// settings menu still scrolls the menu.
const STEP = 5;
const PIXELS_PER_STEP = 100;
// WheelEvent.deltaMode: 0 pixels, 1 lines (Firefox sends 3 lines per notch), 2 pages.
const PIXELS_PER_UNIT = [1, PIXELS_PER_STEP / 3, 800];
let pending = 0;

document.addEventListener('wheel', (e) => {
  if (e.deltaY === 0 || !(e.target instanceof Element)) return;
  // Ctrl+wheel and trackpad pinch (which Chrome sends as Ctrl+wheel) zoom the page;
  // Shift and Cmd+wheel keep their usual meaning too.
  if (e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
  if (e.target.closest('.ytp-popup')) return; // settings and other player menus
  const player = e.target.closest('#movie_player');
  if (!player || typeof player.setVolume !== 'function') return;
  e.preventDefault();

  const delta = e.deltaY * PIXELS_PER_UNIT[e.deltaMode];
  // A change of direction starts a fresh count.
  if (Math.sign(delta) !== Math.sign(pending)) pending = 0;
  pending += delta;
  const steps = Math.trunc(pending / PIXELS_PER_STEP);
  if (steps === 0) return;
  pending -= steps * PIXELS_PER_STEP;

  // Scrolling up on a muted player unmutes it first, as clicking the speaker icon would.
  if (steps < 0 && player.isMuted()) player.unMute();
  player.setVolume(Math.min(100, Math.max(0, player.getVolume() - steps * STEP)));
}, { capture: true, passive: false });
