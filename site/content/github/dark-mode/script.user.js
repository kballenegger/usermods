// ==UserScript==
// @name         Dark mode for GitHub
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Always shows GitHub in its own dark theme when you are signed out, whatever your system's light or dark setting.
// @match        https://github.com/*
// @match        https://gist.github.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/github/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/dark-mode.user.js
// ==/UserScript==

// GitHub picks its theme from three attributes on <html>: data-color-mode ("light",
// "dark" or "auto", which follows the system) and the light and dark theme names. Setting
// the mode to "dark" switches on GitHub's own dark theme, so every page and component is
// styled by GitHub itself. The attributes are set again if GitHub changes them, for
// example after in-page navigation.
const WANT = { 'data-color-mode': 'dark', 'data-dark-theme': 'dark' };

function apply() {
  const html = document.documentElement;
  if (!html) return;
  for (const [name, value] of Object.entries(WANT)) {
    if (html.getAttribute(name) !== value) html.setAttribute(name, value);
  }
}

apply();
new MutationObserver(apply).observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: Object.keys(WANT),
});
