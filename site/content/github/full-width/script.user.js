// ==UserScript==
// @name         Make GitHub pages full width
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Removes GitHub's maximum page width so repository pages, issue and pull request lists and pull requests use the whole window.
// @match        https://github.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/github/full-width.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/full-width.user.js
// ==/UserScript==

// GitHub caps its pages at 1280px (.container-xl) and the main column at 1012px. Newer
// pages use Primer's PageLayout, whose class names end in a build hash
// ("prc-PageLayout-Content-xWL-A"), so those are matched by their stable prefix.
// README and comment text (.markdown-body) keep their own width so lines stay readable.
GM_addStyle(`
  .container-xl,
  .container-lg:not(.markdown-body),
  [class*="prc-PageLayout-PageLayoutRoot"],
  [class*="prc-PageLayout-ContentWrapper"],
  [class*="prc-PageLayout-Content-"],
  [class*="HeaderInner__"] {
    max-width: none !important;
  }
`);
