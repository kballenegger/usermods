// ==UserScript==
// @name         Declutter DuckDuckGo search results
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides DuckDuckGo's header slogan, the Private badge, the Share Feedback button and the "Was this helpful?" prompts.
// @match        https://duckduckgo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/duckduckgo/declutter.user.js
// @updateURL    https://usermods.kennethballenegger.com/duckduckgo/declutter.user.js
// ==/UserScript==

// DuckDuckGo's class names are generated, so these rules use the test ids and links it keeps
// stable: the slogan links to /compare-privacy, and the badge and feedback prompts carry
// data-testid attributes. Results, tabs, filters and the search box are left alone.
GM_addStyle(`
  /* "Protection. Privacy. Peace of mind." in the header */
  .header--aside__item:has(> a[href="/compare-privacy"]),
  /* the green "Private" badge above the results */
  [data-testid="privacy-reminder"],
  /* the floating "Share Feedback" button */
  [data-testid="floating-feedback-prompt"],
  /* "Was this helpful?" under answer boxes and modules */
  [data-testid="feedback-prompt"] {
    display: none !important;
  }
`);
