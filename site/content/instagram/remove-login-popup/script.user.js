// ==UserScript==
// @name         Remove Instagram's login popup
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Closes the "Sign up / Log in" popup Instagram shows logged-out visitors on profile pages, so the page scrolls again.
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/instagram/remove-login-popup.user.js
// @updateURL    https://usermods.kennethballenegger.com/instagram/remove-login-popup.user.js
// ==/UserScript==

// Instagram's sign-up popup is a modal dialog with a Close (X) button. While it is open,
// Instagram freezes the page behind it, so hiding the popup with CSS would leave a page
// that cannot scroll. Clicking Instagram's own Close button instead lets Instagram undo
// the freeze itself.
//
// The popup is told apart from other dialogs (a post opened in a modal, the share menu)
// by the Terms of Use and Privacy Policy links it carries. Class names are not used:
// Instagram generates them and they change often.
const SIGNUP_LINKS = 'a[href*="help.instagram.com/581066165581870"], a[href*="privacycenter.instagram.com/policy"]';

function closeLoginPopup() {
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (!dialog.querySelector(SIGNUP_LINKS)) continue;
    const close = dialog.querySelector('svg[aria-label="Close"]')?.closest('[role="button"], button');
    // The popup can be drawn before Instagram has wired up its buttons, so a click may do
    // nothing the first time. The observer calls this again on the next change.
    if (close) close.click();
  }
}

new MutationObserver(closeLoginPopup).observe(document, { childList: true, subtree: true });
