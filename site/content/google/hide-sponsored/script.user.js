// ==UserScript==
// @name         Hide sponsored results in Google Search
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the text ads (Sponsored results) above, between and below Google Search results.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/hide-sponsored.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/hide-sponsored.user.js
// ==/UserScript==

// Google marks each text ad with a data-text-ad attribute. The ads sit in #tads (top),
// #bottomads (bottom) and sometimes in a block inside the results list (#rso). The rules
// hide the ad containers and any top-level result block that holds an ad, so the
// "Sponsored results" heading goes with them.
GM_addStyle(`
  #tads, #tadsb, #bottomads,
  #rso > div:has([data-text-ad]),
  [data-text-ad] { display: none !important; }
`);
