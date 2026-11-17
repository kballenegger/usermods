// ==UserScript==
// @name         Bring back the old Wikipedia layout
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Opens Wikipedia in the pre-2023 Vector layout (Vector legacy) without logging in, by adding useskin=vector to every page.
// @match        https://*.wikipedia.org/*
// @run-at       document-start
// @noframes
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/wikipedia/old-layout.user.js
// @updateURL    https://usermods.kennethballenegger.com/wikipedia/old-layout.user.js
// ==/UserScript==

(() => {
  // MediaWiki picks the skin from the useskin URL parameter before anything else.
  // useskin=vector is the old layout (Vector 2010); the current one is vector-2022.
  const SKIN = 'vector';

  const withSkin = (href) => {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return null;
    if (!/^\/(wiki\/|w\/index\.php)/.test(url.pathname)) return null;
    if (url.searchParams.has('useskin')) return null;
    url.searchParams.set('useskin', SKIN);
    return url.href;
  };

  // Pages opened directly (bookmarks, search engines, typed URLs) are reloaded once with the parameter.
  const here = withSkin(location.href);
  if (here) {
    location.replace(here);
    return;
  }

  // Links clicked inside Wikipedia get the parameter added first, so the next page
  // loads in the old layout straight away instead of loading twice.
  const fix = (event) => {
    const a = event.target.closest && event.target.closest('a[href]');
    if (!a) return;
    const href = withSkin(a.href);
    if (href) a.href = href;
  };
  document.addEventListener('mousedown', fix, true);
  document.addEventListener('click', fix, true);
})();
