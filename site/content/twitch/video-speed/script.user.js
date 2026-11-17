// ==UserScript==
// @name         Change playback speed on Twitch
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Adds Shift+. and Shift+, shortcuts that speed up or slow down Twitch videos in 0.25x steps, between 0.25x and 2x.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/twitch/video-speed.user.js
// @updateURL    https://usermods.kennethballenegger.com/twitch/video-speed.user.js
// ==/UserScript==

(() => {
  const STEP = 0.25;
  const MIN = 0.25;
  // Twitch's player puts any speed above 2x back to 2x, so the range stops there.
  const MAX = 2;
  let badge = null;
  let hideTimer = 0;

  // The visible player. Twitch keeps a single <video> per player; pick the largest
  // visible one so a muted preview elsewhere on the page is ignored.
  const playerVideo = () =>
    [...document.querySelectorAll('video')]
      .filter((v) => v.checkVisibility())
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];

  const show = (video, rate) => {
    const host = video.parentElement;
    if (!badge) {
      badge = document.createElement('div');
      badge.dataset.usermodsSpeed = '';
      badge.style.cssText =
        'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:100;' +
        'padding:4px 10px;border-radius:4px;background:rgba(0,0,0,.75);color:#fff;' +
        'font:600 16px/1.4 sans-serif;pointer-events:none';
    }
    if (badge.parentElement !== host) host.appendChild(badge);
    badge.textContent = `${rate}x`;
    badge.style.display = '';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { badge.style.display = 'none'; }, 1200);
  };

  // Capture phase on window, so the shortcut works before Twitch's own key handlers.
  // Keys typed into chat or any other text field are left alone.
  window.addEventListener('keydown', (e) => {
    if (e.key !== '>' && e.key !== '<') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
    const video = playerVideo();
    if (!video) return;
    const delta = e.key === '>' ? STEP : -STEP;
    const rate = Math.min(MAX, Math.max(MIN, Math.round((video.playbackRate + delta) / STEP) * STEP));
    video.playbackRate = rate;
    show(video, rate);
    e.preventDefault();
    e.stopPropagation();
  }, true);
})();
