// ==UserScript==
// @name         Mute users on Hacker News
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a mute link to Hacker News comments; comments from muted users fold down to a one-line header.
// @match        https://news.ycombinator.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/mute-users.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/mute-users.user.js
// ==/UserScript==

// The muted list lives in this browser's localStorage for news.ycombinator.com. Nothing is
// sent anywhere. Add names to MUTED below to mute them on every browser you install this on.
const MUTED = [];
const KEY = 'usermods-hn-muted';

GM_addStyle(`
  tr.comtr.um-muted .comment { display: none !important; }
  tr.comtr.um-muted .comhead { opacity: 0.6; }
  .um-mute { cursor: pointer; }
`);

const stored = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
};
const mutedSet = () => new Set([...MUTED, ...stored()]);

function toggle(name) {
  const list = stored();
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1); else list.push(name);
  localStorage.setItem(KEY, JSON.stringify(list));
  apply();
}

// Each comment row is tr.athing.comtr; its author is the user?id= link in .comhead.
function apply() {
  const muted = mutedSet();
  for (const row of document.querySelectorAll('tr.athing.comtr')) {
    const user = row.querySelector('.comhead > a[href^="user?id="]');
    if (!user) continue;
    const name = user.textContent.trim();
    const isMuted = muted.has(name);
    row.classList.toggle('um-muted', isMuted);
    let link = row.querySelector('.um-mute');
    if (!link) {
      link = document.createElement('a');
      link.className = 'um-mute';
      link.addEventListener('click', () => toggle(name));
      const sep = document.createTextNode(' | ');
      (row.querySelector('.comhead .navs') || user).after(sep, link);
    }
    link.textContent = isMuted ? `unmute ${name}` : 'mute';
  }
}

apply();
