// ==UserScript==
// @name         Open full-size Instagram images
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Removes the invisible layer Instagram puts over photos, so right-click "Open image in new tab" and "Save image as" work on the full-size image.
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/instagram/open-full-size-image.user.js
// @updateURL    https://usermods.kennethballenegger.com/instagram/open-full-size-image.user.js
// ==/UserScript==

// On a post page Instagram already loads the photo at full size, but it lays an empty <div>
// over it, so a right-click lands on that layer and the browser offers no image options.
// The script finds empty layers sitting on top of large photos and lets clicks through
// them. Layers that hold something (carousel arrows, tags, buttons) are left alone.
GM_addStyle('[data-usermods-image-cover] { pointer-events: none !important; }');

function uncover(img) {
  const box = img.getBoundingClientRect();
  // Small images (avatars, icons) and photos off screen are skipped; the latter are
  // handled when they scroll in.
  if (box.width < 200 || box.bottom < 0 || box.top > innerHeight) return;
  const x = box.left + box.width / 2;
  for (const el of document.elementsFromPoint(x, (Math.max(box.top, 0) + Math.min(box.bottom, innerHeight)) / 2)) {
    if (el === img || el.contains(img)) break;
    if (el.childElementCount > 0 || el.textContent.trim() !== '') break;
    el.setAttribute('data-usermods-image-cover', '');
  }
}

// Instagram loads photos as you scroll and swaps them in carousels, so photos are looked at
// again after each batch of changes and after scrolling, at most once a frame.
let queued = false;
function update() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    document.querySelectorAll('img').forEach(uncover);
  });
}
new MutationObserver(update).observe(document, { childList: true, subtree: true });
addEventListener('scroll', update, { capture: true, passive: true });
addEventListener('resize', update);
