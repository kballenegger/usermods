// ==UserScript==
// @name         Open Kick in theatre mode
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Switches the Kick player to theatre mode when a stream or VOD opens.
// @match        https://kick.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/kick/theater-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/kick/theater-mode.user.js
// ==/UserScript==

// Kick keeps theatre mode in page state only, so every new page opens in the normal layout.
// Kick's own shortcut for theatre mode is the T key, handled on the document. Once per page,
// when the video is playing and theatre mode is off, the script sends that key press.
// Kick ignores the shortcut while its "mature viewers" notice covers the player, so the
// script waits until that notice is gone. If you leave theatre mode with T or the player
// button, it stays off until you open another stream or video.
let donePath = null;

function apply() {
  if (location.pathname === donePath) return;
  const layout = document.querySelector('[data-theatre]');
  const video = document.querySelector('#video-player');
  if (!layout || !video || video.readyState < 2) return;
  if (document.querySelector('[data-testid="mature"]')) return;
  donePath = location.pathname;
  if (layout.dataset.theatre === 'false') {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true }));
  }
}

new MutationObserver(apply).observe(document, { childList: true, subtree: true });
document.addEventListener('playing', apply, true);
