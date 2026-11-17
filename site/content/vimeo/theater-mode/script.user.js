// ==UserScript==
// @name         Make the Vimeo player fill the window
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Lets the player on Vimeo video pages grow to the full height of the window below the header, so the video is as large as the window allows without going full screen.
// @match        https://vimeo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/vimeo/theater-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/vimeo/theater-mode.user.js
// ==/UserScript==

// Vimeo caps the player area at a fixed share of the window height, which leaves wide bands on
// each side of a 16:9 video on most laptop screens. The player itself has the stable classes
// "player vh-player-area"; the two boxes around it that carry the cap have generated class
// names, so they are found by their position above the player. 88px leaves room for the
// site header above the player.
GM_addStyle(`
  div:has(> .vh-player-area),
  div:has(> div > .vh-player-area) {
    max-height: calc(100vh - 88px) !important;
  }
  div:has(> div > .vh-player-area) {
    height: calc(100vh - 88px) !important;
  }
`);
