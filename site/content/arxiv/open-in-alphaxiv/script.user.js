// ==UserScript==
// @name         Open arXiv papers on alphaXiv
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds an "alphaXiv" button next to View PDF on arXiv abstract pages that opens the same paper on alphaxiv.org.
// @match        https://arxiv.org/abs/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/arxiv/open-in-alphaxiv.user.js
// @updateURL    https://usermods.kennethballenegger.com/arxiv/open-in-alphaxiv.user.js
// ==/UserScript==

// arXiv renders abstract pages on the server, so the "Access Paper" list is there once the
// document has loaded. alphaXiv uses the same paper ids: arxiv.org/abs/<id> becomes
// alphaxiv.org/abs/<id>. The id comes from the citation_arxiv_id meta tag, with the version
// from the address bar kept when there is one (for example /abs/1706.03762v5).
(() => {
  const list = document.querySelector('.full-text ul');
  const meta = document.querySelector('meta[name="citation_arxiv_id"]');
  if (!list || !meta) return;

  const fromPath = decodeURIComponent(location.pathname.replace(/^\/abs\//, ''));
  const id = fromPath.startsWith(meta.content) ? fromPath : meta.content;

  const link = document.createElement('a');
  link.className = 'abs-button usermods-alphaxiv';
  link.href = `https://www.alphaxiv.org/abs/${id}`;
  link.textContent = 'alphaXiv';
  const item = document.createElement('li');
  item.append(link);
  list.append(item);
})();
