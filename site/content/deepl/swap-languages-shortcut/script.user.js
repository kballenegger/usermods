// ==UserScript==
// @name         Swap languages on DeepL with Ctrl+Shift+S
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Ctrl+Shift+S keyboard shortcut that swaps the source and target languages in the DeepL web translator.
// @match        https://www.deepl.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/deepl/swap-languages-shortcut.user.js
// @updateURL    https://usermods.kennethballenegger.com/deepl/swap-languages-shortcut.user.js
// ==/UserScript==

// Ctrl+Shift+S is Google Translate's swap shortcut, so it is the one people reach for.
// The listener runs in the capture phase on window so it also fires while the cursor is in
// a text box. It clicks DeepL's own swap button, which keeps the text and the URL in step the
// same way a mouse click does. When the source is "Detect language" the button is disabled
// and the shortcut does nothing, as with the button.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyS' || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.repeat) return;
  const swap = document.querySelector('[data-testid="lmt_language_switch"]');
  if (!swap) return;
  e.preventDefault();
  e.stopPropagation();
  if (!swap.disabled) swap.click();
}, true);
