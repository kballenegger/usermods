// ==UserScript==
// @name         Add a PDF download button on Internet Archive
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Download PDF button under the title of archive.org items that have a public PDF.
// @match        https://archive.org/details/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/archive/pdf-download-link.user.js
// @updateURL    https://usermods.kennethballenegger.com/archive/pdf-download-link.user.js
// ==/UserScript==

// archive.org already lists the PDF under "Download Options", further down the right-hand
// column. This copies that link up next to the title. Items you can only borrow have no
// PDF in that list, so nothing is added on them.
GM_addStyle(`
  #usermods-pdf-download {
    display: inline-block; margin: 6px 0 12px; padding: 6px 14px; border-radius: 4px;
    background: #194880; color: #fff !important; font-weight: bold; text-decoration: none;
  }
  #usermods-pdf-download:hover { background: #2c6bb3; }
`);

(() => {
  const title = document.querySelector('h1.item-title');
  const pills = [...document.querySelectorAll('.item-download-options a.download-pill[href$=".pdf"]')];
  if (!title || pills.length === 0 || document.getElementById('usermods-pdf-download')) return;
  // Prefer the plain "PDF" entry over variants such as "B/W PDF".
  const pdf = pills.find((a) => /^PDF\b/.test(a.textContent.trim())) || pills[0];
  const button = document.createElement('a');
  button.id = 'usermods-pdf-download';
  button.href = pdf.href;
  button.textContent = 'Download PDF';
  title.after(button);
})();
