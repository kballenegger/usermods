// ==UserScript==
// @name         Use a light theme in the Spotify web player
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Switches the Spotify web player from its black theme to light grey panels with dark text.
// @match        https://open.spotify.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/spotify/light-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/spotify/light-mode.user.js
// ==/UserScript==

// Most of the player's colours are compiled into generated class names rather than shared
// variables, so recolouring them one by one would break on the next Spotify release.
// Instead the whole page is inverted and its hues turned back by 180 degrees: black panels
// become light grey, white text becomes near black and Spotify green stays green.
// Cover art, artist photos and video are inverted a second time so they look as they should.
GM_addStyle(`
  html { filter: invert(1) hue-rotate(180deg) !important; background: #000 !important; }
  img, video, picture, canvas,
  [data-testid="card-image"], [style*="background-image"] {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  /* An <img> inside an already re-inverted container must not flip back again. */
  picture img, [data-testid="card-image"] img, [style*="background-image"] img { filter: none !important; }
`);
