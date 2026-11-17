// ==UserScript==
// @name         Open Google Images results directly
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a link to the full-size original image on each Google Images result.
// @match        https://www.google.com/search*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/images-direct-links.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/images-direct-links.user.js
// ==/UserScript==

// Google Images keeps each result's original image address and size in the page's inline
// data, next to the result's id (data-docid on the tile), as
//   "<docid>",["<thumbnail>",h,w],["<original>",h,w]
// The script reads that data from the page's inline <script> blocks and matches it to the
// tiles. Results added while you scroll come in a later network response the script
// can't read, so only the first batch (about 100 images) gets the label.
const images = new Map();
let scannedScripts = 0;

function scanScripts() {
  const scripts = document.scripts;
  const pattern = /"([\w-]{10,})",\["https?:[^"]+",\d+,\d+\],\["(https?:[^"]+)",(\d+),(\d+)\]/g;
  for (; scannedScripts < scripts.length; scannedScripts++) {
    for (const m of scripts[scannedScripts].textContent.matchAll(pattern)) {
      images.set(m[1], { url: JSON.parse('"' + m[2] + '"'), height: Number(m[3]), width: Number(m[4]) });
    }
  }
}

function tiles() {
  return document.querySelectorAll('[data-docid][data-lpage]');
}

GM_addStyle(`
  [data-usermods-tile] { position: relative; }
  a.usermods-direct { position: absolute; top: 6px; right: 6px; z-index: 2; padding: 2px 8px; border-radius: 4px;
    background: rgba(0, 0, 0, 0.75); color: #fff !important; font: 12px/18px Arial, sans-serif; text-decoration: none; }
  a.usermods-direct:hover { background: #000; text-decoration: underline; }
`);

function addLinks() {
  for (const tile of tiles()) {
    if (tile.querySelector('a.usermods-direct')) continue;
    let image = images.get(tile.dataset.docid);
    if (!image) {
      scanScripts();
      image = images.get(tile.dataset.docid);
      if (!image) continue;
    }
    const a = document.createElement('a');
    a.className = 'usermods-direct';
    a.href = image.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Full image';
    a.title = image.url;
    // Keep Google's preview panel from opening when the link is clicked.
    a.addEventListener('click', (e) => e.stopPropagation());
    tile.setAttribute('data-usermods-tile', '');
    tile.append(a);
  }
}

scanScripts();
addLinks();
new MutationObserver(addLinks).observe(document.body, { childList: true, subtree: true });
