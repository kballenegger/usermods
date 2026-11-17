// ==UserScript==
// @name         Use dark mode on arXiv
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Gives arXiv's abstract, listing and search pages a dark background with light text.
// @match        https://arxiv.org/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/arxiv/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/arxiv/dark-mode.user.js
// ==/UserScript==

// arXiv's pages are white with black text and ignore the browser's dark preference.
// These rules recolour the page body, the abstract box, the Labs tabs, the BibTeX pop-up and
// the footer. The dark header with the arXiv logo already suits a dark page and is left alone.
GM_addStyle(`
  html, body, main, #content, #abs-outer, blockquote.abstract, footer, .labstabs, .labstabs .tab,
  .bib-modal-content, .bib-citation-content, .arxiv-result, .box, .card, .message,
  input, textarea, select, table, tr, td, th {
    background-color: #17181b !important;
  }

  body, #content, #content *, footer, footer *, main, main *, .bib-modal-content,
  .bib-modal-content *, input, textarea, select {
    color: #d6d6d6 !important;
    border-color: #3a3c40 !important;
  }

  #content a, #content a *, footer a, main a, .bib-modal-content a { color: #8ab4f8 !important; }
  #content a:visited, main a:visited { color: #c6a6f2 !important; }

  /* Secondary text (dates, subject lines, descriptors) stays a step dimmer than the body. */
  #content .dateline, #content .descriptor, #content .primary-subject, #content .list-subjects,
  #content .list-identifier, main .is-size-7, main .has-text-grey-dark {
    color: #a3a3a3 !important;
  }

  /* The breadcrumb bar under the header and the Labs toggle panel have light backgrounds. */
  .subheader { background-color: #222428 !important; }
  .labstabs .toggle { background-color: #1e2125 !important; }
  .labstabs .slider { background-color: #4a4d52 !important; }

  /* The Labs tab strip uses light grey label backgrounds. */
  .labstabs > label { background-color: #26282c !important; }
  .labstabs input:checked + label { background-color: #17181b !important; }
`);
