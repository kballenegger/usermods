// ==UserScript==
// @name         Show Wikipedia footnotes inline
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Clicking a footnote number on Wikipedia opens the note right there in the text instead of jumping to the bottom. Click again to close it.
// @match        https://*.wikipedia.org/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/wikipedia/inline-footnotes.user.js
// @updateURL    https://usermods.kennethballenegger.com/wikipedia/inline-footnotes.user.js
// ==/UserScript==

// The colours come from Wikipedia's own CSS variables, so the notes follow its dark mode.
GM_addStyle(`
  .um-inline-note {
    font-size: 0.875em; line-height: 1.5;
    color: var(--color-base, #202122);
    background: var(--background-color-interactive-subtle, #f8f9fa);
    border: 1px solid var(--border-color-subtle, #c8ccd1); border-radius: 2px;
    padding: 1px 6px; margin: 0 2px;
  }
`);

// One listener on the document, in the capture phase, so it sees clicks on footnotes in
// content that loads later and gets them before the page scrolls to the reference list.
document.addEventListener('click', (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.('sup.reference > a[href^="#cite_note"]');
  if (!link) return;
  const sup = link.parentElement;

  event.preventDefault();
  event.stopPropagation();

  // A second click on the same footnote closes it.
  if (sup.nextElementSibling?.classList.contains('um-inline-note')) {
    sup.nextElementSibling.remove();
    return;
  }

  const note = document.getElementById(decodeURIComponent(link.hash.slice(1)));
  const text = note?.querySelector('.reference-text');
  if (!text) return;

  const box = document.createElement('span');
  box.className = 'um-inline-note';
  box.append(...[...text.childNodes].map((n) => n.cloneNode(true)));
  // Copies must not repeat the ids of the original reference list.
  for (const el of box.querySelectorAll('[id]')) el.removeAttribute('id');
  sup.after(box);
}, true);
