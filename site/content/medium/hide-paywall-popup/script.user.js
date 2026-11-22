// ==UserScript==
// @name         Close Medium's sign-up popups
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Closes the "Join Medium" popups that open by themselves while you read, and leaves the ones you open alone.
// @match        https://medium.com/*
// @match        https://*.medium.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/medium/hide-paywall-popup.user.js
// @updateURL    https://usermods.kennethballenegger.com/medium/hide-paywall-popup.user.js
// ==/UserScript==

(() => {
  // Medium's popups are modal dialogs (role="dialog", aria-modal="true") with a close
  // button marked data-testid="close-button". The script presses that button, which also
  // gives the page its scroll back. A dialog that first shows up within two seconds of your
  // own click (Sign in, Sign up, Share) is one you asked for, so it is remembered and left
  // open for as long as it stays on the page.
  let lastClick = 0;
  document.addEventListener('click', (event) => {
    if (event.isTrusted) lastClick = Date.now();
  }, true);

  const invited = new WeakSet();
  const closeUninvited = () => {
    for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
      if (invited.has(dialog) || !dialog.checkVisibility()) continue;
      if (Date.now() - lastClick < 2000) {
        invited.add(dialog);
        continue;
      }
      const close = dialog.querySelector('button[data-testid="close-button"]');
      if (!close) continue;
      close.click();
      const root = document.documentElement;
      root.dataset.usermodsClosedPopups = String(Number(root.dataset.usermodsClosedPopups || 0) + 1);
    }
  };

  new MutationObserver(closeUninvited).observe(document, { childList: true, subtree: true });
})();
