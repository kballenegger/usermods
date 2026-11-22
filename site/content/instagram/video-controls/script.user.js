// ==UserScript==
// @name         Add video controls to Instagram
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Turns on the browser's own video controls (progress bar, seeking, volume, speed, fullscreen) for Instagram videos and reels.
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/instagram/video-controls.user.js
// @updateURL    https://usermods.kennethballenegger.com/instagram/video-controls.user.js
// ==/UserScript==

// Instagram plays videos in a plain <video> element with the controls turned off, and lays
// transparent layers over it that catch every click. The script switches the controls on
// and lets clicks pass through the layers that sit on top of each video, so the control
// bar can be used. Instagram's own buttons inside those layers (the mute button, tags)
// are hidden; the browser's controls do the same jobs.
GM_addStyle(`
  [data-usermods-video-layer], [data-usermods-video-layer] * { pointer-events: none !important; }
  /* Instagram's own buttons in those layers, hidden (see below). */
  [data-usermods-video-layer="small"] { visibility: hidden !important; }
`);

function enableControls(video) {
  if (!video.controls) video.controls = true;
  const box = video.getBoundingClientRect();
  const area = box.width * box.height;
  // Only videos on screen can be hit-tested. The others are handled when they scroll in.
  if (area === 0 || box.bottom < 0 || box.top > innerHeight) return;
  // Ask the browser what sits on top of the video along its control bar (the button row
  // and the progress bar, left, middle and right), and let clicks through each such layer.
  // Layers much larger than the video (a dialog, the page header) are left alone. A marked
  // layer drops out of hit-testing, so this repeats until the video itself is on top.
  const bottom = Math.min(box.bottom, innerHeight);
  for (const dy of [15, 45]) {
    for (const fx of [0.08, 0.5, 0.92]) {
      for (const el of document.elementsFromPoint(box.left + box.width * fx, bottom - dy)) {
        if (el === video || el.contains(video)) break;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > area * 4) break;
        el.setAttribute('data-usermods-video-layer', '');
      }
    }
  }
  // Instagram's buttons inside those layers (mute, tags) no longer respond and can sit on
  // top of the control bar, so each one is hidden together with its small wrappers, which
  // draw the round background.
  for (const layer of document.querySelectorAll('[data-usermods-video-layer=""]')) {
    for (const button of layer.querySelectorAll('[role="button"]')) {
      let small = button;
      while (small.parentElement !== layer && size(small.parentElement) < area / 10) small = small.parentElement;
      small.setAttribute('data-usermods-video-layer', 'small');
    }
  }
}

function size(el) {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

// Instagram adds videos as you scroll and reuses players between posts, so every video is
// looked at again after each batch of changes and after scrolling, at most once a frame.
let queued = false;
function update() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    document.querySelectorAll('video').forEach(enableControls);
  });
}
new MutationObserver(update).observe(document, { childList: true, subtree: true });
addEventListener('scroll', update, { capture: true, passive: true });
addEventListener('resize', update);
