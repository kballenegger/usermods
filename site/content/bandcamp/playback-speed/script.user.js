// ==UserScript==
// @name         Change Bandcamp playback speed
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a speed menu under the Bandcamp player, from 0.5x to 2x, and remembers the choice.
// @match        https://*.bandcamp.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/bandcamp/playback-speed.user.js
// @updateURL    https://usermods.kennethballenegger.com/bandcamp/playback-speed.user.js
// ==/UserScript==

(() => {
  const KEY = 'usermods-bandcamp-speed';
  const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const player = document.querySelector('.inline_player');
  if (!player) return;

  let speed = Number(localStorage.getItem(KEY) ?? 1);
  if (!SPEEDS.includes(speed)) speed = 1;

  // Bandcamp plays through <audio> elements it adds to <body>. Loading a new track resets
  // playbackRate to defaultPlaybackRate, so set both. Pitch stays the same (Chrome's default).
  const apply = () => {
    for (const a of document.querySelectorAll('audio')) {
      a.defaultPlaybackRate = speed;
      a.playbackRate = speed;
    }
  };

  GM_addStyle(`
    .um-speed { display: flex; align-items: center; gap: 8px; margin: 6px 0 0 0; font-size: 12px; }
    .um-speed select { font: inherit; padding: 1px 4px; }
  `);

  const row = document.createElement('div');
  row.className = 'um-speed secondaryText';
  const label = document.createElement('label');
  label.htmlFor = 'um-speed-select';
  label.textContent = 'Speed';
  const select = document.createElement('select');
  select.id = 'um-speed-select';
  for (const s of SPEEDS) select.add(new Option(s + 'x', String(s), false, s === speed));
  select.addEventListener('change', () => {
    speed = Number(select.value);
    localStorage.setItem(KEY, String(speed));
    apply();
  });
  row.append(label, select);
  player.appendChild(row);
  apply();

  // Media events don't bubble, but a capturing listener on document still sees them.
  document.addEventListener('play', apply, true);
  document.addEventListener('loadstart', apply, true);
})();
