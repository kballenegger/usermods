// ==UserScript==
// @name         Mark paywalled links on Hacker News
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a [paywall] tag next to Hacker News stories from sites that put articles behind a paywall.
// @match        https://news.ycombinator.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/hackernews/paywall-marker.user.js
// @updateURL    https://usermods.kennethballenegger.com/hackernews/paywall-marker.user.js
// ==/UserScript==

// Sites that paywall most of their articles. Edit this list to taste; a subdomain of a
// listed site (asia.nikkei.com) counts as that site.
const PAYWALLED = [
  'barrons.com', 'bloomberg.com', 'bostonglobe.com', 'economist.com', 'fortune.com',
  'foreignaffairs.com', 'ft.com', 'hbr.org', 'latimes.com', 'lrb.co.uk', 'newscientist.com',
  'newyorker.com', 'nikkei.com', 'nybooks.com', 'nytimes.com', 'scientificamerican.com',
  'seekingalpha.com', 'stratechery.com', 'technologyreview.com', 'telegraph.co.uk',
  'theathletic.com', 'theatlantic.com', 'theglobeandmail.com', 'theinformation.com',
  'thetimes.co.uk', 'washingtonpost.com', 'wired.com', 'wsj.com',
];

GM_addStyle(`
  .um-paywall { margin-left: 4px; padding: 0 3px; border: 1px solid #c33; border-radius: 2px;
    color: #c33; font-size: 8pt; }
`);

// Hacker News prints the story's site in span.sitestr ("nytimes.com", or "github.com/user"
// for some hosts). The page is rendered on the server, so one pass at document-end is enough.
for (const site of document.querySelectorAll('.titleline .sitestr')) {
  const host = site.textContent.trim().split('/')[0].toLowerCase();
  if (!PAYWALLED.some((d) => host === d || host.endsWith('.' + d))) continue;
  const sitebit = site.closest('.sitebit');
  if (sitebit.nextElementSibling?.classList.contains('um-paywall')) continue;
  const tag = document.createElement('span');
  tag.className = 'um-paywall';
  tag.textContent = 'paywall';
  tag.title = 'This site puts most articles behind a paywall';
  sitebit.after(tag);
}
