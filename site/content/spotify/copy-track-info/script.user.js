// ==UserScript==
// @name         Copy track info from Spotify web
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Copy button to each song row in the Spotify web player that copies "Title - Artist" to the clipboard.
// @match        https://open.spotify.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/spotify/copy-track-info.user.js
// @updateURL    https://usermods.kennethballenegger.com/spotify/copy-track-info.user.js
// ==/UserScript==

// Song rows on album, playlist, artist and search pages are [data-testid="tracklist-row"].
// The title is the row's track link and the artists are its /artist/ links. Spotify reuses
// row elements as you scroll, so the text is read from the row when the button is clicked,
// not when the button is added.
GM_addStyle(`
  .usermods-copy-track {
    margin-inline-start: 8px;
    padding: 2px 8px;
    border: 1px solid currentColor;
    border-radius: 999px;
    background: none;
    color: var(--text-subdued, #b3b3b3);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    opacity: 0;
  }
  [data-testid="tracklist-row"]:hover .usermods-copy-track,
  [data-testid="tracklist-row"]:focus-within .usermods-copy-track {
    opacity: 1;
  }
  .usermods-copy-track:hover { color: var(--text-base, #fff); }
`);

function trackText(row) {
  const title = row.querySelector('a[data-testid="internal-track-link"]')?.textContent.trim();
  if (!title) return null;
  const artists = [...row.querySelectorAll('a[href^="/artist/"]')].map((a) => a.textContent.trim());
  // Each artist appears once per row, but de-duplicate in case a layout repeats them.
  const unique = [...new Set(artists)].filter(Boolean);
  return unique.length > 0 ? `${title} - ${unique.join(', ')}` : title;
}

function addButtons() {
  for (const row of document.querySelectorAll('[data-testid="tracklist-row"]')) {
    if (row.querySelector('.usermods-copy-track')) continue;
    const cells = row.querySelectorAll('[role="gridcell"]');
    const last = cells[cells.length - 1];
    if (!last || !row.querySelector('a[data-testid="internal-track-link"]')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'usermods-copy-track';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy title and artist');
    button.addEventListener('click', async (event) => {
      // Keep the click from reaching the row, which would select or play the song.
      event.stopPropagation();
      event.preventDefault();
      const text = trackText(row);
      if (!text) return;
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
    last.prepend(button);
  }
}

new MutationObserver(addButtons).observe(document, { childList: true, subtree: true });
