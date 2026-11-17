// ==UserScript==
// @name         Load every image in an Imgur album
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Presses Imgur's "Load more images" button whenever it appears, so long posts and albums keep loading as you scroll.
// @match        https://imgur.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/imgur/load-all-images.user.js
// @updateURL    https://usermods.kennethballenegger.com/imgur/load-all-images.user.js
// ==/UserScript==

(() => {
  // Imgur shows the first few images of a long post, then a "Load 12 more images" button
  // with the class loadMore. Long posts get a new button after every batch, and Imgur only
  // keeps the images near the screen in the page, so the next button appears as you
  // scroll towards it. Whenever one is on the page, press it. The "Load more comments"
  // button uses the same class, so only buttons whose text mentions images are pressed.
  // A plain element.click() is ignored by Imgur's handler, so the script sends the full
  // pointer and mouse sequence a real click produces.
  const press = (btn) => {
    const o = { bubbles: true, cancelable: true, view: window, button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', o));
    btn.dispatchEvent(new MouseEvent('mousedown', o));
    btn.dispatchEvent(new PointerEvent('pointerup', o));
    btn.dispatchEvent(new MouseEvent('mouseup', o));
    btn.dispatchEvent(new MouseEvent('click', o));
  };
  let queued = false;
  const expand = () => {
    if (queued) return;
    queued = true;
    // Wait a frame so the click lands after Imgur has finished rendering the button.
    requestAnimationFrame(() => {
      queued = false;
      for (const btn of document.querySelectorAll('.Gallery button.loadMore')) {
        if (/more image/i.test(btn.textContent)) press(btn);
      }
    });
  };
  // Observe the document itself: at document-start the <html> element may not exist yet.
  // Imgur is a single-page app, so this keeps working as you open other posts.
  new MutationObserver(expand).observe(document, { childList: true, subtree: true });
})();
