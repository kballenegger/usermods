// ==UserScript==
// @name         Stop Medium's header from following you down the page
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Makes the Medium top bar scroll away with the page instead of staying pinned to the top of the window.
// @match        https://medium.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/medium/hide-sticky-bars.user.js
// @updateURL    https://usermods.kennethballenegger.com/medium/hide-sticky-bars.user.js
// ==/UserScript==

// Medium's class names are generated and change between builds, so the script finds the
// bar from the Medium logo inside it (data-testid="headerMediumLogo") and walks up to the
// first ancestor that is pinned with position: sticky or fixed. That element gets a marker
// attribute, and the CSS below lets it scroll with the page.
GM_addStyle(`
  [data-usermods-unpinned] {
    position: relative !important;
    top: auto !important;
  }
`);

function unpin() {
  const logo = document.querySelector('[data-testid="headerMediumLogo"]');
  if (!logo) return;
  for (let el = logo.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.hasAttribute('data-usermods-unpinned')) return;
    const position = getComputedStyle(el).position;
    if (position === 'sticky' || position === 'fixed') {
      el.setAttribute('data-usermods-unpinned', '');
      return;
    }
  }
}

// Medium renders the bar after the script starts and redraws it on in-app navigation.
new MutationObserver(unpin).observe(document, { childList: true, subtree: true });
