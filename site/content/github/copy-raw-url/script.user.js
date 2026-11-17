// ==UserScript==
// @name         Copy the raw URL of a GitHub file
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Copy URL button next to Raw on GitHub file pages that copies the file's raw.githubusercontent.com address.
// @match        https://github.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/github/copy-raw-url.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/copy-raw-url.user.js
// ==/UserScript==

const BUTTON_ID = 'usermods-copy-raw-url';

// The Raw button links to github.com/<owner>/<repo>/raw/<ref path>, which redirects to
// raw.githubusercontent.com/<owner>/<repo>/<ref path>. The button copies the address the
// redirect ends at, so the copied link points straight at the file.
function rawUrl(rawButton) {
  const [, owner, repo, , ...rest] = new URL(rawButton.href).pathname.split('/');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}`;
}

// The new button sits in the same button group as Raw, Copy raw file and Download, and borrows
// the Raw button's classes so it looks like the rest of the group.
function update() {
  const raw = document.querySelector('a[data-testid="raw-button"]');
  const item = raw?.parentElement;
  if (!item || item.parentElement.querySelector('#' + BUTTON_ID)) return;
  const wrap = item.cloneNode(false);
  const button = document.createElement('button');
  button.type = 'button';
  button.id = BUTTON_ID;
  button.className = raw.className;
  for (const attr of ['data-size', 'data-variant', 'data-no-visuals']) {
    if (raw.hasAttribute(attr)) button.setAttribute(attr, raw.getAttribute(attr));
  }
  button.title = 'Copy the raw.githubusercontent.com URL of this file';
  const content = raw.firstElementChild?.cloneNode(true) || document.createElement('span');
  const label = content.querySelector('[data-component="text"]') || content;
  label.textContent = 'Copy URL';
  button.append(content);
  button.addEventListener('click', async () => {
    // Read the Raw link at click time: GitHub reuses the page when you open another file.
    const current = document.querySelector('a[data-testid="raw-button"]');
    await navigator.clipboard.writeText(rawUrl(current));
    label.textContent = 'Copied';
    setTimeout(() => (label.textContent = 'Copy URL'), 1500);
  });
  wrap.append(button);
  item.after(wrap);
}

let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    update();
  });
}).observe(document, { childList: true, subtree: true });
