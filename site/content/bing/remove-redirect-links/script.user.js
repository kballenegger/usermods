// ==UserScript==
// @name         Remove Bing's tracking redirects from results
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Rewrites Bing's bing.com/ck/a redirect links in search results to point straight at the destination site.
// @match        https://www.bing.com/search*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/bing/remove-redirect-links.user.js
// @updateURL    https://usermods.kennethballenegger.com/bing/remove-redirect-links.user.js
// ==/UserScript==

// Bing wraps result links as https://www.bing.com/ck/a?...&u=a1<base64url of the target>.
// The "a1" prefix marks the encoding; the rest is base64url without padding.
(() => {
  const decode = (href) => {
    let u;
    try { u = new URL(href).searchParams.get('u'); } catch { return null; }
    if (!u || !u.startsWith('a1')) return null;
    let b64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    let target;
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      target = new TextDecoder().decode(bytes);
    } catch { return null; }
    // Only accept a real http(s) URL so a malformed parameter can't become a javascript: link.
    return /^https?:\/\//i.test(target) ? target : null;
  };

  const fix = () => {
    for (const a of document.querySelectorAll('a[href*="bing.com/ck/a?"]')) {
      const target = decode(a.href);
      if (target) a.href = target;
    }
  };

  // Results stream in, and Bing re-renders parts of the page, so rewrite on every change.
  new MutationObserver(fix).observe(document, { childList: true, subtree: true });
})();
