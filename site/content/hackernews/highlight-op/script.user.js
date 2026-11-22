// ==UserScript==
// @name         Highlight the original poster on Hacker News
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Marks comments written by the story's submitter on Hacker News with an OP label and a coloured bar.
// @match        https://news.ycombinator.com/item*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/highlight-op.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/highlight-op.user.js
// ==/UserScript==

GM_addStyle(`
  .um-op-name { background: #ff6600; color: #fff !important; padding: 0 3px; border-radius: 2px; }
  .um-op-label { margin-left: 4px; font-weight: bold; color: #ff6600; }
  tr.comtr.um-op .comment { border-left: 3px solid #ff6600; padding-left: 6px; }
`);

// The submitter is the user link in the story's subline ("by dhouston"). On a page for a
// single comment there is no story subline, so there is nothing to compare against.
const opLink = document.querySelector('.fatitem .subline a[href^="user?id="]');
if (opLink) {
  const op = opLink.getAttribute('href');
  for (const row of document.querySelectorAll('tr.athing.comtr')) {
    const user = row.querySelector('.comhead > a[href^="user?id="]');
    if (!user || user.getAttribute('href') !== op) continue;
    row.classList.add('um-op');
    user.classList.add('um-op-name');
    const label = document.createElement('span');
    label.className = 'um-op-label';
    label.textContent = 'OP';
    user.after(label);
  }
}
