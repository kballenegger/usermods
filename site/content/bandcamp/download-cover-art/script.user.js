// ==UserScript==
// @name         Download full-size Bandcamp album art
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Adds a link under the cover on Bandcamp album and track pages that opens the original, full-size image.
// @match        https://*.bandcamp.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/bandcamp/download-cover-art.user.js
// @updateURL    https://usermods.kennethballenegger.com/bandcamp/download-cover-art.user.js
// ==/UserScript==

(() => {
  const art = document.querySelector('#tralbumArt');
  const popup = art && art.querySelector('a.popupImage');
  if (!popup) return;

  // Bandcamp image URLs end in _<size>.<ext>: _10 is the 1200 px version the cover pop-up
  // shows, and _0 is the file the artist uploaded, at its original size.
  const original = popup.href.replace(/_\d+\.(jpg|png|gif)$/, '_0.$1');
  if (original === popup.href) return;

  GM_addStyle(`
    .um-full-art { display: inline-block; margin: 6px 0 12px; font-size: 13px; }
  `);

  const link = document.createElement('a');
  link.className = 'um-full-art custom-link-color';
  link.href = original;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Full-size cover art';
  art.appendChild(link);
})();
