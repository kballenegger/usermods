// ==UserScript==
// @name         Show DuckDuckGo results in columns
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Lays DuckDuckGo web results out in two or more columns across the full window width and moves the sidebar below them.
// @match        https://duckduckgo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/duckduckgo/multi-column.user.js
// @updateURL    https://usermods.kennethballenegger.com/duckduckgo/multi-column.user.js
// ==/UserScript==

// DuckDuckGo's class names are generated, so the rules use its test ids. The results column
// (data-testid="mainline") and the sidebar (data-testid="sidebar") are flex siblings; letting
// them wrap gives the results the full width and puts the sidebar underneath. The result
// list then becomes a grid with as many 440px-or-wider columns as fit. Anything in the list
// that is not a web result (the "More results" button, related searches) spans the full row.
GM_addStyle(`
  :has(> section[data-testid="mainline"]) { flex-wrap: wrap !important; }
  section[data-testid="mainline"] { flex: 1 1 100% !important; width: 100% !important; max-width: none !important; }
  section[data-testid="sidebar"] { margin-left: 0 !important; }
  ol.react-results--main {
    display: grid !important;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr));
    column-gap: 32px;
    align-items: start;
  }
  ol.react-results--main > li:not(:has(> article[data-testid="result"])) { grid-column: 1 / -1; }
`);
