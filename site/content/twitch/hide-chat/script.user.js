// ==UserScript==
// @name         Hide chat on Twitch
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Collapses the chat column on Twitch channel pages so the video takes its space.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/twitch/hide-chat.user.js
// @updateURL    https://usermods.kennethballenegger.com/twitch/hide-chat.user.js
// ==/UserScript==

// Hiding the chat with CSS leaves the player at its narrow width, because Twitch sizes the
// player from its own record of whether chat is open. So the script presses Twitch's own
// "Collapse Chat" button instead, once per channel page. If you open chat again with the
// chat icon, the script leaves it open until you go to another page.
let collapsedFor = null;

function collapseChat() {
  if (collapsedFor === location.pathname) return;
  if (!document.querySelector('.channel-root__right-column--expanded')) return;
  const button = document.querySelector('[data-a-target="right-column__toggle-collapse-btn"]');
  if (!button) return;
  collapsedFor = location.pathname;
  button.click();
}

new MutationObserver(collapseChat).observe(document, { childList: true, subtree: true });
