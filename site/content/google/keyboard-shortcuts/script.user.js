// ==UserScript==
// @name         Add keyboard shortcuts to Google Search results
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Press j and k to move between Google Search results and Enter to open one.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/keyboard-shortcuts.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/keyboard-shortcuts.user.js
// ==/UserScript==

// j moves to the next result, k to the previous one, Enter opens it (Enter on a focused
// link is the browser's own behaviour). Keys typed into the search box or any other text
// field are left alone, as are keys pressed with Ctrl, Cmd or Alt.
GM_addStyle(`
  #rso a[data-usermods-current] { outline: 2px solid #1a73e8; outline-offset: 4px; border-radius: 4px; }
`);

function results() {
  return [...document.querySelectorAll('#rso a[href]:has(h3)')].filter(
    (a) => a.checkVisibility() && !a.closest('[data-text-ad]'),
  );
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== 'j' && e.key !== 'k') return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  const links = results();
  if (links.length === 0) return;
  const i = links.indexOf(document.activeElement);
  const next = e.key === 'j' ? Math.min(i + 1, links.length - 1) : Math.max(i - 1, 0);
  document.querySelector('#rso a[data-usermods-current]')?.removeAttribute('data-usermods-current');
  links[next].setAttribute('data-usermods-current', '');
  links[next].focus();
  links[next].scrollIntoView({ block: 'center' });
  e.preventDefault();
}, true);
