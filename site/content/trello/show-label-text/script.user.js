// ==UserScript==
// @name         Show label names on Trello cards
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Always shows the names of labels on Trello cards instead of thin coloured bars.
// @match        https://trello.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/trello/show-label-text.user.js
// @updateURL    https://usermods.kennethballenegger.com/trello/show-label-text.user.js
// ==/UserScript==

// Trello already has a switch for this: clicking any label on a card toggles every label
// between a coloured bar and a pill with its name, and Trello stores the choice in this
// browser's localStorage under "labelState" as {"showText":true}. The script turns that
// switch on before Trello reads it, on every page load, so new browsers, private windows
// and cleared storage start with label names showing. Trello then draws the labels itself.
(() => {
  let state = {};
  try {
    state = JSON.parse(localStorage.getItem('labelState') || '{}') || {};
  } catch {
    // An unreadable value is replaced below.
  }
  if (state.showText !== true) {
    localStorage.setItem('labelState', JSON.stringify({ ...state, showText: true }));
  }
})();
