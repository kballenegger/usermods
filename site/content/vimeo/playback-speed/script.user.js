// ==UserScript==
// @name         Change Vimeo playback speed
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds keyboard shortcuts to Vimeo videos: Shift+. speeds up and Shift+, slows down in steps of 0.25, from 0.25x to 4x, even when the uploader has hidden the speed menu.
// @match        https://vimeo.com/*
// @match        https://player.vimeo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/vimeo/playback-speed.user.js
// @updateURL    https://usermods.kennethballenegger.com/vimeo/playback-speed.user.js
// ==/UserScript==

const MIN = 0.25;
const MAX = 4;
const STEP = 0.25;

GM_addStyle(`
  #usermods-speed-badge {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    padding: 6px 14px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.75);
    color: #fff;
    font: 600 18px/1.2 system-ui, sans-serif;
    pointer-events: none;
    transition: opacity 0.3s;
  }
  #usermods-speed-badge[hidden] { display: block; opacity: 0; }
`);

// Every <video> on the page: the main player, or the one inside an embedded player.
const videos = () => [...document.querySelectorAll('video')];

let hideTimer;
function show(speed) {
  let badge = document.getElementById('usermods-speed-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'usermods-speed-badge';
    document.body.append(badge);
  }
  badge.textContent = `${speed}x`;
  badge.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (badge.hidden = true), 1200);
}

// Shift+. and Shift+, type ">" and "<" on US keyboards, the same keys YouTube uses for speed.
// Each press steps from the video's current rate, so a speed picked in Vimeo's own menu is
// the starting point. Keys typed into a text field are left alone.
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== '>' && event.key !== '<') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target;
    if (t instanceof Element && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const list = videos();
    if (!list.length) return;
    const current = list[0].playbackRate;
    const step = event.key === '>' ? STEP : -STEP;
    const speed = Math.min(MAX, Math.max(MIN, Math.round((current + step) / STEP) * STEP));
    for (const v of list) v.playbackRate = speed;
    show(speed);
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);
