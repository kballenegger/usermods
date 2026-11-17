// ==UserScript==
// @name         Send ChatGPT messages with Ctrl+Enter
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  In the ChatGPT message box, Enter adds a new line and Ctrl+Enter (Cmd+Enter on a Mac) sends.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/chatgpt/ctrl-enter-to-send.user.js
// @updateURL    https://usermods.kennethballenegger.com/chatgpt/ctrl-enter-to-send.user.js
// ==/UserScript==

// ChatGPT has two message boxes: a plain <textarea name="prompt"> (logged-out visitors)
// and a contenteditable #prompt-textarea (signed-in accounts).
const COMPOSER = '#prompt-textarea, form textarea[name="prompt"]';
const SEND = 'button[data-testid="send-button"], button[aria-label="Send message"]';

// Listening on window in the capture phase runs this before ChatGPT's own key handler,
// so stopping the event here keeps ChatGPT from sending on a plain Enter.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) return;
  const box = event.target instanceof Element ? event.target.closest(COMPOSER) : null;
  if (!box) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  if (event.ctrlKey || event.metaKey) {
    // Send: press the send button in the same form as the message box.
    const scope = box.closest('form') || document;
    const button = scope.querySelector(SEND) || document.querySelector(SEND);
    if (button && !button.disabled) button.click();
    return;
  }

  // Plain Enter: add a new line instead of sending.
  if (box instanceof HTMLTextAreaElement) {
    document.execCommand('insertText', false, '\n');
  } else {
    // The signed-in editor already treats Shift+Enter as a new line.
    box.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, bubbles: true, cancelable: true,
    }));
  }
}, true);
