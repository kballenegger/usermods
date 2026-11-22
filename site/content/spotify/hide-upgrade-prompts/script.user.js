// ==UserScript==
// @name         Hide Premium upsells in Spotify web
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the Premium and Explore Premium buttons and the sign-up banner at the bottom of the Spotify web player.
// @match        https://open.spotify.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/spotify/hide-upgrade-prompts.user.js
// @updateURL    https://usermods.kennethballenegger.com/spotify/hide-upgrade-prompts.user.js
// ==/UserScript==

// The bottom "Preview of Spotify ... Sign up free" banner has a stable test id, so CSS hides it.
// The Premium buttons in the top bar have no id or label of their own, only generated class
// names, so they are found by their text and marked for the same stylesheet. The Log in and
// Sign up buttons stay.
GM_addStyle(`
  [data-testid="signup-bar"],
  [data-usermods-hidden="premium-upsell"] { display: none !important; }
`);

const UPSELL_TEXT = new Set(['Premium', 'Explore Premium', 'Upgrade to Premium', 'Try Premium', 'Upgrade']);

function hideUpsells() {
  for (const el of document.querySelectorAll('#global-nav-bar button, #global-nav-bar a')) {
    if (UPSELL_TEXT.has(el.textContent.trim())) {
      if (el.dataset.usermodsHidden !== 'premium-upsell') el.dataset.usermodsHidden = 'premium-upsell';
    } else if (el.dataset.usermodsHidden === 'premium-upsell') {
      // React reuses elements; unmark one whose text has changed to something else.
      delete el.dataset.usermodsHidden;
    }
  }
}

new MutationObserver(hideUpsells).observe(document, { childList: true, subtree: true, characterData: true });
