// ==UserScript==
// @name         Show card numbers in Trello
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Shows each Trello card's number (#123) in front of its title on the board.
// @match        https://trello.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/trello/show-card-numbers.user.js
// @updateURL    https://usermods.kennethballenegger.com/trello/show-card-numbers.user.js
// ==/UserScript==

// Trello keeps a card's number in its link: /c/<id>/<number>-<title>. The script reads it
// from each card title link and puts "#<number>" in front of the title.
GM_addStyle(`
  .usermods-card-number {
    margin-right: 4px;
    font-weight: 600;
    opacity: 0.7;
  }
`);

function numberCards() {
  // Trello swaps a card's title link for a new one as it finishes drawing; drop labels
  // whose link has gone so a card never shows its number twice.
  for (const tag of document.querySelectorAll('.usermods-card-number')) {
    const next = tag.nextElementSibling;
    if (!next || !next.matches('a[data-testid="card-name"]')) tag.remove();
  }
  for (const link of document.querySelectorAll('a[data-testid="card-name"][href*="/c/"]')) {
    const match = link.getAttribute('href').match(/\/c\/[^/]+\/(\d+)-/);
    if (!match) continue;
    const label = `#${match[1]}`;
    let tag = link.previousElementSibling;
    if (!tag || !tag.classList.contains('usermods-card-number')) {
      tag = document.createElement('span');
      tag.className = 'usermods-card-number';
      link.before(tag);
    }
    if (tag.textContent !== label) tag.textContent = label;
  }
}

// Cards are drawn, moved and redrawn while you use the board, so re-check on every change.
new MutationObserver(numberCards).observe(document.body, { childList: true, subtree: true });
numberCards();
