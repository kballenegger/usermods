// ==UserScript==
// @name         Clean AliExpress product links
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Strips tracking parameters from AliExpress product links and the product page address, leaving /item/<id>.html.
// @match        https://*.aliexpress.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/aliexpress/clean-urls.user.js
// @updateURL    https://usermods.kennethballenegger.com/aliexpress/clean-urls.user.js
// ==/UserScript==

// A product link only needs its item number: https://www.aliexpress.com/item/<id>.html.
// Everything after the "?" (algo_pvid, pdp_npi, curPageLogUid, utparam-url, ...) is
// tracking, so the script drops it from every product link on the page and from the
// address bar when you are on a product page.
const ITEM_PATH = /^\/item\/\d+\.html$/;

function cleanLink(a) {
  let url;
  try {
    url = new URL(a.href);
  } catch {
    return;
  }
  if (!url.hostname.endsWith('aliexpress.com') || !ITEM_PATH.test(url.pathname)) return;
  const clean = url.origin + url.pathname;
  // Only write when it changes, so the observer below doesn't loop on its own edits.
  if (a.href !== clean) a.href = clean;
}

function cleanAddressBar() {
  if (ITEM_PATH.test(location.pathname) && (location.search || location.hash)) {
    history.replaceState(history.state, '', location.pathname);
  }
}

function cleanAll() {
  for (const a of document.querySelectorAll('a[href*="/item/"]')) cleanLink(a);
}

cleanAddressBar();
// Search results load as you scroll and the site redraws cards, which puts the long
// links back, so links are cleaned again whenever the page changes.
new MutationObserver(() => {
  cleanAll();
  cleanAddressBar();
}).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
