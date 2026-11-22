// ==UserScript==
// @name         Show image dimensions in Google Images
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Shows the original width and height on each Google Images result.
// @match        https://www.google.com/search*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/show-image-size.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/show-image-size.user.js
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
  .usermods-size { position: absolute; top: 6px; left: 6px; z-index: 2; padding: 1px 6px; border-radius: 4px;
    background: rgba(0, 0, 0, 0.75); color: #fff; font: 12px/18px Arial, sans-serif; pointer-events: none; }
`);

function addSizes() {
  for (const tile of tiles()) {
    if (tile.querySelector('.usermods-size')) continue;
    let image = images.get(tile.dataset.docid);
    if (!image) {
      scanScripts();
      image = images.get(tile.dataset.docid);
      if (!image) continue;
    }
    const label = document.createElement('span');
    label.className = 'usermods-size';
    label.textContent = image.width + ' × ' + image.height;
    tile.setAttribute('data-usermods-tile', '');
    tile.append(label);
  }
}

scanScripts();
addSizes();
new MutationObserver(addSizes).observe(document.body, { childList: true, subtree: true });
