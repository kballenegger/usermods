// ==UserScript==
// @name         Download full-size SoundCloud cover art
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a link under the artwork on SoundCloud track and playlist pages that opens the cover art at its original uploaded size.
// @match        https://soundcloud.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/soundcloud/download-cover-art.user.js
// @updateURL    https://usermods.kennethballenegger.com/soundcloud/download-cover-art.user.js
// ==/UserScript==

// The big artwork on a track or playlist page is a background image ending in -t500x500.jpg.
// SoundCloud keeps the uploaded file at the same address with -original instead of -t500x500.
GM_addStyle(`
  .usermods-cover-art {
    display: block;
    margin-top: 8px;
    font-size: 13px;
    text-align: center;
    color: inherit !important;
    text-decoration: underline !important;
  }
`);

(() => {
  const originalUrl = (span) => {
    const m = /url\(["']?(https:\/\/[^"')]+)["']?\)/.exec(span.style.backgroundImage || '');
    if (!m || !/-t\d+x\d+\./.test(m[1])) return null;
    return m[1].replace(/-t\d+x\d+\./, '-original.');
  };

  // Recompute on every change: SoundCloud reuses the hero when you move between tracks,
  // and the artwork span gets its background image some time after the page is built.
  const update = () => {
    for (const wrapper of document.querySelectorAll('.listenArtworkWrapper')) {
      const span = wrapper.querySelector('.listenArtworkWrapper__artwork .image__full');
      const href = span && originalUrl(span);
      let link = wrapper.querySelector('.usermods-cover-art');
      if (!href) {
        link?.remove();
        continue;
      }
      if (!link) {
        link = document.createElement('a');
        link.className = 'usermods-cover-art';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Full-size cover art';
        wrapper.append(link);
      }
      if (link.href !== href) link.href = href;
    }
  };

  new MutationObserver(update).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
  update();
})();
