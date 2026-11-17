// ==UserScript==
// @name         Add a volume slider to Bandcamp
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a volume slider under the Bandcamp player on album and track pages and remembers the level.
// @match        https://*.bandcamp.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/bandcamp/volume-control.user.js
// @updateURL    https://usermods.kennethballenegger.com/bandcamp/volume-control.user.js
// ==/UserScript==

(() => {
  const KEY = 'usermods-bandcamp-volume';
  const player = document.querySelector('.inline_player');
  if (!player) return;

  let volume = Number(localStorage.getItem(KEY) ?? 1);
  if (!(volume >= 0 && volume <= 1)) volume = 1;

  // Bandcamp plays through <audio> elements it adds to <body>. Set the level on all of them.
  const apply = () => {
    for (const a of document.querySelectorAll('audio')) a.volume = volume;
  };

  GM_addStyle(`
    .um-volume { display: flex; align-items: center; gap: 8px; margin: 6px 0 0 0; font-size: 12px; }
    .um-volume input { flex: 1; max-width: 220px; accent-color: currentColor; cursor: pointer; }
    .um-volume output { min-width: 3.5em; }
  `);

  const row = document.createElement('div');
  row.className = 'um-volume secondaryText';
  row.innerHTML = '<label for="um-volume-range">Volume</label>' +
    '<input id="um-volume-range" type="range" min="0" max="100" step="1" aria-label="Volume">' +
    '<output for="um-volume-range"></output>';
  const range = row.querySelector('input');
  const out = row.querySelector('output');
  const show = () => {
    range.value = String(Math.round(volume * 100));
    out.textContent = range.value + '%';
  };
  range.addEventListener('input', () => {
    volume = Number(range.value) / 100;
    localStorage.setItem(KEY, String(volume));
    show();
    apply();
  });
  player.appendChild(row);
  show();
  apply();

  // Media events don't bubble, but a capturing listener on document still sees them.
  // Re-apply when a track starts, in case Bandcamp adds a new audio element.
  document.addEventListener('play', apply, true);
  document.addEventListener('loadstart', apply, true);
})();
