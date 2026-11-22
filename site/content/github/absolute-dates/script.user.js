// ==UserScript==
// @name         Show absolute dates on GitHub
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Shows real dates such as "Nov 14, 2026" on GitHub instead of "3 days ago", in file lists, issue and pull request lists, commits and comments.
// @match        https://github.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/github/absolute-dates.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/absolute-dates.user.js
// ==/UserScript==

// GitHub prints dates with its <relative-time> element, which already knows the exact
// time and can format it itself. Setting format="datetime" plus the date parts makes it
// show the calendar date in your browser's locale; hovering still shows the full time.
// An empty weekday attribute stops it adding "Tue," in front of every date.
const ATTRS = { format: 'datetime', year: 'numeric', month: 'short', day: 'numeric', weekday: '' };

function fix(el) {
  for (const [name, value] of Object.entries(ATTRS)) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
}

function fixAll() {
  for (const el of document.querySelectorAll('relative-time')) fix(el);
}

// Lists load and re-render in place, so new and changed elements are fixed as they appear.
new MutationObserver(fixAll).observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: Object.keys(ATTRS),
});
