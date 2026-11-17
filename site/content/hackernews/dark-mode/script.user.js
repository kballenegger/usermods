// ==UserScript==
// @name         Use dark mode on Hacker News
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Gives Hacker News a dark background with light text, keeping the orange header bar.
// @match        https://news.ycombinator.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/dark-mode.user.js
// ==/UserScript==

// Hacker News sets its beige background with a bgcolor attribute on the #hnmain table and
// its text colours in news.css. CSS rules override both. The orange header row keeps its colour.
GM_addStyle(`
  html, body { background-color: #161616 !important; }
  #hnmain { background-color: #1f1f1f !important; }
  body, td, .commtext, .admin td { color: #dcdcdc !important; }

  .titleline > a:link, .pagetop a, .fatitem .titleline > a { color: #ececec !important; }
  .titleline > a:visited { color: #9a9a9a !important; }
  .pagetop, .pagetop a { color: #000 !important; }

  .rank, .subtext, .subtext a, .subline, .subline a, .comhead, .comhead a, .sitebit, .sitestr,
  .yclinks a, .hnmore a, .morelink, .navs, .togg { color: #9a9a9a !important; }

  .commtext a, .toptext a { color: #8ab4f8 !important; }

  /* Downvoted comments fade towards the background; keep that order on a dark page. */
  .commtext.c5a, .commtext.c5A { color: #b4b4b4 !important; }
  .commtext.c73 { color: #a0a0a0 !important; }
  .commtext.c82 { color: #919191 !important; }
  .commtext.c88 { color: #868686 !important; }
  .commtext.c9c, .commtext.c9C { color: #747474 !important; }
  .commtext.cae, .commtext.cAE { color: #656565 !important; }
  .commtext.cbe, .commtext.cBE { color: #575757 !important; }
  .commtext.cce, .commtext.cCE { color: #4d4d4d !important; }
  .commtext.cdd, .commtext.cDD { color: #444 !important; }

  input, textarea, select { background-color: #2a2a2a !important; color: #dcdcdc !important; border: 1px solid #444 !important; }
  /* The vote arrows are dark grey images; brighten them so they stay visible. */
  .votearrow { filter: brightness(2.2); }
`);
