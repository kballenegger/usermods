// ==UserScript==
// @name         Dark mode for Google Maps
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Gives Google Maps on desktop a dark theme by inverting the page colours, keeping photos in their real colours.
// @match        https://www.google.com/maps*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google-maps/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/google-maps/dark-mode.user.js
// ==/UserScript==

// The map is drawn on a canvas, so its colours can't be restyled one by one. Instead the
// whole page is inverted, and hue-rotate(180deg) turns the inverted hues back around so
// water stays blue and parks stay green. Photos (place pictures, Street View thumbnails)
// get the same filter a second time, which cancels it out and shows them as they are.
GM_addStyle(`
  html {
    filter: invert(1) hue-rotate(180deg);
    background: #fff;
  }
  img, video {
    filter: invert(1) hue-rotate(180deg);
  }
`);
