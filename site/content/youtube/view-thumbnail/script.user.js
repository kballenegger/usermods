// ==UserScript==
// @name         Open a YouTube video's thumbnail
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a "View thumbnail" link under the title on YouTube video pages that opens the largest version of the video's thumbnail.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/view-thumbnail.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/view-thumbnail.user.js
// ==/UserScript==

// The player knows every size of the current video's thumbnail; the last one in its list is
// the largest (often maxresdefault, 1280 or 1920 pixels wide, on i.ytimg.com). Not every
// video has a maxresdefault image, so the script uses the player's list rather than
// guessing the address. It puts a "View thumbnail" link under the video title that opens
// that image in a new tab, and updates it when you move to another video.
const LINK_ID = 'usermods-view-thumbnail';

function largestThumbnail() {
  const id = new URLSearchParams(location.search).get('v');
  const player = document.querySelector('#movie_player');
  const response = player && typeof player.getPlayerResponse === 'function' && player.getPlayerResponse();
  const details = response && response.videoDetails;
  // Right after an in-page navigation the player can still hold the previous video.
  if (!details || details.videoId !== id) return null;
  const list = details.thumbnail && details.thumbnail.thumbnails;
  return list && list.length ? list[list.length - 1].url : null;
}

function update() {
  const existing = document.getElementById(LINK_ID);
  if (location.pathname !== '/watch') {
    if (existing) existing.remove();
    return;
  }
  const title = document.querySelector('ytd-watch-metadata #title');
  const url = largestThumbnail();
  if (!title || !url) return;
  if (existing && existing.href === url && existing.previousElementSibling === title) return;
  const link = existing || document.createElement('a');
  link.id = LINK_ID;
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'View thumbnail';
  link.style.cssText = 'display:inline-block;margin-top:4px;font-size:1.4rem;color:var(--yt-spec-text-secondary);text-decoration:underline;';
  title.after(link);
}

// The title and player are built after the page shell and reused across in-page
// navigations, so check again on each change.
new MutationObserver(update).observe(document, { childList: true, subtree: true });
document.addEventListener('yt-player-updated', update);
document.addEventListener('yt-navigate-finish', update);
