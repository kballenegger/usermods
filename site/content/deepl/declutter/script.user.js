// ==UserScript==
// @name         Remove clutter and upsells from DeepL
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Hides the promo banner, the Pro-only side panel items and the marketing sections under the DeepL translator.
// @match        https://www.deepl.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/deepl/declutter.user.js
// @updateURL    https://usermods.kennethballenegger.com/deepl/declutter.user.js
// ==/UserScript==

// DeepL's class names are generated, so these rules hang off its data-testid attributes and
// the "Pro" badge component, which keep their names between releases.
GM_addStyle(`
  /* The promo strip under the top navigation. */
  [data-testid="below-navigation-banner"] { display: none !important; }

  /* Side panel entries that only open a Pro upgrade prompt (Formality, Style profiles,
     Style rules). Glossaries, which works without an account, stays. */
  [data-testid="side-panel"] button:has([data-dui-component="Badge"].as-pro) { display: none !important; }

  /* Everything under the translator: customer logos, product tours, customer stories,
     API pitch and the language-pair link list. The translator itself sits in <main>. */
  [data-testid="translator"] > div:not(:has(main)):has(section) { display: none !important; }
`);
