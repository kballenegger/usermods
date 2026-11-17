// ==UserScript==
// @name         Show the release date at the top of Bandcamp albums
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Copies the release date from the credits at the bottom of a Bandcamp album or track page to just under the title.
// @match        https://*.bandcamp.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/bandcamp/show-release-date.user.js
// @updateURL    https://usermods.kennethballenegger.com/bandcamp/show-release-date.user.js
// ==/UserScript==

(() => {
  const name = document.querySelector('#name-section');
  const credits = document.querySelector('.tralbum-credits');
  if (!name || !credits) return;

  // The credits block starts with "released December 28, 2007", or "releases ..." for a
  // pre-order. Only that first line is copied; the credits stay where they are.
  const match = credits.textContent.match(/\b(released|releases)\s+([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (!match) return;

  GM_addStyle(`.um-release-date { margin: 6px 0 0 0; font-size: 14px; }`);
  const line = document.createElement('div');
  line.className = 'um-release-date secondaryText';
  line.textContent = (match[1] === 'released' ? 'Released ' : 'Releases ') + match[2];
  name.appendChild(line);
})();
