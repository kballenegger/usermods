// ==UserScript==
// @name         Add a Google button to DuckDuckGo
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Google tab next to All, Images and Videos on DuckDuckGo that runs the same search on Google.
// @match        https://duckduckgo.com/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/duckduckgo/google-button.user.js
// @updateURL    https://usermods.kennethballenegger.com/duckduckgo/google-button.user.js
// ==/UserScript==

// DuckDuckGo draws its tab bar (All, Images, Videos, More) with React and redraws it on new
// searches, so the button is added again whenever it goes missing, and its link is rebuilt from
// the q parameter in the address bar each time. It copies the class of an inactive tab so it
// looks like the others.
function addGoogleButton() {
  const query = new URLSearchParams(location.search).get('q');
  const tabs = document.querySelector('[data-testid="duckbar"] nav ul');
  if (!query || !tabs) return;
  const href = 'https://www.google.com/search?q=' + encodeURIComponent(query);
  let link = tabs.querySelector('a[data-usermods="google-button"]');
  if (!link) {
    const model = [...tabs.querySelectorAll('li > a')].find((a) => !a.querySelector('strong')?.textContent.includes('All')) ?? tabs.querySelector('li > a');
    const item = document.createElement('li');
    link = document.createElement('a');
    link.dataset.usermods = 'google-button';
    if (model) link.className = model.className;
    const label = document.createElement('strong');
    label.textContent = 'Google';
    link.append(label);
    item.append(link);
    // Put it before the More menu when there is one, so it stays in the visible row.
    const more = [...tabs.children].find((li) => li.querySelector('button'));
    tabs.insertBefore(item, more ?? null);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

addGoogleButton();
new MutationObserver(addGoogleButton).observe(document.body, { childList: true, subtree: true });
