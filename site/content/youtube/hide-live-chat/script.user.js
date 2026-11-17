// ==UserScript==
// @name         Hide YouTube live chat
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the live chat panel beside YouTube live streams and premieres, and the chat replay on past streams.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/hide-live-chat.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/hide-live-chat.user.js
// ==/UserScript==

// CSS only, injected before the page renders. The chat lives in #chat-container in the
// right-hand column of the watch page; with it gone, the related videos move up.
GM_addStyle(`
  ytd-watch-flexy #chat-container,
  ytd-watch-flexy ytd-live-chat-frame {
    display: none !important;
  }
`);
