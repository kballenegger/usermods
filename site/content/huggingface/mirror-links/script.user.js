// ==UserScript==
// @name         Rewrite Hugging Face links to a mirror
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Points the file download links on Hugging Face model, dataset and Space pages at hf-mirror.com.
// @match        https://huggingface.co/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/huggingface/mirror-links.user.js
// @updateURL    https://usermods.kennethballenegger.com/huggingface/mirror-links.user.js
// ==/UserScript==

// hf-mirror.com serves the same paths as huggingface.co, so
// /owner/repo/resolve/main/file becomes https://hf-mirror.com/owner/repo/resolve/main/file.
// Change MIRROR to use another mirror with the same layout.
const MIRROR = 'https://hf-mirror.com';

// File downloads are the links with /resolve/ in the path: the download arrows in the file
// list and the download button on a file's page. Other links stay on huggingface.co.
function rewrite() {
  for (const a of document.querySelectorAll('a[href*="/resolve/"]')) {
    const url = new URL(a.getAttribute('href'), location.href);
    if (url.hostname !== 'huggingface.co') continue;
    a.href = MIRROR + url.pathname + url.search;
  }
}

rewrite();
// The site swaps the file list in place when you open folders or switch branches.
new MutationObserver(rewrite).observe(document.body, {
  childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
});
