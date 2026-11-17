// ==UserScript==
// @name         Show the review percentage on Steam
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Shows the positive review percentage next to the review summary on Steam store game pages, without hovering.
// @match        https://store.steampowered.com/app/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/steam/review-percentage.user.js
// @updateURL    https://usermods.kennethballenegger.com/steam/review-percentage.user.js
// ==/UserScript==

// Each review summary row ("Recent Reviews", "All Reviews") carries its percentage in a
// tooltip: data-tooltip-html="96% of the 249,565 user reviews ... are positive".
// The script copies that number next to the summary word ("Overwhelmingly Positive").
for (const row of document.querySelectorAll('.user_reviews_summary_row[data-tooltip-html]')) {
  const pct = row.getAttribute('data-tooltip-html').match(/^\s*(\d+)%/)?.[1];
  const summary = row.querySelector('.game_review_summary');
  if (!pct || !summary || row.querySelector('.um-review-pct')) continue;
  const tag = document.createElement('span');
  tag.className = 'um-review-pct';
  tag.textContent = ` ${pct}%`;
  tag.style.fontWeight = 'bold';
  tag.style.color = getComputedStyle(summary).color; // same blue/orange/red as the summary
  summary.after(tag);
  // The summary column cuts overflowing text with an ellipsis; let it wrap instead so the
  // review count stays readable.
  const column = row.querySelector('.summary');
  if (column) column.style.whiteSpace = 'normal';
}
