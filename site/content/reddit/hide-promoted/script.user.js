// ==UserScript==
// @name         Hide promoted posts on Reddit
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides promoted posts in Reddit feeds and the ads in the sidebar and between comments.
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/reddit/hide-promoted.user.js
// @updateURL    https://usermods.kennethballenegger.com/reddit/hide-promoted.user.js
// ==/UserScript==

// Reddit renders each ad as its own custom element, so element names are enough:
// shreddit-ad-post is a promoted post in a feed, shreddit-sidebar-ad the box on the right,
// shreddit-comments-page-ad and shreddit-comment-tree-ads the ads on a post's page.
// Feed items are separated by <hr> lines; the one after an ad is hidden too so no double line is left.
GM_addStyle(`
  shreddit-ad-post,
  shreddit-ad-post + hr,
  shreddit-sidebar-ad,
  shreddit-comments-page-ad,
  shreddit-comment-tree-ads {
    display: none !important;
  }
`);
