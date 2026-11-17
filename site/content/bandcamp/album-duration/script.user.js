// ==UserScript==
// @name         Show the total length of a Bandcamp album
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds up the track times on a Bandcamp album page and shows the total under the track list.
// @match        https://*.bandcamp.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/bandcamp/album-duration.user.js
// @updateURL    https://usermods.kennethballenegger.com/bandcamp/album-duration.user.js
// ==/UserScript==

(() => {
  const table = document.querySelector('#track_table');
  if (!table) return;
  const rows = [...table.querySelectorAll('.track_row_view')];
  if (rows.length < 2) return;

  // Track times read "03:57" or "1:02:03". Tracks that can't be streamed have no time.
  let seconds = 0;
  let timed = 0;
  for (const row of rows) {
    const text = row.querySelector('.time')?.textContent.trim() ?? '';
    if (!/^\d+(:\d{2}){1,2}$/.test(text)) continue;
    seconds += text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    timed++;
  }
  if (!timed) return;

  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const total = h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;

  GM_addStyle(`.um-album-length { margin: 8px 0 0 0; font-size: 13px; }`);
  const line = document.createElement('div');
  line.className = 'um-album-length secondaryText';
  line.textContent = `Total length ${total}, ${rows.length} tracks` +
    (timed < rows.length ? ` (${rows.length - timed} without a listed time)` : '');
  table.after(line);
})();
