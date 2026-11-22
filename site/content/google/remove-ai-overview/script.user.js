// ==UserScript==
// @name         Remove the AI Overview from Google Search
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Hides the AI Overview block at the top of Google Search results, including when it loads after the page.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/remove-ai-overview.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/remove-ai-overview.user.js
// ==/UserScript==

// Google's class names for the AI Overview change often, so the block is found by its
// heading text ("AI Overview", English interface). From the heading the script climbs to
// the largest block that does not also hold the organic results (#rso, #center_col,
// #botstuff), and hides that. The page is still loading while this runs, so the blocks are
// worked out again on every change and marks that no longer fit are taken off.
GM_addStyle('[data-usermods-hidden="ai-overview"] { display: none !important; }');

const RESULTS = '#rso, #center_col, #botstuff';

function holdsResults(el) {
  return el.matches(RESULTS) || el.querySelector(RESULTS) !== null;
}

function hideOverviews() {
  const blocks = new Set();
  for (const heading of document.querySelectorAll('[role="heading"]')) {
    if (heading.textContent.trim() !== 'AI Overview') continue;
    let block = heading;
    while (block.parentElement && block.parentElement !== document.body && !holdsResults(block.parentElement)) {
      block = block.parentElement;
    }
    blocks.add(block);
  }
  for (const el of document.querySelectorAll('[data-usermods-hidden="ai-overview"]')) {
    if (!blocks.has(el)) el.removeAttribute('data-usermods-hidden');
  }
  for (const el of blocks) el.setAttribute('data-usermods-hidden', 'ai-overview');
}

new MutationObserver(hideOverviews).observe(document, { childList: true, subtree: true });
