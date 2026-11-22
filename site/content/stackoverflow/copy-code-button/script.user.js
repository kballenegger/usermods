// ==UserScript==
// @name         Add a copy button to code on Stack Overflow
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Copy button to the top right of every code block in Stack Overflow questions and answers.
// @match        https://stackoverflow.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/stackoverflow/copy-code-button.user.js
// @updateURL    https://usermods.kennethballenegger.com/stackoverflow/copy-code-button.user.js
// ==/UserScript==

// Code blocks scroll sideways, so the button can't live inside the <pre>: it
// would scroll away with the code. Each block gets a positioned wrapper instead.
GM_addStyle(`
  .um-copy-wrap { position: relative; }
  .um-copy-wrap > .um-copy {
    position: absolute; top: 6px; right: 6px;
    opacity: 0.6;
  }
  .um-copy-wrap:hover > .um-copy, .um-copy-wrap > .um-copy:focus-visible { opacity: 1; }
`);

function addButton(pre) {
  const wrap = document.createElement('div');
  wrap.className = 'um-copy-wrap';
  pre.replaceWith(wrap);
  wrap.append(pre);

  const button = document.createElement('button');
  button.type = 'button';
  // Stack Overflow's own button classes, so it follows the light and dark themes.
  button.className = 'um-copy s-btn s-btn__muted s-btn__outlined s-btn__xs';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code to clipboard');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.innerText);
      button.textContent = 'Copied';
    } catch (err) {
      button.textContent = 'Copy failed';
      console.error('[copy-code-button]', err);
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  });
  wrap.append(button);
}

// Post bodies, plus the live preview under the answer editor.
function scan() {
  for (const pre of document.querySelectorAll('.s-prose pre')) {
    if (!pre.parentElement.classList.contains('um-copy-wrap')) addButton(pre);
  }
}

scan();
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
