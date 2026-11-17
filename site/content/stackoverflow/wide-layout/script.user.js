// ==UserScript==
// @name         Make Stack Overflow full width
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Removes Stack Overflow's maximum page width so question pages use the whole window, with the sidebar kept beside the answers.
// @match        https://stackoverflow.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/stackoverflow/wide-layout.user.js
// @updateURL    https://usermods.kennethballenegger.com/stackoverflow/wide-layout.user.js
// ==/UserScript==

// The page sits in .container (capped at 1264px) and the main area in #content (capped
// at 1100px). Lifting both caps lets the question column (#mainbar) grow, because its
// width is the content width minus the sidebar. The sidebar keeps its own width.
GM_addStyle(`
  body > .container,
  #content {
    max-width: none !important;
  }
  #mainbar {
    width: calc(100% - 300px - 24px) !important;
  }
`);
