// ==UserScript==
// @name         Take a screenshot of a Twitch stream
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.3
// @description  Adds a camera button to the Twitch player that saves the current video frame as a PNG at the stream's full resolution.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/twitch/video-screenshot.user.js
// @updateURL    https://usermods.kennethballenegger.com/twitch/video-screenshot.user.js
// ==/UserScript==

(() => {
  // The camera icon, built with DOM calls so the script never parses an HTML string.
  const icon = () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const attrs = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    const body = document.createElementNS(ns, 'path');
    body.setAttribute('d', 'M4 8h3l2-3h6l2 3h3v11H4z');
    const lens = document.createElementNS(ns, 'circle');
    lens.setAttribute('cx', 12);
    lens.setAttribute('cy', 13);
    lens.setAttribute('r', 3.5);
    svg.append(body, lens);
    return svg;
  };

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

  // Draws the frame on screen into a canvas at the video's own resolution (not the size
  // it is displayed at) and saves it. Twitch plays through Media Source Extensions, so
  // the canvas is not tainted and can be exported.
  const capture = (video) => {
    if (!video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const name = location.pathname.split('/').filter(Boolean).join('-') || 'twitch';
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}-${stamp()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, 'image/png');
  };

  // The right-hand group of player controls (quality, settings, theatre, fullscreen) is
  // rebuilt when you move between channels, so the button is re-added whenever a group
  // without it shows up.
  const addButtons = () => {
    for (const group of document.querySelectorAll('.player-controls__right-control-group')) {
      if (group.querySelector('[data-usermods-screenshot]')) continue;
      const player = group.closest('.video-player');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.usermodsScreenshot = '';
      btn.title = 'Save a screenshot';
      btn.setAttribute('aria-label', 'Save a screenshot');
      btn.append(icon());
      btn.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;' +
        'background:none;border:0;border-radius:4px;color:#fff;cursor:pointer;';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const video = (player || document).querySelector('video');
        if (video) capture(video);
      });
      group.prepend(btn);
    }
  };

  // Observe the document itself: at document-start the <html> element may not exist yet.
  new MutationObserver(addButtons).observe(document, { childList: true, subtree: true });
})();
