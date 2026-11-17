// ==UserScript==
// @name         Play YouTube faster than 2x
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Lets YouTube's Shift+> and Shift+< shortcuts go past 2x, up to 4x, in steps of 0.25.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/faster-playback-speed.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/faster-playback-speed.user.js
// ==/UserScript==

// Change these to taste. Chrome mutes the sound above 4x.
const MAX_SPEED = 4;
const STEP = 0.25;

// YouTube's own speed menu and shortcuts stop at 2x. This script takes over Shift+> and
// Shift+< before YouTube sees them. Up to 2x it sets the speed through the player, so
// YouTube's menu stays correct; above 2x it sets the <video> element's speed directly,
// which the player has no menu entry for.
function editing(target) {
  return target instanceof Element &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function showSpeed(player, rate) {
  let badge = document.getElementById('usermods-speed-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'usermods-speed-badge';
    badge.style.cssText = 'position:absolute;top:12%;left:50%;transform:translateX(-50%);z-index:70;' +
      'padding:6px 14px;border-radius:4px;background:rgba(0,0,0,.7);color:#fff;font:500 20px Roboto,Arial,sans-serif;pointer-events:none';
  }
  if (badge.parentElement !== player) player.append(badge);
  badge.textContent = `${rate}x`;
  badge.style.display = 'block';
  clearTimeout(badge.hideTimer);
  badge.hideTimer = setTimeout(() => { badge.style.display = 'none'; }, 1000);
}

window.addEventListener('keydown', (event) => {
  if (event.key !== '>' && event.key !== '<') return;
  if (event.ctrlKey || event.metaKey || event.altKey || editing(event.target)) return;
  const player = document.querySelector('#movie_player');
  const video = player?.querySelector('video');
  if (!video) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const delta = event.key === '>' ? STEP : -STEP;
  const rate = Math.min(MAX_SPEED, Math.max(STEP, Math.round((video.playbackRate + delta) / STEP) * STEP));
  if (rate <= 2 && typeof player.setPlaybackRate === 'function') player.setPlaybackRate(rate);
  // Set the element too: coming down from 2.25 to 2, the player still thinks it is at 2.
  video.playbackRate = rate;
  showSpeed(player, rate);
}, true);
