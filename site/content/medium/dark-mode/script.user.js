// ==UserScript==
// @name         Use dark mode on Medium
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Shows Medium with a dark background and light text by inverting the page colours, and keeps photos and videos in their real colours.
// @match        https://medium.com/*
// @match        https://*.medium.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/medium/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/medium/dark-mode.user.js
// ==/UserScript==

// Medium's colours live in generated class names that change between builds, so the
// script doesn't recolour them one by one. It inverts the whole page instead (white
// becomes near-black, dark grey text becomes light grey) and turns the hue back so links
// and the green accents stay green. Photos, videos and embeds get the same filter a second
// time, which puts them back to their real colours.
GM_addStyle(`
  html {
    background-color: #fff !important;
    filter: invert(0.92) hue-rotate(180deg);
  }
  img, picture, video, iframe, canvas, svg image,
  [style*="background-image"] {
    filter: invert(1) hue-rotate(180deg);
  }
  /* A picture's img sits inside the picture element; invert only once. */
  picture img { filter: none; }
`);
