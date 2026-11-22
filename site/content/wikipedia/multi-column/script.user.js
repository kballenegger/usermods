// ==UserScript==
// @name         Read Wikipedia in columns
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Lays out Wikipedia article text in newspaper-style columns, one set per section, with images and tables kept whole.
// @match        https://*.wikipedia.org/wiki/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/wikipedia/multi-column.user.js
// @updateURL    https://usermods.kennethballenegger.com/wikipedia/multi-column.user.js
// ==/UserScript==

// Wikipedia wraps each top-level section of an article in a <section> element, with the
// heading as its first child. Each one becomes its own set of columns, so you read down a
// few short columns per section instead of scrolling back up a long one.
// The column count follows the width: each column is at least 22em wide, so the standard
// width gets two and Wikipedia's "Wide" setting on a large screen gets three or more.
GM_addStyle(`
  #mw-content-text > .mw-parser-output > section {
    column-width: 22em;
    column-gap: 2.5em;
    column-rule: 1px solid var(--border-color-subtle, #c8ccd1);
  }
  /* The section heading and navigation boxes run across all columns. */
  #mw-content-text > .mw-parser-output > section > .mw-heading2,
  #mw-content-text > .mw-parser-output > section > h2,
  #mw-content-text > .mw-parser-output > section > .navbox,
  #mw-content-text > .mw-parser-output > section > .navbox-styles ~ .navbox { column-span: all; }
  /* Infoboxes, images and tables stay in one piece inside a column instead of floating. */
  #mw-content-text .mw-parser-output section > .infobox,
  #mw-content-text .mw-parser-output section > figure,
  #mw-content-text .mw-parser-output section > .thumb,
  #mw-content-text .mw-parser-output section > table,
  #mw-content-text .mw-parser-output section > .side-box {
    float: none !important; clear: none !important;
    margin: 0 auto 1em !important; max-width: 100% !important;
    break-inside: avoid;
  }
  #mw-content-text .mw-parser-output section > table:not(.infobox) { display: block; overflow-x: auto; width: auto !important; }
  #mw-content-text .mw-parser-output section p, #mw-content-text .mw-parser-output section li { orphans: 2; widows: 2; }
`);
