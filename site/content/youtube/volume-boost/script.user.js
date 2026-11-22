// ==UserScript==
// @name         Boost YouTube volume above 100%
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a button next to YouTube's volume control that boosts the sound to 1.5x, 2x or 3x of the maximum.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/volume-boost.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/volume-boost.user.js
// ==/UserScript==

// The boost levels the button steps through. Above 3x most videos distort.
const LEVELS = [1, 1.5, 2, 3];
const BUTTON_ID = 'usermods-volume-boost';

GM_addStyle(`
  #${BUTTON_ID} { width: auto; min-width: 40px; padding: 0 6px; color: #fff; font: 500 13px Roboto, Arial, sans-serif; text-align: center; opacity: .9; }
  #${BUTTON_ID}[aria-pressed="true"] { color: #ffd54f; }
`);

let level = 0;
let gain = null;
let context = null;
let routed = null; // the <video> element whose sound goes through the gain node

// The <video> element's own volume cannot go past 1. To go further, its sound is routed
// through the Web Audio API: video -> gain node -> speakers, and the gain node multiplies
// it. This is set up on the first click (browsers only start audio after a click) and kept
// for the life of the page, since an element can only be routed once. YouTube reuses the
// same <video> element for every video, so the boost carries over to the next one.
function route(video) {
  if (routed === video) return;
  context ??= new AudioContext();
  gain ??= context.createGain();
  context.createMediaElementSource(video).connect(gain);
  gain.connect(context.destination);
  routed = video;
}

function setLevel(button) {
  const factor = LEVELS[level];
  if (gain) gain.gain.value = factor;
  button.textContent = `${factor}x`;
  button.title = factor === 1 ? 'Volume boost: off' : `Volume boost: ${factor}x`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(factor !== 1));
}

function makeButton() {
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.className = 'ytp-button';
  button.addEventListener('click', () => {
    const video = document.querySelector('#movie_player video');
    if (!video) return;
    level = (level + 1) % LEVELS.length;
    if (LEVELS[level] !== 1) route(video);
    context?.resume();
    setLevel(button);
  });
  setLevel(button);
  return button;
}

// The player builds its controls after the page loads and can rebuild them, so the button is
// put back whenever it is missing. It goes right after the volume slider.
function ensureButton() {
  if (document.getElementById(BUTTON_ID)) return;
  const volume = document.querySelector('#movie_player .ytp-left-controls .ytp-volume-area');
  if (volume) volume.after(makeButton());
}

new MutationObserver(ensureButton).observe(document.documentElement, { childList: true, subtree: true });
