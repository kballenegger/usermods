// ==UserScript==
// @name         Add links to other movie sites on IMDb
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a row of links under the title on IMDb title pages to the same film on Letterboxd, TMDb, Rotten Tomatoes, Metacritic and Wikipedia.
// @match        https://www.imdb.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/imdb/external-links.user.js
// @updateURL    https://usermods.kennethballenegger.com/imdb/external-links.user.js
// ==/UserScript==

// Letterboxd and TMDb accept an IMDb id and redirect to their own page for it, so those
// links go straight to the film. Rotten Tomatoes, Metacritic and Wikipedia get a search for
// the title (Wikipedia also gets the year). The script makes no requests of its own.
GM_addStyle(`
  .usermods-ext-links { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0 4px; font-size: 14px; }
  .usermods-ext-links a { color: #5799ef; text-decoration: none; }
  .usermods-ext-links a:hover { text-decoration: underline; }
`);

function links(id, title, year) {
  const q = encodeURIComponent(title);
  return [
    ['Letterboxd', `https://letterboxd.com/imdb/${id}/`],
    ['TMDb', `https://www.themoviedb.org/redirect?external_source=imdb_id&external_id=${id}`],
    ['Rotten Tomatoes', `https://www.rottentomatoes.com/search?search=${q}`],
    ['Metacritic', `https://www.metacritic.com/search/${q}/`],
    ['Wikipedia', `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(`${title} ${year}`.trim())}`],
  ];
}

function add() {
  const id = (location.pathname.match(/^\/title\/(tt\d+)\/?$/) || [])[1];
  if (!id) return;
  const h1 = document.querySelector('h1[data-testid="hero__pageTitle"]');
  const existing = document.querySelector('.usermods-ext-links');
  // Rebuild when IMDb swaps to another title in the same tab.
  if (existing && existing.dataset.id === id && h1 && h1.parentElement.contains(existing)) return;
  existing?.remove();
  if (!h1) return;
  const title = h1.textContent.trim();
  let year = '';
  try {
    const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
    year = (ld.datePublished || '').slice(0, 4);
  } catch {}
  const row = document.createElement('div');
  row.className = 'usermods-ext-links';
  row.dataset.id = id;
  for (const [name, href] of links(id, title, year)) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = name;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    row.append(a);
  }
  // The title's parent also holds the year, rating and runtime line; the row goes after it.
  h1.parentElement.append(row);
}

// IMDb is a React app that can re-render the header, so re-add the row whenever it is gone.
new MutationObserver(add).observe(document.documentElement, { childList: true, subtree: true });
add();
