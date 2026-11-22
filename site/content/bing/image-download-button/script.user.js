// ==UserScript==
// @name         Add a full-size image button to Bing Images
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Puts a "Full size" button on every Bing Images result that opens the original image file in a new tab.
// @match        https://www.bing.com/images/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/bing/image-download-button.user.js
// @updateURL    https://usermods.kennethballenegger.com/bing/image-download-button.user.js
// ==/UserScript==

// Each Bing Images thumbnail is an a.iusc whose "m" attribute holds JSON about the result.
// Its "murl" field is the address of the original image on the source site. The script adds
// a link to that address in the thumbnail's corner. Bing loads more results as you scroll,
// so a MutationObserver adds buttons to new thumbnails as they arrive.
GM_addStyle(`
  .usermods-fullsize {
    position: absolute; top: 6px; right: 6px; z-index: 10;
    padding: 3px 8px; border-radius: 4px;
    background: rgba(0, 0, 0, 0.75); color: #fff !important;
    font: 600 12px/1.4 sans-serif; text-decoration: none !important;
  }
  .usermods-fullsize:hover { background: #000; }
`);

function addButtons() {
  for (const thumb of document.querySelectorAll('a.iusc[m]')) {
    const box = thumb.parentElement;
    if (!box || box.querySelector(':scope > .usermods-fullsize')) continue;
    let url;
    try {
      url = JSON.parse(thumb.getAttribute('m')).murl;
    } catch {
      continue; // "m" is still being filled in; the next mutation retries
    }
    if (!url) continue;
    const link = document.createElement('a');
    link.className = 'usermods-fullsize';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Full size';
    link.title = 'Open the original image in a new tab';
    // Keep Bing's own click handler (which opens its image viewer) from seeing the click.
    link.addEventListener('click', (e) => e.stopPropagation());
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    box.append(link);
  }
}

new MutationObserver(addButtons).observe(document, { childList: true, subtree: true });
