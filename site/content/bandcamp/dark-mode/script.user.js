// ==UserScript==
// @name         Dark mode for Bandcamp
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Gives Bandcamp artist, album and track pages a dark background with light text, whatever colours the artist picked.
// @match        https://*.bandcamp.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/bandcamp/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/bandcamp/dark-mode.user.js
// ==/UserScript==

// Each artist picks their own page colours, which Bandcamp writes into a <style> block
// (#custom-design-rules-style). These rules use !important so they win over any palette.
// The artist's header banner and all images are left alone.
GM_addStyle(`
  html, body { background-color: #111 !important; background-image: none !important; }

  /* Top bar with the logo and search. */
  #menubar-wrapper, #menubar-vm, #menubar, .menubar-outer { background-color: #1a1a1a !important; color: #ddd !important; }
  #menubar a, #menubar button { color: #ddd !important; }
  #menubar input.search-bar { background-color: #2a2a2a !important; color: #eee !important; }
  /* Bandcamp ships a white logo next to the dark one; show the white one. */
  #menubar .bclogo.aqua { display: none !important; }
  #menubar .bclogo.white { display: block !important; }
  #menubar .menubar-search-icon svg, #menubar .search-spinner { fill: #ddd !important; color: #ddd !important; }

  /* Page body: text first, links after so they win inside the same container. */
  #pgBd, #recommendations_container { background-color: #1c1c1c !important; color: #ddd !important; }
  #pgBd h2, #pgBd h3, #pgBd h4, #pgBd p, #pgBd td, #pgBd div, #pgBd span, #pgBd li, #pgBd .primaryText,
  #recommendations_container div, #recommendations_container span, #recommendations_container p { color: #ddd !important; }
  #pgBd .secondaryText, #pgBd .secondaryText *, #pgBd .tralbum-credits, #pgBd .tralbum-tags,
  #recommendations_container .secondaryText { color: #a5a5a5 !important; }
  #pgBd a, #pgBd a *, #pgBd button, #pgBd .buy-link, #pgBd .compound-button,
  #recommendations_container a, #recommendations_container a * { color: #7cc4e0 !important; }

  #pgBd .follow-unfollow { background-color: transparent !important; border-color: #555 !important; }
  #pgBd .track_row_view:hover, #pgBd .track_row_view.current_track { background-color: #2a2a2a !important; }
  #pgBd .progbar_empty { background-color: #333 !important; border-color: #555 !important; }
  #pgBd .progbar_fill { background-color: #aaa !important; }
  #pgBd input, #pgBd textarea, #pgBd select { background-color: #2a2a2a !important; color: #eee !important; border-color: #555 !important; }
`);
