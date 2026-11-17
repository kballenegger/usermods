// ==UserScript==
// @name         Redirect Python 2 docs to Python 3
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Sends docs.python.org pages for Python 2 to the same page in the current Python 3 docs.
// @match        https://docs.python.org/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/python-docs/latest-version-redirect.user.js
// @updateURL    https://usermods.kennethballenegger.com/python-docs/latest-version-redirect.user.js
// ==/UserScript==

// Paths look like /2/library/os.html or /2.7/library/os.html, optionally after a language
// code (/fr/2.7/...). Swap the version for /3/, which always serves the current stable
// release. Python 3 pages, including pinned versions such as /3.12/, are left alone.
(() => {
  const m = location.pathname.match(/^(\/[a-z]{2}(?:-[a-z]{2})?)?\/2(?:\.\d+)?(\/.*)?$/i);
  if (!m) return;
  location.replace((m[1] || '') + '/3' + (m[2] || '/') + location.search + location.hash);
})();
