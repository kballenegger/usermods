// ==UserScript==
// @name         Turn off SafeSearch on Bing
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds adlt=off to Bing web, image and video searches so SafeSearch is off without an account or cookie.
// @match        https://www.bing.com/search*
// @match        https://www.bing.com/images/search*
// @match        https://www.bing.com/videos/search*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/bing/disable-safe-search.user.js
// @updateURL    https://usermods.kennethballenegger.com/bing/disable-safe-search.user.js
// ==/UserScript==

// Bing reads the SafeSearch level from the adlt URL parameter before its cookie. If the
// parameter is missing or set to anything but "off", reload the same search with adlt=off.
// Bing then carries adlt=off into its own filter, tab and page links.
(() => {
  const url = new URL(location.href);
  if (url.searchParams.get('adlt') === 'off') return;
  url.searchParams.set('adlt', 'off');
  location.replace(url.href);
})();
