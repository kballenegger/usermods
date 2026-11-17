// ==UserScript==
// @name         Control Twitch volume with the mouse wheel
// @namespace    https://usermods.kennethballenegger.com
// @version      1.1.0
// @description  Scroll up or down over a Twitch video player to turn its volume up or down.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/twitch/scroll-volume.user.js
// @updateURL    https://usermods.kennethballenegger.com/twitch/scroll-volume.user.js
// ==/UserScript==

// Every 100 pixels of scrolling over a player moves Twitch's own volume slider by 5%. A
// notched mouse wheel sends about 100 pixels per notch; a trackpad or smooth-scrolling
// wheel sends many small events, which add up until they reach 100 pixels, so one swipe
// moves the volume gradually instead of jumping to 0% or 100%. The script sets the slider's
// value and fires the same input/change events a drag would, so Twitch's player, its mute
// button and its saved volume all stay in step. The listener is not passive, so the page
// doesn't scroll while the pointer is over the player.
const STEP = 0.05;
const PIXELS_PER_STEP = 100;
// WheelEvent.deltaMode: 0 pixels, 1 lines (Firefox sends 3 lines per notch), 2 pages.
const PIXELS_PER_UNIT = [1, PIXELS_PER_STEP / 3, 800];
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
let pending = 0;

document.addEventListener('wheel', (e) => {
  if (e.deltaY === 0 || !(e.target instanceof Element)) return;
  const player = e.target.closest('[data-a-target="video-player"]');
  const slider = player && player.querySelector('input[data-a-target="player-volume-slider"]');
  if (!slider) return;
  e.preventDefault();

  const delta = e.deltaY * PIXELS_PER_UNIT[e.deltaMode];
  // A change of direction starts a fresh count.
  if (Math.sign(delta) !== Math.sign(pending)) pending = 0;
  pending += delta;
  const steps = Math.trunc(pending / PIXELS_PER_STEP);
  if (steps === 0) return;
  pending -= steps * PIXELS_PER_STEP;

  const up = steps < 0;
  const muteButton = player.querySelector('[data-a-target="player-mute-unmute-button"]');
  const muted = player.querySelector('video')?.muted;
  // Scrolling up on a muted player unmutes it first, as clicking the speaker icon would.
  if (up && muted && muteButton) muteButton.click();

  const min = Number(slider.min || 0);
  const max = Number(slider.max || 1);
  const next = Math.min(max, Math.max(min, Number(slider.value) - steps * STEP * (max - min)));
  setValue.call(slider, String(Math.round(next * 100) / 100));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
}, { capture: true, passive: false });
