// ==UserScript==
// @name         Clean up the Bing homepage
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Hides the news feed, trending carousel and quiz under the Bing homepage search box, leaving the search box and background image.
// @match        https://www.bing.com/
// @match        https://www.bing.com/?*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/bing/clean-homepage.user.js
// @updateURL    https://usermods.kennethballenegger.com/bing/clean-homepage.user.js
// ==/UserScript==

// Everything below the background image (the trending news carousel, the homepage quiz and
// the MSN news and weather feed) lives in one container, #scroll_cont. The image caption bar is in it too.
// Hiding it leaves the header, the search box and the background image. The @match lines only cover the
// homepage, so search results are untouched.
GM_addStyle('#scroll_cont { display: none !important; }');
