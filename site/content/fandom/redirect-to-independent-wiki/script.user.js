// ==UserScript==
// @name         Redirect Fandom wikis to their independent versions
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Sends you from a Fandom wiki whose community moved away to the same page on the independent wiki.
// @match        https://*.fandom.com/*
// @run-at       document-start
// @noframes
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/fandom/redirect-to-independent-wiki.user.js
// @updateURL    https://usermods.kennethballenegger.com/fandom/redirect-to-independent-wiki.user.js
// ==/UserScript==

(() => {
  // Fandom subdomain -> article URL prefix on the wiki the community moved to.
  // The page title after /wiki/ is appended as is. Add your own lines here.
  const MOVED = {
    'minecraft': 'https://minecraft.wiki/w/',
    'terraria': 'https://terraria.wiki.gg/wiki/',
    'calamitymod': 'https://calamitymod.wiki.gg/wiki/',
    'ark': 'https://ark.wiki.gg/wiki/',
    'dontstarve': 'https://dontstarve.wiki.gg/wiki/',
    'oxygennotincluded': 'https://oxygennotincluded.wiki.gg/wiki/',
    'satisfactory': 'https://satisfactory.wiki.gg/wiki/',
    'riskofrain2': 'https://riskofrain2.wiki.gg/wiki/',
    'deadcells': 'https://deadcells.wiki.gg/wiki/',
    'hades': 'https://hades.wiki.gg/wiki/',
    'hollowknight': 'https://hollowknight.wiki/w/',
    'stardewvalley': 'https://stardewvalleywiki.com/',
    'teamfortress': 'https://wiki.teamfortress.com/wiki/',
    'warframe': 'https://wiki.warframe.com/w/',
    'runescape': 'https://runescape.wiki/w/',
    'oldschoolrunescape': 'https://oldschool.runescape.wiki/w/',
  };

  const sub = location.hostname.replace(/\.fandom\.com$/, '');
  const target = MOVED[sub];
  if (!target) return;

  // Only English article URLs (/wiki/Title). Language paths like /de/wiki/ are left alone,
  // because the independent wikis split languages differently.
  const m = location.pathname.match(/^\/wiki\/(.+)$/);
  if (m) {
    location.replace(target + m[1] + location.hash);
  } else if (location.pathname === '/' || location.pathname === '/wiki/') {
    location.replace(new URL(target).origin + '/');
  }
})();
