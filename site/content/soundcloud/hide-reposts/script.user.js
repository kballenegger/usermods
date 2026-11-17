// ==UserScript==
// @name         Hide reposts on SoundCloud
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides reposted tracks and playlists on SoundCloud profiles and in the feed, leaving the artist's own uploads.
// @match        https://soundcloud.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/soundcloud/hide-reposts.user.js
// @updateURL    https://usermods.kennethballenegger.com/soundcloud/hide-reposts.user.js
// ==/UserScript==

// On a profile, a repost carries a "Reposted by <name>" badge (.sc-ministats-reposts inside
// .soundTitle__info) next to the original uploader. In the logged-in feed, reposts have a
// .soundContext__repost line above the track. Either marks the whole list item for hiding.
// A profile's own Reposts tab is left alone: there every item is a repost by design.
GM_addStyle(`
  body:not(:has(.g-tabs-link.active[href$="/reposts"])) .soundList__item:has(.soundTitle__info .sc-ministats-reposts),
  body:not(:has(.g-tabs-link.active[href$="/reposts"])) .soundList__item:has(.soundContext__repost) {
    display: none !important;
  }
`);
