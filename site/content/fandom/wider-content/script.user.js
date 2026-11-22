// ==UserScript==
// @name         Widen the content area on Fandom
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Lets Fandom articles fill the browser window: removes the page width cap and moves the right rail out of the way.
// @match        https://*.fandom.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/fandom/wider-content.user.js
// @updateURL    https://usermods.kennethballenegger.com/fandom/wider-content.user.js
// ==/UserScript==

GM_addStyle(`
  /* The page is capped at a fixed width, wider only in Fandom's "Expand" mode. */
  .resizable-container {
    max-width: none !important;
    width: auto !important;
    /* Leave room on the left for the page tools (Expand, contents, save), which sit
       just outside the article's left edge. */
    margin-left: 56px !important;
    margin-right: 16px !important;
  }

  /* The right rail (ads, "Popular pages") takes a third of the row next to the article. */
  .page__right-rail {
    display: none !important;
  }

  .page__main {
    width: auto !important;
    max-width: none !important;
    flex: 1 1 auto !important;
  }
`);
