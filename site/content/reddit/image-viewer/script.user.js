// ==UserScript==
// @name         Open Reddit images full size
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Clicking an image in a Reddit post opens the original full-size file from i.redd.it in a new tab instead of Reddit's viewer.
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/reddit/image-viewer.user.js
// @updateURL    https://usermods.kennethballenegger.com/reddit/image-viewer.user.js
// ==/UserScript==

(() => {
  // Feed and post images are resized copies on preview.redd.it, for example
  // https://preview.redd.it/some-title-v0-abc123.jpeg?width=640&auto=webp. The original is
  // https://i.redd.it/abc123.jpeg: the file name after "-v0-", or the whole name when the
  // preview has no title prefix.
  const MEDIA = 'shreddit-post [slot="post-media-container"] img, shreddit-post gallery-carousel img';

  function original(img) {
    const post = img.closest('shreddit-post');
    // Single-image posts carry the original URL on the post element.
    const href = post?.getAttribute('content-href') ?? '';
    if (post?.getAttribute('post-type') === 'image' && href.startsWith('https://i.redd.it/')) return href;
    const src = img.currentSrc || img.src;
    let url;
    try { url = new URL(src); } catch { return null; }
    if (url.hostname === 'i.redd.it') return url.origin + url.pathname;
    if (url.hostname !== 'preview.redd.it') return null;
    const name = url.pathname.split('/').pop();
    const cut = name.lastIndexOf('-v0-');
    return 'https://i.redd.it/' + (cut >= 0 ? name.slice(cut + 4) : name);
  }

  GM_addStyle(`${MEDIA} { cursor: zoom-in; }`);

  // Capture phase on the document runs before Reddit's own listener on the post, which would
  // open its lightbox or the comments page.
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const img = e.target instanceof Element && e.target.closest('img');
    if (!img || !img.matches(MEDIA)) return;
    const url = original(img);
    if (!url) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(url, '_blank', 'noopener');
  }, true);
})();
