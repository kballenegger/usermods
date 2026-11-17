// ==UserScript==
// @name         Block sites from Google search results
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Hides Google Search results from the sites in a block list you edit at the top of the script.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google/block-sites.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/block-sites.user.js
// ==/UserScript==

// Edit this list. A domain also blocks its subdomains: 'pinterest.com' hides
// www.pinterest.com and uk.pinterest.com. Add country domains (pinterest.co.uk) separately.
const BLOCKED = ['pinterest.com'];

// Google's result links point to an opaque /goto address, so the site is read from the
// address line Google prints under each title (the <cite>, "https://www.example.com › path")
// or, for video results, from the data-curl/data-surl attribute. From each blocked address
// the script climbs to the largest block that holds no address from an unblocked site, so
// a single result goes, and a Videos row goes only when every video in it is blocked.
GM_addStyle('[data-usermods-blocked] { display: none !important; }');

const SOURCES = 'cite, [data-curl], [data-surl]';

function hostOf(el) {
  const text = el.getAttribute('data-curl') || el.getAttribute('data-surl') || el.textContent;
  const m = /^https?:\/\/([^\s/›]+)/.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

function isBlocked(host) {
  return BLOCKED.some((d) => host === d || host.endsWith('.' + d));
}

function onlyBlocked(el) {
  return [...el.querySelectorAll(SOURCES)].every((s) => {
    const host = hostOf(s);
    return !host || isBlocked(host);
  });
}

function hideBlocked() {
  const results = document.getElementById('rso');
  if (!results) return;
  const blocks = new Set();
  for (const source of results.querySelectorAll(SOURCES)) {
    const host = hostOf(source);
    if (!host || !isBlocked(host)) continue;
    let block = source;
    while (block.parentElement !== results && onlyBlocked(block.parentElement)) block = block.parentElement;
    blocks.add(block);
  }
  for (const el of results.querySelectorAll('[data-usermods-blocked]')) {
    if (!blocks.has(el)) el.removeAttribute('data-usermods-blocked');
  }
  for (const el of blocks) el.setAttribute('data-usermods-blocked', '');
}

// Google changes the page many times while it loads; run once per batch of changes.
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    hideBlocked();
  });
}).observe(document, { childList: true, subtree: true });
