// ==UserScript==
// @name         Hide AI answers on DuckDuckGo
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Hides the Search Assist AI answer box, the Explore More AI answers and the Search Assist and Ask Duck.ai buttons on DuckDuckGo results.
// @match        https://duckduckgo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/duckduckgo/hide-ai.user.js
// @updateURL    https://usermods.kennethballenegger.com/duckduckgo/hide-ai.user.js
// ==/UserScript==

// DuckDuckGo's class names are generated, so the script keys on data attributes and links:
// - the Search Assist answer sits in a list item that contains
//   [data-testid="duckassist-answer-content"]. DuckDuckGo moves it between the top of the
//   results, further down and the right-hand column, and the item does not always carry
//   data-layout, so the rule only asks for an li around the answer;
// - the "Search Assist" button above the results carries data-assist-icon-trigger;
// - the "Ask Duck.ai" button links to the same search with ia=chat;
// - the "Explore More" box of AI-written follow-up answers is li[data-layout="explore_more"].
// CSS applies to rows added later too, so no observer is needed.
GM_addStyle(`
  li:has([data-testid="duckassist-answer-content"]),
  #react-duckbar li:has([data-assist-icon-trigger]),
  #react-duckbar li:has(a[href*="ia=chat"]),
  li[data-layout="explore_more"] {
    display: none !important;
  }
`);
