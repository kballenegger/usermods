// ==UserScript==
// @name         Open YouTube videos in a new tab
// @namespace    https://usermods.kennethballenegger.com
// @version      1.1.0
// @description  Opens videos you click on YouTube in a new tab and leaves the current page where it is.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/open-links-new-tab.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/open-links-new-tab.user.js
// ==/UserScript==

// YouTube catches clicks on its links and swaps the page in place. This listener runs first
// (capture phase on window), and for a plain left click on a link to a video (/watch or
// /shorts/) it stops YouTube's handler and opens the link in a new tab instead. Clicks with
// Ctrl, Cmd, Shift or Alt, middle clicks, and links to channels, playlists or other pages
// behave as before. Links to the video you are already watching (chapter and comment
// timestamps) and links inside the player (its Next button) are left to YouTube, so they
// seek or play in place.
window.addEventListener('click', (e) => {
  const videoId = (url) => {
    if (url.pathname === '/watch') return url.searchParams.get('v');
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
    return null;
  };
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const link = e.target instanceof Element && e.target.closest('a[href]');
  if (!link || link.closest('#movie_player')) return;
  const url = new URL(link.href, location.href);
  if (url.hostname !== location.hostname) return;
  const id = videoId(url);
  if (!id || id === videoId(new URL(location.href))) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  window.open(url.href, '_blank', 'noopener');
}, true);
