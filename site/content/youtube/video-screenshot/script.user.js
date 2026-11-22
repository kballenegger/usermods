// ==UserScript==
// @name         Take a screenshot of a YouTube video
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a camera button to the YouTube player that saves the current frame as a PNG at the video's full resolution.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/video-screenshot.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/video-screenshot.user.js
// ==/UserScript==

const BUTTON_ID = 'usermods-screenshot-button';

// Draws the current frame onto a canvas the size of the video (not the size it is shown at)
// and downloads it. YouTube streams through a same-origin blob: URL, so the canvas is not
// tainted and can be exported.
function saveFrame() {
  const video = document.querySelector('#movie_player video');
  if (!video || !video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const title = (document.querySelector('ytd-watch-metadata h1')?.textContent || document.title)
    .trim().replace(/[\\/:*?"<>|]+/g, '').slice(0, 100);
  const t = Math.floor(video.currentTime);
  const stamp = `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s`;
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title} ${stamp}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, 'image/png');
}

// YouTube enforces Trusted Types, so the icon is built with DOM calls instead of innerHTML.
function makeButton() {
  const ns = 'http://www.w3.org/2000/svg';
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.className = 'ytp-button';
  button.title = 'Save this frame as an image';
  button.setAttribute('aria-label', 'Save this frame as an image');
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  const body = document.createElementNS(ns, 'path');
  body.setAttribute('d', 'M9 12h3l1.5-2h5l1.5 2h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z');
  body.setAttribute('fill', 'none');
  body.setAttribute('stroke', '#fff');
  body.setAttribute('stroke-width', '1.6');
  const lens = document.createElementNS(ns, 'circle');
  lens.setAttribute('cx', '16');
  lens.setAttribute('cy', '16.5');
  lens.setAttribute('r', '2.8');
  lens.setAttribute('fill', 'none');
  lens.setAttribute('stroke', '#fff');
  lens.setAttribute('stroke-width', '1.6');
  svg.append(body, lens);
  button.append(svg);
  button.addEventListener('click', saveFrame);
  return button;
}

// The player builds its controls after the page loads and can rebuild them, so the button is
// put back whenever it is missing. It goes just before the Settings gear.
function ensureButton() {
  if (document.getElementById(BUTTON_ID)) return;
  const settings = document.querySelector('#movie_player .ytp-right-controls .ytp-settings-button');
  if (settings) settings.before(makeButton());
}

new MutationObserver(ensureButton).observe(document.documentElement, { childList: true, subtree: true });
