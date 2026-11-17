// ==UserScript==
// @name         Skip Steam's link filter warning
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Points Steam's outbound links straight at their destination instead of the "You are about to leave Steam" link filter page.
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/steam/direct-links.user.js
// @updateURL    https://usermods.kennethballenegger.com/steam/direct-links.user.js
// ==/UserScript==

// Steam wraps outside links as https://steamcommunity.com/linkfilter/?u=<destination>
// (older links use ?url=). Only http and https destinations are followed.
const target = (href) => {
  let u;
  try { u = new URL(href, location.href); } catch { return null; }
  if (u.hostname !== 'steamcommunity.com' || !u.pathname.startsWith('/linkfilter')) return null;
  const dest = u.searchParams.get('u') || u.searchParams.get('url');
  return dest && /^https?:\/\//i.test(dest) ? dest : null;
};

// Landing on the filter page itself (from a chat message, say) goes straight on.
const here = target(location.href);
if (here) location.replace(here);

// Rewrite every filtered link on the page, including ones added later by reviews,
// discussions and other content that loads after the page.
const fix = () => {
  for (const a of document.querySelectorAll('a[href*="/linkfilter/"]')) {
    const dest = target(a.href);
    if (dest) a.href = dest;
  }
};
new MutationObserver(fix).observe(document.documentElement, { childList: true, subtree: true });
