// ==UserScript==
// @name         Add a SteamDB link to Steam store pages
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a SteamDB button next to Community Hub on Steam store game pages.
// @match        https://store.steampowered.com/app/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/steam/steamdb-link.user.js
// @updateURL    https://usermods.kennethballenegger.com/steam/steamdb-link.user.js
// ==/UserScript==

// The app id is the number in the URL: /app/292030/The_Witcher_3...
const id = location.pathname.match(/^\/app\/(\d+)/)?.[1];
// The Community Hub button sits in .apphub_OtherSiteInfo at the top right of the page.
const box = document.querySelector('.apphub_OtherSiteInfo');
if (id && box && !box.querySelector('.um-steamdb')) {
  const a = document.createElement('a');
  a.className = 'btnv6_blue_hoverfade btn_medium um-steamdb';
  a.href = `https://steamdb.info/app/${id}/`;
  a.style.marginLeft = '4px';
  const label = document.createElement('span');
  label.textContent = 'SteamDB';
  a.append(label);
  box.append(a);
}
