// ==UserScript==
// @name         Always use Google's Web results (udm=14)
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Sends every Google search to the Web tab (udm=14): plain links without the AI Overview.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/google/web-results-only.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/web-results-only.user.js
// ==/UserScript==

// The Web tab is the same search with udm=14 in the address. A search that names no
// tab (no udm or tbm parameter) is reloaded with udm=14 before Google draws anything.
// Searches on other tabs (Images, News, Videos) carry their own parameter and are left alone.
const url = new URL(location.href);
if (url.pathname === '/search' && !url.searchParams.has('udm') && !url.searchParams.has('tbm')) {
  url.searchParams.set('udm', '14');
  location.replace(url.href);
}
