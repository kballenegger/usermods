// ==UserScript==
// @name         Block sites from DuckDuckGo results
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides DuckDuckGo web results from the domains in a list you edit, including their subdomains.
// @match        https://duckduckgo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/duckduckgo/block-domains.user.js
// @updateURL    https://usermods.kennethballenegger.com/duckduckgo/block-domains.user.js
// ==/UserScript==

// Edit this list. Each entry hides that domain and every subdomain of it
// ("quora.com" also hides www.quora.com and help.quora.com).
const BLOCKED = ['quora.com', 'pinterest.com'];

// Each web result is an <article data-testid="result"> inside an <li>. The rule matches the
// result's title link by the start of its URL, so it is plain CSS: it applies before the
// results paint and to every page of results DuckDuckGo loads later.
const link = 'a[data-testid="result-title-a"]';
const selectors = BLOCKED.map((d) => {
  const hosts = [`[href^="https://${d}/"]`, `[href^="http://${d}/"]`, `[href^="https://"][href*=".${d}/"]`, `[href^="http://"][href*=".${d}/"]`];
  return `li:has(> article[data-testid="result"] ${link}:is(${hosts.join(', ')}))`;
});
GM_addStyle(`${selectors.join(',\n')} { display: none !important; }`);
