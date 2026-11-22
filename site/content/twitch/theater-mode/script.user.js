// ==UserScript==
// @name         Always open Twitch in theatre mode
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Switches the Twitch player to theatre mode each time you open a channel.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/twitch/theater-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/twitch/theater-mode.user.js
// ==/UserScript==

// The script presses the player's own Theatre Mode button when the main player
// (.persistent-player) is playing and not yet in theatre mode (.persistent-player--theatre).
// The button is found by the "alt+t" shortcut in its label, which stays the same across
// Twitch's languages. Twitch ignores the button while the player is still starting, so the
// script tries again (at most once a second) until theatre mode is on. After that it leaves
// the page alone: if you exit theatre mode, it stays off until you go to another page.
let doneFor = null;
let lastClick = 0;

function enterTheatre() {
  if (doneFor === location.pathname) return;
  const player = document.querySelector('.persistent-player');
  if (!player) return;
  if (player.classList.contains('persistent-player--theatre')) {
    doneFor = location.pathname;
    return;
  }
  const video = player.querySelector('video');
  if (!video || video.readyState < 2) return;
  const button = [...player.querySelectorAll('[data-a-target="player-controls"] button[aria-label*="alt+t" i]')]
    .find((b) => b.checkVisibility());
  if (!button || Date.now() - lastClick < 1000) return;
  lastClick = Date.now();
  button.click();
}

new MutationObserver(enterTheatre).observe(document, { childList: true, subtree: true });
