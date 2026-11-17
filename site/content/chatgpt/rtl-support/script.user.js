// ==UserScript==
// @name         Show your ChatGPT messages right to left
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Lays out your own ChatGPT messages and the message box right to left when they are written in Persian, Arabic, Hebrew or Urdu.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/chatgpt/rtl-support.user.js
// @updateURL    https://usermods.kennethballenegger.com/chatgpt/rtl-support.user.js
// ==/UserScript==

(() => {
  // ChatGPT already marks its replies dir="auto", so they flip on their own. Your messages
  // (p[data-user-message-copy]) and the message box do not, which puts punctuation and any
  // English words on the wrong side. dir="auto" lets the browser pick the direction from the
  // first strong letter, so English messages stay left to right.
  const SELECTOR = 'p[data-user-message-copy], form textarea[name="prompt"]';

  function mark() {
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (el.getAttribute('dir') !== 'auto') el.setAttribute('dir', 'auto');
    }
  }

  // New messages and a re-rendered message box can appear at any time, including after
  // in-app navigation between chats.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      mark();
    });
  }).observe(document, { childList: true, subtree: true });
})();
