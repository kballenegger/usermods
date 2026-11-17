// ==UserScript==
// @name         Make Trello lists wider
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Widens every list on a Trello board from 272 to 380 pixels so card titles wrap less.
// @match        https://trello.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/trello/wide-lists.user.js
// @updateURL    https://usermods.kennethballenegger.com/trello/wide-lists.user.js
// ==/UserScript==

// Change this number to pick another width, in pixels. Trello's own width is 272.
const LIST_WIDTH = 380;

// Each list is an <li data-testid="list-wrapper"> holding a [data-testid="list"] box, and
// Trello fixes the width on both. A collapsed list keeps its narrow strip: Trello's collapsed
// style wins over this one.
GM_addStyle(`
  [data-testid="list-wrapper"],
  [data-testid="list-wrapper"] > div,
  [data-testid="list"] {
    width: ${LIST_WIDTH}px !important;
    min-width: ${LIST_WIDTH}px !important;
    max-width: ${LIST_WIDTH}px !important;
  }
`);
