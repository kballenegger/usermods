// ==UserScript==
// @name         Dark mode for Stack Overflow
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Shows Stack Overflow in its own dark theme without an account or a preferences change.
// @match        https://stackoverflow.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/stackoverflow/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/stackoverflow/dark-mode.user.js
// ==/UserScript==

// Stack Overflow ships its dark theme to every visitor; signed-in users who pick Dark get
// the class "theme-dark" on <body>. This script adds that class (and takes off the light
// and system ones), so the colors are the site's own. <body> doesn't exist yet when the
// script starts, so it waits for it, and puts the class back if the page removes it.
function apply() {
  const body = document.body;
  if (!body) return;
  if (!body.classList.contains('theme-dark')) body.classList.add('theme-dark');
  if (body.classList.contains('theme-light')) body.classList.remove('theme-light');
  if (body.classList.contains('theme-system')) body.classList.remove('theme-system');
}

apply();
new MutationObserver(apply).observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class'],
});
