// ==UserScript==
// @name         Copy the download command for a Hugging Face model
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a button under the name of every Hugging Face model, dataset and Space that copies the hf download command for it.
// @match        https://huggingface.co/*
// @run-at       document-idle
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/huggingface/copy-download-command.user.js
// @updateURL    https://usermods.kennethballenegger.com/huggingface/copy-download-command.user.js
// ==/UserScript==

GM_addStyle(`
  .um-hf-dl { display: inline-flex; align-items: center; gap: 6px; margin: 0 0 12px; padding: 2px 8px;
    border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; color: #374151;
    font-size: 13px; cursor: pointer; }
  .um-hf-dl:hover { border-color: #9ca3af; }
  .um-hf-dl code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .um-hf-dl .um-hf-dl-state { color: #6b7280; }
`);

// The repo name in the page header is the monospace link inside the <h1>, with the repo path
// as its href: /owner/name for models, /datasets/owner/name, /spaces/owner/name.
function commandFor(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'datasets') return `hf download ${parts.slice(1, 3).join('/')} --repo-type dataset`;
  if (parts[0] === 'spaces') return `hf download ${parts.slice(1, 3).join('/')} --repo-type space`;
  return `hf download ${parts.slice(0, 2).join('/')}`;
}

function render() {
  const name = document.querySelector('h1 a.font-mono[href]');
  if (!name) return;
  const h1 = name.closest('h1');
  const command = commandFor(name.getAttribute('href'));
  let button = h1.nextElementSibling;
  if (button?.classList.contains('um-hf-dl')) {
    // Hugging Face swaps the header in place when you move to another repo.
    if (button.dataset.command === command) return;
    button.remove();
  }
  button = document.createElement('button');
  button.type = 'button';
  button.className = 'um-hf-dl';
  button.dataset.command = command;
  button.title = 'Copy the command that downloads every file in this repo';
  const code = document.createElement('code');
  code.textContent = command;
  const state = document.createElement('span');
  state.className = 'um-hf-dl-state';
  state.textContent = 'Copy';
  button.append(code, state);
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(command);
    state.textContent = 'Copied';
    setTimeout(() => { state.textContent = 'Copy'; }, 1500);
  });
  h1.after(button);
}

render();
// Hugging Face moves between pages without reloading, so re-check the header on changes.
new MutationObserver(render).observe(document.body, { childList: true, subtree: true });
