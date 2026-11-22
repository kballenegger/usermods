// ==UserScript==
// @name         Remove ads and clutter from Goodreads
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Hides the sign-up popup, the promo banner above the header and the ad slots on Goodreads book pages.
// @match        https://www.goodreads.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/goodreads/declutter.user.js
// @updateURL    https://usermods.kennethballenegger.com/goodreads/declutter.user.js
// ==/UserScript==

GM_addStyle(`
  /* "Discover & Read More" sign-up popup shown to logged-out visitors a few seconds in.
     It is made invisible here and closed below. display: none would crash the page:
     the popup traps focus and throws when it finds nothing focusable. */
  .Overlay:has(.LoginInterstitial) { opacity: 0 !important; }

  /* Promo strip above the header (Choice Awards, app promotions). */
  .SiteHeaderBanner { display: none !important; }
  /* The fixed header and the page below it leave 40px of room for that strip; take it back. */
  .Header__siteHeaderBanner { height: auto !important; }
  .PageFrame--siteHeaderBanner { padding-top: 66px !important; }

  /* Ad slots: Google Publisher Tag containers and Goodreads' own ad wrappers. */
  .Ad, .NativeAdWrapper, [id^="div-gpt-"] { display: none !important; }
`);

// Close the sign-up popup with its own Close button as soon as it appears, so Goodreads
// tidies up after it (scroll lock, focus) the way it does when you click the button.
// Other overlays, such as the share menu, are left alone.
function closeSignupPopup() {
  const box = document.querySelector('.LoginInterstitial');
  const close = box && box.closest('.Overlay')?.querySelector('button[aria-label="Close"]');
  if (close) close.click();
}
new MutationObserver(closeSignupPopup).observe(document.documentElement, { childList: true, subtree: true });
