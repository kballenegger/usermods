// ==UserScript==
// @name         Open Wikipedia articles in Wikiwand
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Sends Wikipedia article links to the same article on Wikiwand, in the same language.
// @match        https://*.wikipedia.org/wiki/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/wikipedia/redirect-to-wikiwand.user.js
// @updateURL    https://usermods.kennethballenegger.com/wikipedia/redirect-to-wikiwand.user.js
// ==/UserScript==

(() => {
  if (!location.hostname.endsWith('.wikipedia.org')) return;

  // Coming back from Wikiwand (its "view on Wikipedia" link, for editing or history)
  // stays on Wikipedia instead of bouncing straight back.
  if (/(^|\.)wikiwand\.com$/.test(document.referrer && new URL(document.referrer).hostname)) return;

  // Old revisions, diffs and edit or history views only exist on Wikipedia.
  const params = new URLSearchParams(location.search);
  if (['action', 'oldid', 'diff', 'curid'].some((p) => params.has(p))) return;

  const title = location.pathname.slice('/wiki/'.length);
  if (!title || title === 'Main_Page') return;

  // Skip pages outside the article namespace (Special:, Talk:, File:, Category: ...).
  // English names only; on other languages these pages fall through to Wikiwand.
  const ns = decodeURIComponent(title).split(':')[0].replace(/_/g, ' ');
  const namespaces = ['Special', 'Talk', 'User', 'User talk', 'Wikipedia', 'Wikipedia talk', 'File',
    'File talk', 'MediaWiki', 'Template', 'Template talk', 'Help', 'Help talk', 'Category',
    'Category talk', 'Portal', 'Portal talk', 'Draft', 'Draft talk', 'Module', 'Module talk',
    'TimedText', 'Image', 'WP', 'Project'];
  if (title.includes(':') && namespaces.includes(ns)) return;

  // en.wikipedia.org and en.m.wikipedia.org both map to /en/ on Wikiwand.
  const lang = location.hostname.split('.')[0];
  location.replace(`https://www.wikiwand.com/${lang}/${title}${location.hash}`);
})();
