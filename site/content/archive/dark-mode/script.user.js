// ==UserScript==
// @name         Use dark mode on archive.org
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Gives archive.org item pages a dark background with light text, keeping images, the book reader and the top bar as they are.
// @match        https://archive.org/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/archive/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/archive/dark-mode.user.js
// ==/UserScript==

// The script inverts the whole page (white becomes near-black, dark text becomes light)
// and turns the hue back so link colours stay close to the originals. Parts that are
// already dark (the top bar and the black viewer area that holds the book reader or
// player) and media such as images and videos get the same filter again, which puts them
// back as they were. Media inside those parts are skipped so they aren't flipped twice.
GM_addStyle(`
  html {
    background-color: #fff !important;
    filter: invert(0.92) hue-rotate(180deg);
  }
  #topnav, #theatre-ia-wrap,
  :is(img, picture, video, iframe, canvas):not(#topnav *, #theatre-ia-wrap *, picture img) {
    filter: invert(1) hue-rotate(180deg);
  }
`);
