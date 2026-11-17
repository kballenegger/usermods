// ==UserScript==
// @name         Open Hacker News links in new tabs
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Makes story links, "comments" links and links inside comments on Hacker News open in a new tab.
// @match        https://news.ycombinator.com/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/open-links-new-tab.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/open-links-new-tab.user.js
// ==/UserScript==

(() => {
  // Story titles are .titleline > a, links in comments and in Ask HN text sit inside .commtext
  // and .toptext, and the "N comments" link is the item link in the line under each story.
  // Hacker News renders everything on the server, so one pass when the page has loaded is enough.
  const links = [
    ...document.querySelectorAll('.titleline > a, .commtext a, .toptext a'),
    ...[...document.querySelectorAll('.subline a[href^="item?id="]')].filter((a) =>
      /comment|discuss/i.test(a.textContent),
    ),
  ];
  for (const a of links) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
})();
