// ==UserScript==
// @name         Hide unused languages on Wikipedia
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Shows only the languages you choose in Wikipedia's language menu and hides the rest.
// @match        https://*.wikipedia.org/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/wikipedia/hide-unused-languages.user.js
// @updateURL    https://usermods.kennethballenegger.com/wikipedia/hide-unused-languages.user.js
// ==/UserScript==

// Edit this list: Wikipedia language codes, as in the subdomain (de.wikipedia.org is "de").
const KEEP = ['de', 'fr', 'es'];

// The languages set in your browser are kept too ("en-US" keeps "en").
const codes = new Set([...KEEP, ...navigator.languages.map((l) => l.split('-')[0].toLowerCase())]);

// Every entry in the language menu, the old sidebar list and the newer search dialog alike,
// is an li.interlanguage-link with an interwiki-<code> class. Hide every entry whose code
// is not in the list.
const keep = [...codes].map((c) => `:not(.interwiki-${CSS.escape(c)})`).join('');
GM_addStyle(`li.interlanguage-link${keep} { display: none !important; }`);
