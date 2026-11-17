// ==UserScript==
// @name         Show only your languages on Wiktionary
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides every language section of a Wiktionary entry except the languages you list, with a button to show them all again.
// @match        https://en.wiktionary.org/wiki/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/wiktionary/filter-languages.user.js
// @updateURL    https://usermods.kennethballenegger.com/wiktionary/filter-languages.user.js
// ==/UserScript==

// The languages to keep, spelled as in the entry's headings. Edit this list.
const KEEP = ['English', 'Translingual'];

(() => {
  const content = document.querySelector('#mw-content-text .mw-parser-output');
  if (!content) return;

  // An entry is one flat list of elements. Each language starts at a level-2 heading
  // (<div class="mw-heading mw-heading2"><h2 id="English">English</h2>...) and runs
  // until the next one. Walk the children and tag every element by its language.
  const languages = [];
  let current = null;
  for (const el of content.children) {
    if (el.matches('.mw-heading2')) {
      const name = el.querySelector('h2').textContent.trim();
      current = { name, keep: KEEP.includes(name), id: el.querySelector('h2').id, els: [] };
      languages.push(current);
    }
    if (current) current.els.push(el);
  }

  const hidden = languages.filter((l) => !l.keep);
  // Leave the page alone when none of your languages is on it or nothing would be hidden.
  if (hidden.length === 0 || hidden.length === languages.length) return;

  GM_addStyle(`
    html.um-langfilter-on .um-langfilter-hidden { display: none !important; }
    .um-langfilter-bar { margin: 0.5em 0 1em; padding: 0.4em 0.8em; border: 1px solid var(--border-color-base, #a2a9b1);
      background: var(--background-color-neutral-subtle, #f8f9fa); font-size: 0.9em; }
    .um-langfilter-bar button { margin-left: 0.6em; cursor: pointer; }
  `);

  for (const lang of hidden) {
    for (const el of lang.els) el.classList.add('um-langfilter-hidden');
    // The matching entry in the sidebar table of contents.
    const tocLink = document.querySelector(`#vector-toc a[href="#${CSS.escape(lang.id)}"]`);
    tocLink?.closest('li')?.classList.add('um-langfilter-hidden');
  }

  const root = document.documentElement;
  root.classList.add('um-langfilter-on');

  // A line at the top of the entry saying what was hidden, with a toggle.
  const bar = document.createElement('div');
  bar.className = 'um-langfilter-bar';
  const label = document.createElement('span');
  const button = document.createElement('button');
  button.type = 'button';
  const render = () => {
    const on = root.classList.contains('um-langfilter-on');
    label.textContent = on
      ? `Showing ${languages.length - hidden.length} of ${languages.length} languages.`
      : `Showing all ${languages.length} languages.`;
    button.textContent = on ? 'Show all' : `Show only ${KEEP.join(', ')}`;
  };
  button.addEventListener('click', () => {
    root.classList.toggle('um-langfilter-on');
    render();
  });
  render();
  bar.append(label, button);
  content.querySelector('.mw-heading2').before(bar);
})();
