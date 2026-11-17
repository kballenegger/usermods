// ==UserScript==
// @name         Hide 'People also ask' in Google Search
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the People also ask box of expandable questions in Google Search results.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/hide-people-also-ask.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/hide-people-also-ask.user.js
// ==/UserScript==

// The box has no stable id, so it is found by its heading text ("People also ask",
// English interface). Each block in Google's results list carries a data-rpos attribute;
// the script hides the block that holds the heading. The box often loads after the rest
// of the page, so a MutationObserver checks again on every change.
GM_addStyle('[data-usermods-hidden="paa"] { display: none !important; }');

function hidePeopleAlsoAsk() {
  for (const heading of document.querySelectorAll('[role="heading"]')) {
    if (heading.textContent.trim() !== 'People also ask') continue;
    const block = heading.closest('[data-rpos]');
    if (block && block.dataset.usermodsHidden !== 'paa') block.dataset.usermodsHidden = 'paa';
  }
}

new MutationObserver(hidePeopleAlsoAsk).observe(document, { childList: true, subtree: true });
