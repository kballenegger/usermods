// ==UserScript==
// @name         Select text on Medium without the highlight menu
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the Highlight and Share menu that pops up over text you select on Medium, so selecting and copying works without it.
// @match        https://medium.com/*
// @match        https://*.medium.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/medium/enable-text-selection.user.js
// @updateURL    https://usermods.kennethballenegger.com/medium/enable-text-selection.user.js
// ==/UserScript==

// When you select text, Medium opens a floating toolbar labelled "Selection actions"
// (Highlight, Share, and Respond when signed in) inside a positioned popup. The rules hide
// the popup that holds that toolbar and the toolbar itself. The selection is untouched, so
// copying with the keyboard or the right-click menu works as usual.
GM_addStyle(`
  [data-popper-placement]:has([role="toolbar"][aria-label="Selection actions"]),
  [role="toolbar"][aria-label="Selection actions"] {
    display: none !important;
  }
`);
