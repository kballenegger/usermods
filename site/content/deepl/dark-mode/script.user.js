// ==UserScript==
// @name         Use dark mode on DeepL Translator
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Switches the DeepL website to the dark theme its own design system ships but never offers on the web.
// @match        https://www.deepl.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/deepl/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/deepl/dark-mode.user.js
// ==/UserScript==

// deepl.com picks its colours from a "light" or "dark" class on <html>, set by a small theme
// script that always chooses light on the web. The dark colours are already in the site's CSS,
// so swapping the class is enough. The site's theme script can put "light" back during page
// load, so watch the class and swap it again whenever that happens.
const root = document.documentElement;
function forceDark() {
  if (root.classList.contains('light')) root.classList.remove('light');
  if (!root.classList.contains('dark')) root.classList.add('dark');
  if (root.style.colorScheme !== 'dark') root.style.colorScheme = 'dark';
}
forceDark();
new MutationObserver(forceDark).observe(root, { attributes: true, attributeFilter: ['class', 'style'] });

// The "DeepL" wordmark in the header is a dark navy image. The site ships a white version for
// high-contrast mode; show that one instead.
GM_addStyle(`
  [data-testid="header-deepl-logo-text-anchor"] img { content: url("/img/logo/DeepL_Text_White.svg"); }
`);
