// ==UserScript==
// @name         Download full-size Spotify cover art
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Cover link to Spotify album pages that opens the album art at its largest size.
// @match        https://open.spotify.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/spotify/download-cover.user.js
// @updateURL    https://usermods.kennethballenegger.com/spotify/download-cover.user.js
// ==/UserScript==

// Album art on i.scdn.co is addressed as ab67616d0000 + a 4-character size code + the image
// hash. The page shows a 300 or 640 pixel copy; size code 82c1 is the largest Spotify serves
// (often 1500 pixels or more). The script reads the hash from the album header image and
// links to the 82c1 version. Browsers ignore the download attribute on links to other
// domains, so the link opens the image in a new tab, where you can save it.
GM_addStyle(`
  .usermods-cover-link {
    margin-inline-start: 16px;
    color: var(--text-subdued, #b3b3b3);
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
  }
  .usermods-cover-link:hover { color: var(--text-base, #fff); text-decoration: underline; }
`);

const ALBUM_ART = /^https:\/\/i\.scdn\.co\/image\/ab67616d0000[0-9a-f]{4}([0-9a-f]{24,})$/;

function fullSizeUrl() {
  if (!location.pathname.startsWith('/album/')) return null;
  for (const img of document.querySelectorAll('[data-testid="entity-header"] img')) {
    const match = img.src.match(ALBUM_ART);
    if (match) return `https://i.scdn.co/image/ab67616d000082c1${match[1]}`;
  }
  return null;
}

function update() {
  const bar = document.querySelector('[data-testid="action-bar-row-actions"]');
  const url = fullSizeUrl();
  let link = document.querySelector('a.usermods-cover-link');
  // Spotify swaps pages in place, so the link is moved, updated or removed on every change.
  if (!bar || !url) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement('a');
    link.className = 'usermods-cover-link';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Cover';
    link.title = 'Open the full-size cover art';
  }
  if (link.parentElement !== bar) bar.append(link);
  if (link.href !== url) link.href = url;
}

new MutationObserver(update).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
