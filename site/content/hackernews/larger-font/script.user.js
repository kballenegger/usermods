// ==UserScript==
// @name         Make Hacker News text bigger
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Raises the font size of Hacker News titles, metadata and comments by about a third and adds line spacing to comments.
// @match        https://news.ycombinator.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/larger-font.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/larger-font.user.js
// ==/UserScript==

// Hacker News sets fixed point sizes in news.css: 10pt for titles and body text, 9pt for
// comments, 8pt for comment headers and 7pt for the line under each story. Each one is raised
// here by about a third, so the page keeps its proportions.
GM_addStyle(`
  body, td, input, textarea, .pagetop, .title, .titleline { font-size: 13pt !important; }
  .subtext, .subline, .sitebit, .yclinks, .hnmore { font-size: 10pt !important; }
  .comhead { font-size: 10.5pt !important; }
  .comment, .commtext, .toptext { font-size: 12pt !important; line-height: 1.45 !important; }
  .reply { font-size: 10pt !important; }
`);
