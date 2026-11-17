# Demand research: search, shopping, news, reference (R2)

Collected 2026-11-17. 85 tasks over 17 sites, ranked by score in `search-shopping-news.json`.

## Method

- **Greasy Fork**: per-site lists and keyword searches through `https://api.greasyfork.org/en/scripts/by-site/<domain>.json?sort=total_installs` and `.../scripts.json?q=<q>&sort=total_installs` (the `greasyfork.org` HTML pages sit behind a Cloudflare challenge; the `api.` host serves the same data). Only scripts written for that site count. Multi-site scripts (AC-baidu, ad blockers, URL cleaners, paywall bundles) were left out.
- **Chrome Web Store**: search pages (`chromewebstore.google.com/search/<q>`) give extension IDs; each detail page gives the user count. Only single-purpose extensions for the task count, so generic ones such as Dark Reader or BlockSite are left out.
- **Google autocomplete**: `suggestqueries.google.com/complete/search?client=firefox&hl=en&q=<q>`, about 140 queries. The bonus counts only when a suggestion asks for the task itself (e.g. "remove people also ask google"). Comparison queries such as "imdb vs rotten tomatoes" and broad prefixes such as "bing homepage" do not count.
- **Threads**: Reddit refuses both WebSearch and direct JSON access, so threads come from Google Search Community, Microsoft Q&A, the eBay Community, Amazon Seller Forums, Hacker News, Super User, Wikipedia talk pages and other forums. How-to articles and extension listings do not count as threads.

## Score

`score = round(min(100, 15 * log10(max(1, largest install or user count in the evidence)) + 5 if autocomplete returns the query + 5 if two or more separate threads ask for it))`

## Top 40

| # | Score | Site / task | Biggest number | AC | Threads | Notes |
|---|---|---|---|---|---|---|
| 1 | 99 | google/remove-ai-overview | 800,000 (Hide Google AI Overviews) | yes | 2 | Google has no setting for this. AI Overviews may not render for logged-out headless sessions or some regions; E3 pilot already covers this task. |
| 2 | 90 | google/block-sites | 200,000 (uBlacklist) | yes | 2 | Script keeps a domain list (GM storage) and hides matching results. |
| 3 | 85 | fandom/redirect-to-independent-wiki | 100,000 (Indie Wiki Buddy) | yes | 2 | Needs a mapping table of Fandom wikis to their new homes (e.g. minecraft.fandom.com to minecraft.wiki). |
| 4 | 79 | duckduckgo/hide-ai | 40,000 (DuckDuckGo No-AI Search) | yes | 2 | DDG has a setting and noai.duckduckgo.com; the script works without cookies or settings. |
| 5 | 76 | google/date-filter-buttons | 57,789 (Google Search Extra Buttons) | yes |  | The GF script adds past hour/day/week/month/year buttons; Google hides these under Tools. |
| 6 | 75 | amazon/hide-rufus | 20,000 (Adios Alexa for Shopping (formerly Rufus Remover)) | yes | 2 | Renamed 'Alexa for Shopping' in 2026. Not verified that the panel shows logged out; check with Browserbase. |
| 7 | 74 | google/dark-mode | 40,000 (Dark Theme for Google™) | yes |  | Google has a native dark theme; demand is for forcing it without signing in or when it doesn't stick. |
| 8 | 73 | imdb/show-other-ratings | 72,784 (MoreMovieRatings) |  |  | Needs cross-site fetches (GM_xmlhttpRequest) to RT/Metacritic; check usermods supports it. Autocomplete returns comparison queries, not this task, so no bonus. |
| 9 | 72 | wikipedia/dark-mode | 30,000 (Wikipedia night mode) | yes |  | Wikipedia now has a native dark option; the script forces it without cookies or an account. |
| 10 | 70 | google/hide-ai-mode | 20,000 (Disable AI Mode & AI Overview) | yes |  | Both extensions also hide AI Overviews; the user count is shared demand. |
| 11 | 70 | amazon/dark-mode | 20,000 (Amazon Dark Mode) | yes |  |  |
| 12 | 69 | amazon/sort-by-review-count | 9,000 (Amazon Sort by Review Count) | yes | 2 |  |
| 13 | 69 | medium/read-member-stories | 8,000 (Free Medium Reader) | yes | 2 | Paywall workaround via a third-party mirror (e.g. Freedium); flag for Kenneth's call. Pick a member-only story for the check. |
| 14 | 67 | google/images-direct-links | 12,785 (Google Images direct link) | yes |  |  |
| 15 | 67 | amazon/show-seller | 6,479 (SoldBy - Reveal Sellers on Amazon) | yes | 2 | SoldBy fetches each product's offer page; same-origin fetches, no third party. |
| 16 | 66 | google/old-layout | 12,363 (Gplex - Old Google Frontend) | yes |  |  |
| 17 | 65 | google/hide-sponsored | 10,000 (UnSponsored) | yes |  | Use a commercial query so ads appear. |
| 18 | 64 | google/keyboard-shortcuts | 9,000 (Google Search Keyboard Shortcuts) | yes |  |  |
| 19 | 64 | amazon/hide-sponsored | 8,000 (Amazon Ad & Sponsored Listing Blocker) | yes |  | No Reddit/forum threads reachable (Reddit blocks crawlers). |
| 20 | 64 | wikipedia/old-layout | 4,000 (Old Wiki) | yes | 2 | Script adds ?useskin=vector (Vector legacy 2010). |
| 21 | 62 | bing/stop-scroll-to-top | 13,478 (FIX for "Bing Search returns to the top" !) |  |  | Read the GF script to confirm the exact behaviour (likely the scroll-up-opens-Copilot/chat jump) before writing the page. |
| 22 | 61 | google/show-image-size | 11,459 (Google Image Search - Show Image Dimensions) |  |  |  |
| 23 | 61 | quora/read-without-login | 5,449 (Quora Unblocker) | yes | 1 | Only one thread found. Test URL is a guess at a long-lived question; pick any question page. |
| 24 | 61 | nytimes/read-full-article | 5,557 (The New York Times Paywall Bypass) | yes |  | Paywall circumvention; flag for Kenneth's call. Whether the article text is in the logged-out HTML must be checked. |
| 25 | 60 | google/open-results-new-tab | 4,978 (Google-open-in-new-tab) | yes |  | Google's own setting needs an account; a script works logged out. |
| 26 | 60 | fandom/remove-clutter | 5,004 (Fandom.com --- Cleaner Wikis Userscript) |  | 2 |  |
| 27 | 58 | bing/clean-homepage | 7,385 (Bing homepage optimisation) |  |  |  |
| 28 | 57 | google/hide-people-also-ask | 3,000 (Hide "People Also Asked" Results) | yes | 1 | Only one thread found, so no thread bonus. |
| 29 | 57 | aliexpress/clean-urls | 2,941 (Aliexpress URL Cleaner) | yes |  |  |
| 30 | 56 | bing/image-download-button | 5,553 (Bing Image Download Button) |  |  |  |
| 31 | 56 | amazon/show-country-of-origin | 2,398 (Country of origin for Amazon products) | yes |  |  |
| 32 | 55 | google/web-results-only | 1,000 (Google UDM 14 Web search mode (no AI)) | yes | 2 | Script redirects /search to add udm=14; overlaps remove-ai-overview. |
| 33 | 55 | amazon/price-history | 2,233 (Amazon Camel Graph Revived/Fixed) | yes |  | Embeds a camelcamelcamel chart image; relies on that third party. |
| 34 | 52 | amazon/short-url | 1,323 (Amazon short URL) | yes |  |  |
| 35 | 52 | aliexpress/stay-on-global-site | 3,114 (Aliexpress remove localized links) |  |  |  |
| 36 | 51 | ebay/block-sellers | 511 (EBay: Custom Page Controls And Seller Block List) | yes | 2 | eBay's own exclude filter caps at 10 sellers per search. |
| 37 | 51 | ebay/total-with-shipping | 1,127 (eBay - Display Totals with Shipping) | yes |  |  |
| 38 | 51 | aliexpress/total-price | 1,099 (AliExpress Total Price) | yes |  |  |
| 39 | 51 | nytimes/hide-popups | 1,210 (NyTimes Never bother me plz!) | yes |  |  |
| 40 | 50 | duckduckgo/disable-safe-search | 1,029 (DuckDuckGo unsafe search) | yes |  | Script sets the kp=-2 URL parameter. |

## Notes for page builders

- Paywall tasks (`medium/read-member-stories`, `nytimes/read-full-article`) score well. Whether to publish them is Kenneth's call.
- `google/remove-ai-overview`, `google/hide-ai-mode`, `amazon/hide-rufus` and `wikipedia/hide-donation-banner` may not show up for a logged-out headless browser. Check with Browserbase before marking them blocked.
- `imdb/show-other-ratings` and `imdb/show-letterboxd-rating` need cross-site requests (GM_xmlhttpRequest).
- Dropped for lack of evidence: Walmart (no script above 58 installs, no task-specific autocomplete) and The Verge (only a 7-install font script; "the verge dark mode" autocomplete alone). Wordle cheat scripts on nytimes.com were left out as not a page tweak.
