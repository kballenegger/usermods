// ==UserScript==
// @name         Hide the AI Mode button in Google Search
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the AI Mode tab from the row of tabs above Google Search results.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/hide-ai-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/hide-ai-mode.user.js
// ==/UserScript==

// The AI Mode tab is a link to the same search with udm=50. Matching the link target
// rather than its label keeps this working in any interface language. The tab's list
// item is hidden too, so no gap is left in the tab row.
GM_addStyle(`
  [role="listitem"]:has(a[href*="udm=50"]),
  a[href*="udm=50"] { display: none !important; }
`);
