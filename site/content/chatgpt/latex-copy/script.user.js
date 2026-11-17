// ==UserScript==
// @name         Copy math from ChatGPT as LaTeX
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Click an equation in a ChatGPT reply to copy its LaTeX source, and keep the LaTeX when you copy a selection that contains math.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/chatgpt/latex-copy.user.js
// @updateURL    https://usermods.kennethballenegger.com/chatgpt/latex-copy.user.js
// ==/UserScript==

(() => {
  // ChatGPT renders math with KaTeX inside elements marked data-d-component="math". KaTeX keeps
  // the original source in <annotation encoding="application/x-tex">, so nothing has to be
  // reconstructed: the script reads that element.
  const MATH = '[data-d-component="math"]';
  const source = (math) => math.querySelector('annotation[encoding="application/x-tex"]')?.textContent.trim() ?? '';

  GM_addStyle(`
    ${MATH} { cursor: copy; }
    ${MATH}:hover { outline: 1px dashed rgba(127, 127, 127, 0.6); outline-offset: 2px; border-radius: 4px; }
    ${MATH}.usermods-copied { outline: 2px solid #10a37f; outline-offset: 2px; border-radius: 4px; }
  `);

  // Click an equation: copy its LaTeX without delimiters. Skip clicks that end a text
  // selection so selecting across an equation still works.
  document.addEventListener('click', (e) => {
    const math = e.target instanceof Element && e.target.closest(MATH);
    if (!math || !getSelection().isCollapsed) return;
    const tex = source(math);
    if (!tex) return;
    navigator.clipboard.writeText(tex);
    math.classList.add('usermods-copied');
    math.title = 'LaTeX copied';
    setTimeout(() => math.classList.remove('usermods-copied'), 900);
  });

  // Copy a selection that contains math: by default the clipboard gets KaTeX's rendered
  // glyphs, often twice. Replace each equation with $...$ (inline) or $$...$$ (block).
  document.addEventListener('copy', (e) => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !e.clipboardData) return;
    const box = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) box.append(sel.getRangeAt(i).cloneContents());
    const maths = box.querySelectorAll(MATH);
    if (!maths.length) return;
    for (const math of maths) {
      const tex = source(math);
      const block = math.hasAttribute('data-d-block');
      math.replaceWith(block ? `\n$$\n${tex}\n$$\n` : `$${tex}$`);
    }
    // innerText needs the element in the document to keep line breaks between blocks.
    box.style.cssText = 'position: fixed; left: -99999px; top: 0; white-space: pre-wrap;';
    document.body.append(box);
    const text = box.innerText.replace(/\n{3,}/g, '\n\n').trim();
    box.remove();
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  });
})();
