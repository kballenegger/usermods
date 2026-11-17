// ==UserScript==
// @name         Preview images in GitHub file lists
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Shows a thumbnail in place of the file icon for images in GitHub's folder views, and a larger preview on hover.
// @match        https://github.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/github/image-preview.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/image-preview.user.js
// ==/UserScript==

const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i;

GM_addStyle(`
  .usermods-thumb {
    width: 20px;
    height: 20px;
    object-fit: contain;
    flex: none;
    vertical-align: middle;
    border-radius: 3px;
    background: #fff;
    transition: transform 0.1s;
    position: relative;
  }
  .usermods-thumb:hover {
    transform: scale(6);
    transform-origin: left center;
    z-index: 10;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.3);
  }
  /* The file icon the thumbnail replaces. */
  .usermods-has-thumb > svg.octicon-file { display: none !important; }
`);

// Each row in a folder view has a .react-directory-filename-column holding the file icon and
// a link to /<owner>/<repo>/blob/<ref>/<path>. The same file served raw lives at
// raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>, which GitHub lets pages load images
// from. Images load lazily, so a folder of a thousand icons only fetches the visible ones.
function update() {
  for (const col of document.querySelectorAll('.react-directory-filename-column:not(.usermods-has-thumb)')) {
    const link = col.querySelector('a[href*="/blob/"]');
    if (!link) continue;
    const path = new URL(link.href).pathname;
    if (!IMAGE.test(path)) continue;
    const [, owner, repo, , ...rest] = path.split('/');
    const img = document.createElement('img');
    img.className = 'usermods-thumb';
    img.loading = 'lazy';
    img.alt = '';
    img.src = `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}`;
    col.prepend(img);
    col.classList.add('usermods-has-thumb');
  }
}

// Folder views render after the first paint and change in place when you navigate.
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    update();
  });
}).observe(document, { childList: true, subtree: true });
