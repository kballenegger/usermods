// ==UserScript==
// @name         Show the full YouTube description
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Opens the full video description on YouTube watch pages without clicking "...more".
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/expand-description.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/expand-description.user.js
// ==/UserScript==

// The description box under a video is a <ytd-text-inline-expander>. YouTube shows the
// first few lines and a "...more" button (#expand) that opens the rest. The script clicks
// that button once for each video you open, so YouTube expands the text itself and the
// "Show less" button still works if you want to collapse it again.
let handled = '';

function expand() {
  if (location.pathname !== '/watch') return;
  const id = new URLSearchParams(location.search).get('v');
  if (!id || id === handled) return;
  const expander = document.querySelector('ytd-watch-metadata ytd-text-inline-expander');
  const more = expander && expander.querySelector('#expand');
  if (!more) return; // description not rendered yet; the observer tries again
  handled = id;
  if (!expander.hasAttribute('is-expanded')) more.click();
}

// The description arrives after the page shell and is replaced on in-page navigation,
// so watch the document and try again on each change until this video's box is open.
new MutationObserver(expand).observe(document, { childList: true, subtree: true });
document.addEventListener('yt-navigate-finish', expand);
