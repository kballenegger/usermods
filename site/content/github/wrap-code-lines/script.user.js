// ==UserScript==
// @name         Wrap long lines in GitHub code views
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Wraps long lines in code blocks in GitHub READMEs, markdown files, issues and comments instead of scrolling them sideways.
// @match        https://github.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/github/wrap-code-lines.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/wrap-code-lines.user.js
// ==/UserScript==

// Fenced code blocks in rendered markdown are <pre> elements inside .markdown-body, with or
// without a .highlight wrapper for syntax colouring. GitHub sets them to white-space: pre and
// overflow: auto, so long lines scroll sideways. pre-wrap keeps indentation and line breaks
// and wraps the rest; overflow-wrap: anywhere breaks long URLs and tokens that have no spaces.
// The file view (blob pages) is left alone: it has its own Wrap lines switch.
GM_addStyle(`
  .markdown-body pre,
  .markdown-body pre code {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
  }
`);
