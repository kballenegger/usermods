// ==UserScript==
// @name         Hide chat on Kick
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the chat column on Kick streams and VODs and gives the player the space.
// @match        https://kick.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/kick/hide-chat.user.js
// @updateURL    https://usermods.kennethballenegger.com/kick/hide-chat.user.js
// ==/UserScript==

// The chat column has a fixed id, #channel-chatroom. The rule hides it and the wrappers
// around it that hold nothing else, so the player column grows to fill the width. Live chat
// and VOD chat replay both use this id; the wrappers differ between the two page types, and
// :not(:has(#video-player)) keeps the rule off any wrapper that also holds the player.
GM_addStyle(`
  #channel-chatroom,
  div:has(> #channel-chatroom):not(:has(#video-player)),
  div:has(> div > #channel-chatroom):not(:has(#video-player)) { display: none !important; }
`);
