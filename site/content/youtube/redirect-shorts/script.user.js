// ==UserScript==
// @name         Open YouTube Shorts in the regular player
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Sends youtube.com/shorts/ links to the normal watch page, with the full player, seek bar and comments.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/redirect-shorts.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/redirect-shorts.user.js
// ==/UserScript==

// A Short at /shorts/<id> is the same video as /watch?v=<id>. Other query
// parameters are dropped; the Shorts page does not use them.
function watchUrl(url) {
  const m = url.pathname.match(/^\/shorts\/([\w-]+)/);
  if (!m) return null;
  const watch = new URL('/watch', url.origin);
  watch.searchParams.set('v', m[1]);
  return watch.href;
}

function redirectIfShort() {
  const target = watchUrl(location);
  // replace() keeps the Shorts URL out of history, so Back doesn't bounce.
  if (target) location.replace(target);
}

// Direct loads: a pasted link, a new tab, a reload.
redirectIfShort();

// Clicks inside YouTube don't load a new page; the app swaps content in place.
// Catch plain left clicks on Shorts links before YouTube's router sees them.
// Modified clicks (new tab, new window) are left alone and redirect on load.
document.addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element && event.target.closest('a[href*="/shorts/"]');
  if (!link) return;
  const target = watchUrl(new URL(link.href, location.href));
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(target);
}, true);

// Any other in-app route to a Short (back/forward, links opened by script)
// ends with this event once the URL has changed.
document.addEventListener('yt-navigate-finish', redirectIfShort);
