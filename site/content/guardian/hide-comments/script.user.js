// ==UserScript==
// @name         Hide comments on the Guardian
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Hides the comments section and comment counts on Guardian articles.
// @match        https://www.theguardian.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/guardian/hide-comments.user.js
// @updateURL    https://usermods.kennethballenegger.com/guardian/hide-comments.user.js
// ==/UserScript==

// The Guardian renders each interactive part of an article as a <gu-island name="...">.
// DiscussionWeb is the comments section and DiscussionMeta the heading above it;
// CommentCount is the comment count next to the byline.
GM_addStyle(`
  #comments,
  gu-island[name="DiscussionWeb"],
  gu-island[name="CommentCount"],
  gu-island[name="DiscussionMeta"] {
    display: none !important;
  }
`);
