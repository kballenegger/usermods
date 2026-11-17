// ==UserScript==
// @name         Rotate a YouTube video
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a rotate button to the YouTube player that turns the video 90 degrees clockwise per click and scales it to fit.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/rotate-video.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/rotate-video.user.js
// ==/UserScript==

const BUTTON_ID = 'usermods-rotate-button';
let angle = 0;       // 0, 90, 180 or 270
let angleFor = null; // the video the angle belongs to; a new video starts upright

function player() {
  return document.querySelector('#movie_player');
}

// Rotation is a CSS transform on the <video> element, so it changes nothing about playback.
// At 90 and 270 degrees the picture's width and height swap, so it is also scaled down (or
// up) to fit inside the player.
function apply() {
  const p = player();
  const video = p?.querySelector('video');
  if (!video) return;
  const id = p.getVideoData?.().video_id ?? null;
  if (id !== angleFor) {
    angleFor = id;
    angle = 0;
  }
  if (angle === 0) {
    if (video.style.getPropertyValue('transform')) video.style.removeProperty('transform');
    return;
  }
  let scale = 1;
  if (angle % 180 !== 0 && video.clientWidth && video.clientHeight) {
    scale = Math.min(p.clientWidth / video.clientHeight, p.clientHeight / video.clientWidth);
  }
  const transform = `rotate(${angle}deg) scale(${scale.toFixed(4)})`;
  // Only write when it changes: the write is itself a style mutation the observer sees.
  if (video.style.getPropertyValue('transform') !== transform) {
    video.style.setProperty('transform', transform, 'important');
  }
}

// YouTube enforces Trusted Types, so the icon is built with DOM calls instead of innerHTML.
function makeButton() {
  const ns = 'http://www.w3.org/2000/svg';
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.className = 'ytp-button';
  button.title = 'Rotate 90 degrees';
  button.setAttribute('aria-label', 'Rotate 90 degrees');
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  const arrow = document.createElementNS(ns, 'path');
  arrow.setAttribute('d', 'M16 9a7 7 0 1 0 7 7h-2a5 5 0 1 1-5-5v3l4-4-4-4z');
  arrow.setAttribute('fill', '#fff');
  svg.append(arrow);
  button.append(svg);
  button.addEventListener('click', () => {
    apply(); // resets the angle first if this is a new video
    angle = (angle + 90) % 360;
    apply();
  });
  return button;
}

// The player builds its controls after the page loads and can rebuild them, so the button is
// put back whenever it is missing. YouTube rewrites the video's inline size when the player
// changes size (theater mode, full screen), so the transform is reapplied on every change.
function ensure() {
  if (!document.getElementById(BUTTON_ID)) {
    const settings = document.querySelector('#movie_player .ytp-right-controls .ytp-settings-button');
    if (settings) settings.before(makeButton());
  }
  if (angle !== 0) apply();
}

new MutationObserver(ensure).observe(document.documentElement, {
  childList: true, subtree: true, attributes: true, attributeFilter: ['style'],
});
document.addEventListener('loadedmetadata', apply, true);
