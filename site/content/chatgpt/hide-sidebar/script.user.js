// ==UserScript==
// @name         Hide the ChatGPT sidebar
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Closes the ChatGPT sidebar when the page loads and hides the icon rail left behind, so the chat uses the full width of the window.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/chatgpt/hide-sidebar.user.js
// @updateURL    https://usermods.kennethballenegger.com/chatgpt/hide-sidebar.user.js
// ==/UserScript==

// ChatGPT's own "Close sidebar" button shrinks the sidebar to a narrow rail of icons and
// marks the app shell with data-desktop-sidebar-collapsed. The CSS below hides that rail
// and moves the header, chat and message box to the left edge. It only applies while the
// sidebar is collapsed, so opening it again (with the keyboard shortcut) still works.
const style = document.createElement('style');
style.textContent = `
  [data-desktop-sidebar-collapsed] div:has(> aside#ds-sidebar) {
    display: none !important;
  }
  /* The chat column sits in a grid wider than the window; 100vw keeps it to the window. */
  [data-desktop-sidebar-collapsed] main[data-slot="conversation"],
  [data-desktop-sidebar-collapsed] footer[data-ds-composer] {
    left: 0 !important;
    width: 100vw !important;
  }
  [data-desktop-sidebar-collapsed] header[data-slot="header"] {
    margin-left: 0 !important;
    width: 100% !important;
  }
`;

// ChatGPT rebuilds the document head while it loads, which drops styles added at
// document-start, so the style element is put back whenever it goes missing.
function attach() {
  const parent = document.head || document.documentElement;
  if (parent && !style.isConnected) parent.append(style);
}

// Collapse the sidebar once per page load by pressing ChatGPT's own button. The button is
// in the server-rendered page before React makes it work, so a click is only tried after the
// load event and is tried again a second later if the sidebar did not collapse. Once the
// sidebar has been collapsed the script stops clicking, so you can open it again by hand.
// ChatGPT remembers the choice, so later loads usually start collapsed.
let done = false;
let lastClick = 0;
function collapse() {
  if (done || document.readyState !== 'complete') return;
  const shell = document.querySelector('[data-app-shell]');
  if (!shell) return;
  if (shell.hasAttribute('data-desktop-sidebar-collapsed')) {
    done = true;
    return;
  }
  if (Date.now() - lastClick < 1000) return;
  const button = [...document.querySelectorAll('button[aria-label="Close sidebar"]')].find((b) => b.checkVisibility());
  if (button) {
    lastClick = Date.now();
    button.click();
    setTimeout(collapse, 1000);
  }
}

attach();
new MutationObserver(() => {
  attach();
  collapse();
}).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-desktop-sidebar-collapsed'] });
window.addEventListener('load', collapse);
