// ==UserScript==
// @name         Open full-size photos on IMDb
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a "Full size" link to IMDb's photo viewer that opens the original image file in a new tab.
// @match        https://www.imdb.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/imdb/larger-photos.user.js
// @updateURL    https://usermods.kennethballenegger.com/imdb/larger-photos.user.js
// ==/UserScript==

// IMDb images live on m.media-amazon.com. Everything after "._V1_" in the file name is a
// resize or crop instruction; "<id>._V1_.jpg" is the original upload. The viewer scales the
// image to the window and covers it with a swipe layer, so right-click "Open image" doesn't
// work. This link points at the original file and follows the viewer as you page through.
GM_addStyle(`
  .usermods-fullsize {
    position: fixed; left: 150px; top: 24px; z-index: 10000;
    padding: 8px 14px; border-radius: 4px; background: #f5c518; color: #000 !important;
    font: 600 14px/1.2 Roboto, Helvetica, Arial, sans-serif; text-decoration: none;
  }
`);

function original(src) {
  const m = src.match(/^(https:\/\/m\.media-amazon\.com\/images\/M\/[^.]+)\..*\.(jpe?g|png)$/i);
  return m ? `${m[1]}._V1_.${m[2]}` : null;
}

function update() {
  let link = document.querySelector('.usermods-fullsize');
  const onViewer = /\/mediaviewer\/rm\d+/.test(location.pathname);
  // The viewer keeps neighbouring photos loaded off screen; use the one being shown.
  const img = onViewer && [...document.querySelectorAll('[data-testid="media-viewer"] img')]
    .find((i) => i.checkVisibility() && i.getBoundingClientRect().width > 200 && original(i.currentSrc || i.src));
  const href = img && original(img.currentSrc || img.src);
  if (!href) { link?.remove(); return; }
  if (!link) {
    link = document.createElement('a');
    link.className = 'usermods-fullsize';
    link.textContent = 'Full size';
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.append(link);
  }
  if (link.href !== href) link.href = href;
}

// The viewer swaps the image in place when you page through, so watch for src changes too.
new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
// Paging can also show an already-loaded image without any DOM change, so listen for loads.
document.addEventListener('load', update, true);
update();
