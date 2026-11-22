// ==UserScript==
// @name         Skip YouTube's link redirect page
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Makes links in YouTube descriptions and comments go straight to the site they point to instead of through youtube.com/redirect.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/clean-description-links.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/clean-description-links.user.js
// ==/UserScript==

// YouTube wraps outside links as https://www.youtube.com/redirect?...&q=<real address>.
// Opening one goes through YouTube's redirect page, which logs the click and sometimes
// shows a "You are leaving YouTube" warning. The script rewrites each such link to the
// real address in its q parameter, so hovering shows where it goes and copying it copies
// the real address.
function realTarget(href) {
  try {
    const url = new URL(href, location.href);
    if (url.hostname.endsWith('youtube.com') && url.pathname === '/redirect') return url.searchParams.get('q');
  } catch {}
  return null;
}

function rewrite() {
  for (const a of document.querySelectorAll('a[href*="/redirect?"]')) {
    const target = realTarget(a.href);
    if (!target) continue;
    a.href = target;
    // Some description links have no target, and YouTube's handler, which the script
    // bypasses below, is what opened them in a new tab.
    a.target = '_blank';
    a.rel = 'noopener';
    a.dataset.usermodsDirect = '';
  }
}

// Descriptions and comments load after the page and change on in-page navigation.
new MutationObserver(rewrite).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });

// YouTube opens these links with its own click handler, which still uses the redirect
// address it stored. Stopping a left click or middle click on a rewritten link before it
// reaches that handler lets the browser follow the real address itself, in the new tab
// rewrite() asked for. Listening on window in the capture phase runs before YouTube.
function bypass(e) {
  if (e.button > 1 || !(e.target instanceof Element)) return;
  if (e.target.closest('a[data-usermods-direct]')) e.stopPropagation();
}
window.addEventListener('click', bypass, true);
window.addEventListener('auxclick', bypass, true);
