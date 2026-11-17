// ==UserScript==
// @name         Skip SoundCloud's gate.sc link redirect
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Rewrites gate.sc redirect links on SoundCloud so they point straight at the real address.
// @match        https://soundcloud.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/soundcloud/direct-links.user.js
// @updateURL    https://usermods.kennethballenegger.com/soundcloud/direct-links.user.js
// ==/UserScript==

// SoundCloud wraps outbound links in descriptions, profiles and buy buttons as
// https://gate.sc/?url=<encoded address>&token=... . The real address is in the url parameter.
(() => {
  const unwrap = (a) => {
    let target;
    try {
      const u = new URL(a.href);
      if (u.hostname !== 'gate.sc') return;
      target = u.searchParams.get('url');
    } catch {
      return;
    }
    // Only accept plain web addresses, never javascript: or other schemes.
    if (target && /^https?:\/\//i.test(target)) a.href = target;
  };

  const scan = () => document.querySelectorAll('a[href*="gate.sc"]').forEach(unwrap);

  // SoundCloud renders pages client-side and swaps them on navigation, so rescan on every change.
  new MutationObserver(scan).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  scan();
})();
