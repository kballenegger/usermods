// ==UserScript==
// @name         Turn off Vimeo autoplay of the next video
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Switches off the "Autoplay next" toggle on Vimeo video pages, so Vimeo stops at the end of a video instead of starting the next one.
// @match        https://vimeo.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/vimeo/disable-autoplay.user.js
// @updateURL    https://usermods.kennethballenegger.com/vimeo/disable-autoplay.user.js
// ==/UserScript==

// The toggle is a checkbox with the id "viewer_home_playlist_autoplay", labelled "Autoplay
// next", and it is on by default. Clicking it, rather than setting .checked,
// goes through Vimeo's own handler so the player knows. The script switches it off once per
// video page; if you switch it back on, it stays on for that video.
const ID = 'viewer_home_playlist_autoplay';
let handled = '';

function update() {
  const toggle = document.getElementById(ID);
  if (!toggle || handled === location.pathname) return;
  handled = location.pathname;
  if (toggle.checked) toggle.click();
}

new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
update();
