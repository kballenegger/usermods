// ==UserScript==
// @name         Dark mode for GitLab
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Always shows gitlab.com in GitLab's own dark mode when you are signed out, whatever your system's light or dark setting.
// @match        https://gitlab.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/gitlab/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/gitlab/dark-mode.user.js
// ==/UserScript==

// Signed out, GitLab loads both its light and dark stylesheets and lets a media query pick
// one by the system setting ("prefers-color-scheme"). The script makes the dark ones apply
// always and the light ones never, and swaps the root class to "gl-dark", which is what
// GitLab sets for signed-in users who choose dark mode. The stylesheets are GitLab's own
// files already on the page; nothing extra is downloaded.
function apply() {
  for (const link of document.querySelectorAll('link[rel="stylesheet"][media]')) {
    if (link.media === '(prefers-color-scheme: dark)') link.media = 'all';
    else if (link.media === '(prefers-color-scheme: light)') link.media = 'not all';
  }
  const html = document.documentElement;
  if (!html) return;
  if (html.classList.contains('gl-system')) html.classList.remove('gl-system');
  if (html.classList.contains('gl-light')) html.classList.remove('gl-light');
  if (!html.classList.contains('gl-dark')) html.classList.add('gl-dark');
}

apply();
new MutationObserver(apply).observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'media'],
});
