// ==UserScript==
// @name         Make the ChatGPT chat wider
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Lets the ChatGPT conversation and message box use the full width of the window instead of a narrow center column.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/chatgpt/wide-chat.user.js
// @updateURL    https://usermods.kennethballenegger.com/chatgpt/wide-chat.user.js
// ==/UserScript==

// CSS only. ChatGPT rebuilds the document head while it loads, which throws away styles
// added at document-start, so the style element is put back whenever it goes missing.
// At document-start there may be no <html> element yet; the observer adds it once there is.
const style = document.createElement('style');
style.textContent = `
  /* Logged-out app: the conversation column and the message box are each capped at 768px. */
  main[data-slot="conversation"] > div,
  div[data-slot="composer"] > div[data-slot="composer-replacement"] {
    max-width: none !important;
    padding-inline: 32px !important;
    box-sizing: border-box !important;
  }

  /* Signed-in app: the column width comes from the --thread-content-max-width variable. */
  * {
    --thread-content-max-width: 100% !important;
  }
  [class*="thread-content-max-width"] {
    max-width: 100% !important;
  }
`;

function attach() {
  const parent = document.head || document.documentElement;
  if (parent && !style.isConnected) parent.append(style);
}
attach();
new MutationObserver(attach).observe(document, { childList: true, subtree: true });
