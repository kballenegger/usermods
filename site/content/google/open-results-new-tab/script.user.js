// ==UserScript==
// @name         Open Google search results in a new tab
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Makes the links in Google Search results open in a new tab.
// @match        https://www.google.com/search*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/google/open-results-new-tab.user.js
// @updateURL    https://usermods.kennethballenegger.com/google/open-results-new-tab.user.js
// ==/UserScript==

// Every link in the results list (#rso) that leads off the results page gets
// target="_blank". Google's result links go through /goto or /url first, so those count
// as leaving too. Results load in stages, so a MutationObserver handles new ones.
function leavesResults(a) {
  return a.hostname !== location.hostname || a.pathname === '/goto' || a.pathname === '/url';
}

function retarget() {
  for (const a of document.querySelectorAll('#rso a[href], #botstuff a[href]')) {
    if (a.target !== '_blank' && leavesResults(a)) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  }
}

new MutationObserver(retarget).observe(document, { childList: true, subtree: true });
