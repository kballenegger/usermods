// ==UserScript==
// @name         Full-screen Hugging Face Spaces
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the header bar on Hugging Face Space pages so the app fills the whole window, with a small button to bring the bar back.
// @match        https://huggingface.co/spaces/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/huggingface/spaces-fullscreen.user.js
// @updateURL    https://usermods.kennethballenegger.com/huggingface/spaces-fullscreen.user.js
// ==/UserScript==

// A running Space is an iframe.space-iframe under a single <header> bar (name, likes, App,
// Files, Community). The rule only applies while that iframe is on the page, so the Files and
// Community tabs keep their header.
GM_addStyle(`
  html:not(.um-space-header) body:has(iframe.space-iframe) header { display: none !important; }
  .um-space-toggle { position: fixed; right: 8px; bottom: 8px; z-index: 2147483647;
    padding: 2px 8px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff;
    color: #4b5563; font: 12px system-ui, sans-serif; opacity: 0.6; cursor: pointer; }
  .um-space-toggle:hover { opacity: 1; }
  body:not(:has(iframe.space-iframe)) .um-space-toggle { display: none; }
`);

function addToggle() {
  if (document.querySelector('.um-space-toggle')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'um-space-toggle';
  button.textContent = 'Show header';
  button.addEventListener('click', () => {
    const shown = document.documentElement.classList.toggle('um-space-header');
    button.textContent = shown ? 'Hide header' : 'Show header';
  });
  document.body.append(button);
}

if (document.body) addToggle();
else document.addEventListener('DOMContentLoaded', addToggle);
