// ==UserScript==
// @name         Force dark mode on Google Search
// @namespace    https://usermods.kennethballenegger.com
// @version      1.1.0
// @description  Shows Google Search results dark when Google serves its light theme, by inverting the page and turning images back.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/dark-mode.user.js
// ==/UserScript==

// Google picks its theme on the server, from your Google setting or your device's theme, so a
// script can't switch on Google's own dark styles. Instead this inverts the whole page and
// rotates the hues back, which turns the white page dark and keeps link colours close to
// normal. Pictures, video and maps are inverted a second time so they look as they should.
//
// It only inverts a page Google served light. It reads the page's background colour: when
// Google's own dark theme is on, from your Google setting or your device theme, the background
// is already dark and the page is left alone.
GM_addStyle(`
  html.usermods-invert {
    filter: invert(1) hue-rotate(180deg) !important;
    background: #fff !important;
  }
  html.usermods-invert :is(img, video, canvas, picture, g-img, [style*="background-image"]) {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  /* An image inside an element that was already turned back would be inverted again. */
  html.usermods-invert :is([style*="background-image"] img, picture img, g-img img) {
    filter: none !important;
  }
`);

function update() {
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
  document.documentElement.classList.toggle('usermods-invert', (r + g + b) / 3 > 128);
}

// Check as soon as <body> exists, again once the page has parsed, and whenever the device
// theme changes, since Google's "Device default" theme follows it live.
if (document.body) {
  update();
} else {
  const waitForBody = new MutationObserver(() => {
    if (!document.body) return;
    waitForBody.disconnect();
    update();
  });
  waitForBody.observe(document.documentElement, { childList: true });
}
document.addEventListener('DOMContentLoaded', update);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
