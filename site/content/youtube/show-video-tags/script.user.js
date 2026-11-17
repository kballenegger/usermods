// ==UserScript==
// @name         Show a YouTube video's tags
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Lists the tags the uploader gave a YouTube video under its title, each one linking to a search.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/show-video-tags.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/show-video-tags.user.js
// ==/UserScript==

GM_addStyle(`
  #usermods-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; font: 400 1.3rem/1.8rem Roboto, Arial, sans-serif; }
  #usermods-tags a { padding: 2px 10px; border-radius: 12px; background: var(--yt-spec-badge-chip-background, rgba(0,0,0,.05)); color: var(--yt-spec-text-primary, #0f0f0f); text-decoration: none; }
  #usermods-tags a:hover { background: var(--yt-spec-button-chip-background-hover, rgba(0,0,0,.1)); }
  #usermods-tags span { color: var(--yt-spec-text-secondary, #606060); }
`);

// The tags are not shown anywhere on the page, but they are in the data the player loaded for
// the video (videoDetails.keywords). The player's getPlayerResponse() returns the data for the
// video that is playing now, which stays right when you click from one video to another
// without a reload; the copy embedded in the page HTML does not.
function render() {
  if (location.pathname !== '/watch') return;
  const player = document.querySelector('#movie_player');
  const title = document.querySelector('ytd-watch-metadata #title');
  const details = player?.getPlayerResponse?.()?.videoDetails;
  if (!title || !details) return;
  let box = document.getElementById('usermods-tags');
  if (box && box.dataset.video === details.videoId && box.previousElementSibling === title) return;
  if (!box) {
    box = document.createElement('div');
    box.id = 'usermods-tags';
  }
  box.dataset.video = details.videoId;
  box.replaceChildren();
  const tags = details.keywords ?? [];
  if (tags.length === 0) {
    const none = document.createElement('span');
    none.textContent = 'No tags';
    box.append(none);
  }
  for (const tag of tags) {
    const a = document.createElement('a');
    a.href = `/results?search_query=${encodeURIComponent(tag)}`;
    a.textContent = tag;
    box.append(a);
  }
  title.after(box);
}

// YouTube is a single-page app: the watch page is reused from one video to the next, so the
// list is redrawn whenever the page changes and the player's video id no longer matches.
new MutationObserver(render).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('yt-navigate-finish', render);
