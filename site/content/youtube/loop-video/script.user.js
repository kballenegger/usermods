// ==UserScript==
// @name         Loop a YouTube video
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a loop button to the YouTube player that puts the current video on repeat.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/loop-video.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/loop-video.user.js
// ==/UserScript==

const BUTTON_ID = 'usermods-loop-button';

// The button sets the "loop" flag on the player's <video> element, the same flag YouTube's
// own right-click "Loop" item uses, so the two stay in step. While it is on, the video starts
// again from the beginning when it ends instead of moving on to the next one.
function video() {
  return document.querySelector('#movie_player video');
}

function sync() {
  const button = document.getElementById(BUTTON_ID);
  const v = video();
  if (!button || !v) return;
  button.setAttribute('aria-pressed', String(v.loop));
  button.style.opacity = v.loop ? '1' : '0.5';
  button.title = v.loop ? 'Loop is on' : 'Loop is off';
}

// YouTube enforces Trusted Types, so the icon is built with DOM calls instead of innerHTML.
function makeButton() {
  const ns = 'http://www.w3.org/2000/svg';
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.className = 'ytp-button';
  button.setAttribute('aria-label', 'Loop');
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  const arrows = document.createElementNS(ns, 'path');
  arrows.setAttribute('d', 'M11 13h9v3l4-4-4-4v3H9v6h2zm10 6h-9v-3l-4 4 4 4v-3h11v-6h-2z');
  arrows.setAttribute('fill', '#fff');
  svg.append(arrows);
  button.append(svg);
  button.addEventListener('click', () => {
    const v = video();
    if (!v) return;
    v.loop = !v.loop;
    sync();
  });
  return button;
}

// The player builds its controls after the page loads and can rebuild them, so the button is
// put back whenever it is missing. It goes just before the Settings gear. The button state is
// refreshed on every mutation so it follows the right-click menu too.
function ensureButton() {
  if (!document.getElementById(BUTTON_ID)) {
    const settings = document.querySelector('#movie_player .ytp-right-controls .ytp-settings-button');
    if (settings) settings.before(makeButton());
  }
  sync();
}

new MutationObserver(ensureButton).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('play', sync, true);
