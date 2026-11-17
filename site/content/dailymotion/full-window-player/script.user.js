// ==UserScript==
// @name         Make the Dailymotion player fill the window
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Stretches the Dailymotion video player over the whole browser window on video pages. Press W to switch back and forth.
// @match        https://www.dailymotion.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/dailymotion/full-window-player.user.js
// @updateURL    https://usermods.kennethballenegger.com/dailymotion/full-window-player.user.js
// ==/UserScript==

// Dailymotion keeps the player in a fixed-position #player-wrapper and moves it over a
// placeholder with inline top/left/width/height. !important rules beat those inline values,
// so the player covers the window and the iframe inside scales with it.
GM_addStyle(`
  html.um-full-window #player-wrapper {
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    z-index: 2147483000 !important;
    border-radius: 0 !important;
    background: #000 !important;
  }
`);

let enabled = true;

// Only video pages get the big player. The site changes pages without a reload, so the
// class is recomputed whenever the DOM changes.
const apply = () => {
  const on = enabled && location.pathname.startsWith('/video/');
  document.documentElement.classList.toggle('um-full-window', on);
};
apply();
new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });

// W switches between the full-window player and the normal page, except while typing.
// Keys pressed while the player itself has focus go to the player, not to this page.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'w' && e.key !== 'W') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  enabled = !enabled;
  apply();
});
