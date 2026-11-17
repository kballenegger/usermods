// ==UserScript==
// @name         Like YouTube videos with a keyboard shortcut
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Press Shift+L on a YouTube video page to press the video's like button.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/like-keyboard-shortcut.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/like-keyboard-shortcut.user.js
// ==/UserScript==

// Shift+L clicks the like button under the video, the same as clicking it with the mouse,
// so pressing it again removes the like. YouTube has no Shift+L shortcut of its own; the
// script stops the key from reaching YouTube so it doesn't also skip ahead 10 seconds
// (plain L). Keys typed into the search box, a comment field or any other text field are
// left alone. Signed out, YouTube answers the click with its "Sign in" prompt.
function isTyping(target) {
  return target instanceof Element && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable]'));
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyL' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
  if (location.pathname !== '/watch' || isTyping(e.target)) return;
  const like = document.querySelector('ytd-watch-metadata like-button-view-model button');
  if (!like) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  like.click();
}, true);
