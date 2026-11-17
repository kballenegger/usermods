// ==UserScript==
// @name         Open a GitHub repo in a VS Code view
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds an Open in github1s tab to GitHub repository pages that opens the repository, folder or file in a read-only VS Code view.
// @match        https://github.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/github/open-in-github1s.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/open-in-github1s.user.js
// ==/UserScript==

const BUTTON_ID = 'usermods-github1s';

// github1s.com mirrors GitHub's URL layout: /<owner>/<repo>, /<owner>/<repo>/tree/<ref>/<dir>
// and /<owner>/<repo>/blob/<ref>/<file> all open the same place. Other repository pages
// (issues, pulls, actions) open the repository root.
function target() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length > 2 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    return 'https://github1s.com/' + parts.join('/');
  }
  return 'https://github1s.com/' + parts.slice(0, 2).join('/');
}

// The repository tab bar (Code, Issues, Pull requests ... Insights) is on every repository
// page, including folders and files. The new tab is a copy of the last tab, so it picks up the
// same look, with its own label and an external link.
function update() {
  const nav = document.querySelector('nav[aria-label="Repository"]');
  const last = nav?.querySelector('ul > li:last-child:not(:has(#' + BUTTON_ID + '))');
  let link = document.getElementById(BUTTON_ID);
  if (!nav) return;
  if (!link || !nav.contains(link)) {
    if (!last) return;
    const li = last.cloneNode(false);
    link = last.querySelector('a').cloneNode(false);
    link.id = BUTTON_ID;
    for (const attr of ['data-tab-item', 'data-turbo-frame', 'aria-current', 'data-discover']) link.removeAttribute(attr);
    link.title = 'Browse this repository in VS Code on github1s.com';
    link.target = '_blank';
    link.rel = 'noopener';
    const label = document.createElement('span');
    label.dataset.component = 'text';
    label.textContent = 'Open in github1s';
    link.append(label);
    li.append(link);
    last.after(li);
  }
  const href = target();
  if (link.href !== href) link.href = href;
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
