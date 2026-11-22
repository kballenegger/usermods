// ==UserScript==
// @name         Open Spotify links in the desktop app
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  When you open an open.spotify.com link, hands it to the Spotify desktop app and leaves a bar with a link to open it again.
// @match        https://open.spotify.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/spotify/open-in-app.user.js
// @updateURL    https://usermods.kennethballenegger.com/spotify/open-in-app.user.js
// ==/UserScript==

// A web link like https://open.spotify.com/intl-de/album/<id>?si=... maps to the app URI
// spotify:album:<id>. Clicking a link to that URI asks the browser to open the Spotify app;
// the tab stays where it is. This runs once, when the link is first opened, so browsing
// inside the web player afterwards is not sent to the app. It waits until the page has
// been parsed: leaving for the app while the page is still loading would cancel the load.
(() => {
  const m = location.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|artist|playlist|show|episode|user|genre)\/([A-Za-z0-9_.-]+)/i);
  if (!m) return;
  const uri = `spotify:${m[1].toLowerCase()}:${m[2]}`;

  GM_addStyle(`
    #usermods-open-in-app { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
      display: flex; align-items: center; gap: 12px; padding: 8px 12px 8px 16px; border-radius: 8px;
      background: #1ed760; color: #000; font: 600 14px/1.3 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.5); }
    #usermods-open-in-app a { color: #000; text-decoration: underline; }
    #usermods-open-in-app button { all: unset; cursor: pointer; padding: 0 4px; font-size: 18px; line-height: 1; }
  `);

  // The bar is the way back to the app if the browser's "Open Spotify?" prompt was dismissed.
  const addBar = () => {
    if (document.getElementById('usermods-open-in-app')) return;
    const bar = document.createElement('div');
    bar.id = 'usermods-open-in-app';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = 'Sent to the Spotify app.';
    const link = document.createElement('a');
    link.href = uri;
    link.textContent = 'Open in app again';
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => bar.remove());
    bar.append(text, link, close);
    document.body.append(bar);
    link.click();
  };
  if (document.body) addBar();
  else document.addEventListener('DOMContentLoaded', addBar);
})();
