// ==UserScript==
// @name         Use dark mode on weather.com
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Gives weather.com a dark background with light text while keeping maps, photos and video as they are.
// @match        https://weather.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/weather/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/weather/dark-mode.user.js
// ==/UserScript==

// weather.com colours most blocks with fixed utility classes (bg-white, text-gray-900), so
// there is no single set of colours to swap. The script inverts the whole page and turns the
// hues back by 180 degrees: white becomes near black, dark text becomes light, and the blues,
// oranges and yellows of the charts and icons keep their hue. Images, the radar map, video
// and ad frames are inverted a second time so they look as they should.
GM_addStyle(`
  html { filter: invert(0.92) hue-rotate(180deg) !important; background: #fff !important; }
  img, video, picture, canvas, iframe, [style*="background-image"] {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  picture img, [style*="background-image"] img { filter: none !important; }
`);
