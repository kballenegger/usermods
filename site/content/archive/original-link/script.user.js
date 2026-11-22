// ==UserScript==
// @name         Open the original page from the Wayback Machine
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a small "Live page" button to Wayback Machine snapshots that opens the same URL on the live web.
// @match        https://web.archive.org/web/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/archive/original-link.user.js
// @updateURL    https://usermods.kennethballenegger.com/archive/original-link.user.js
// ==/UserScript==

(() => {
  // Snapshot URLs look like /web/20051231235657/http://www.google.com/ (sometimes with a
  // suffix such as "if_" after the timestamp). Everything after the timestamp is the
  // original address, query string and hash included.
  const match = location.href.match(/^https:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(https?:\/\/.+)$/);
  if (!match || window.top !== window) return;
  const original = match[1];

  const add = () => {
    if (document.getElementById('usermods-live-page')) return;
    // The button lives in its own shadow root so the snapshot's styles can't reach it.
    const host = document.createElement('div');
    host.id = 'usermods-live-page';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      a { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; padding: 8px 14px;
          border-radius: 4px; background: #222; color: #fff; font: bold 13px/1.2 sans-serif;
          text-decoration: none; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4); }
      a:hover { background: #444; }
    </style><a part="link">Live page</a>`;
    const link = root.querySelector('a');
    link.setAttribute('href', original);
    link.title = original;
    // The Wayback Machine's page script turns every link click into a snapshot URL, even
    // for links it didn't write. A plain left click therefore sets the location directly.
    // Middle and modifier clicks are left to the browser.
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      location.href = original;
    });
    document.body.appendChild(host);
  };

  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add);
})();
