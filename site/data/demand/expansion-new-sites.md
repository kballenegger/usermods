# Demand: new sites with a logged-out UI (expansion X2)

Researched 2026-11-17. 87 tasks over 23 sites: Bandcamp, Craigslist, DEV Community, Dailymotion, DeepL, Genius, Goodreads, Google Translate, Hugging Face, Imgur, Internet Archive, Kick, Letterboxd, Python docs, SoundCloud, Steam, The Guardian, Vimeo, Weather.com, Wiktionary, Yahoo, arXiv, npm. Full records with every evidence URL are in `expansion-new-sites.json`. None of these sites has a page or an assigned task yet.

## Method

- **Greasy Fork**: per-site lists from `api.greasyfork.org/en/scripts/by-site/<domain>.json?sort=total_installs`. developer.mozilla.org, news.google.com, finance.yahoo.com and translate.google.com return empty lists (they fall under their parent domain), so MDN and Google News produced no task.
- **Chrome Web Store**: search pages (`chromewebstore.google.com/search/<q>`) for the extension ids, then the user count read from each detail page. Multi-purpose extensions are listed but marked "not counted in the score" (SteamDB, SoundCloud Enhanced Pro, the Hugging Face ZIP downloader, Kick Advanced Player).
- **Google autocomplete**: `suggestqueries.google.com` (client=firefox, hl=en). The +5 applies only when the suggestion list contains the exact query. Queries whose suggestions are about something else (Yahoo "search redirect" = browser hijack, "pypi uv" = the package) are not counted.
- **Threads**: Stack Exchange API search on Web Apps and Super User. Reddit is unreachable. Only Imgur direct links and the Google Translate swap shortcut have two separate threads.
- **Logged-out check**: every `loggedOutTestUrl` was fetched with curl and a desktop Chrome user agent and returned 200 with real page content. Genius and npm answer HTTP/2 curl with a Cloudflare 403 and HTTP/1.1 with 200; Imgur returns a client-rendered shell.

## Score

`15 * log10(max install/user count among the evidence, min 1)` + 5 if autocomplete returns the query + 5 if two or more separate threads ask for it, capped at 100, rounded. No numbers estimated; metric is null where the source has none. Nine tasks rest on autocomplete alone and score 5.

## Findings

- Multi-site scripts inflate a few scores: Direct links out (36,460) drives both steam/direct-links and soundcloud/direct-links; Toc Bar (7,038) drives devto/table-of-contents; Resize Video To Window Size (4,055) drives the Vimeo and Dailymotion player tasks. Each record says so.
- Strongest single-purpose signals: Google Translate dark mode (60,000-user extension), Kick ad blocking (30,000), alphaXiv button on arXiv (30,000), SoundCloud dark mode (20,000), Bandcamp tempo (10,000) and volume (6,000), arxiv-utils PDF naming (6,000).
- Left out because the script would need network calls: SoundCloud track download (53,712 installs), Vimeo download, Letterboxd external ratings (MoreMovieRatings, 72,784), Steam price history, Hugging Face repo size.
- Left out because the page did not load logged out from here: Zillow and Tripadvisor (bot wall 403), Washington Post (connection dropped, no response). Booking.com, Product Hunt and Bitbucket had too little evidence. Rotten Tomatoes had only generic ad-block demand. MDN already has a theme switch.
- Check-time caveats: steam/skip-age-check (curl skipped the gate), guardian/remove-sign-in-gate (gate shows after several articles), genius/old-song-page (old layout may no longer exist), google-translate/dark-mode (may already follow the OS theme), dailymotion/unblur-thumbnails (needs a flagged video).

## Top 40

| # | Score | Page | Top metric | Autocomplete | Threads |
|---|---|---|---|---|---|
| 1 | 77 | google-translate/dark-mode | 60,000 (cws) | yes | 0 |
| 2 | 73 | steam/direct-links | 36,460 (gf) | yes | 0 |
| 3 | 72 | kick/hide-ads | 30,000 (cws) | yes | 0 |
| 4 | 70 | soundcloud/dark-mode | 20,000 (cws) | yes | 0 |
| 5 | 68 | soundcloud/direct-links | 36,460 (gf) | no | 0 |
| 6 | 67 | arxiv/open-in-alphaxiv | 30,000 (cws) | no | 0 |
| 7 | 63 | vimeo/playback-speed | 7,161 (gf) | yes | 1 |
| 8 | 62 | bandcamp/volume-control | 6,000 (cws) | yes | 0 |
| 9 | 60 | bandcamp/playback-speed | 10,000 (cws) | no | 0 |
| 10 | 59 | vimeo/theater-mode | 4,055 (gf) | yes | 0 |
| 11 | 59 | dailymotion/full-window-player | 4,055 (gf) | yes | 0 |
| 12 | 59 | goodreads/library-links | 4,000 (cws) | yes | 0 |
| 13 | 58 | soundcloud/download-cover-art | 3,654 (gf) | yes | 0 |
| 14 | 58 | steam/skip-age-check | 3,571 (gf) | yes | 0 |
| 15 | 58 | devto/table-of-contents | 7,038 (gf) | no | 0 |
| 16 | 57 | arxiv/pdf-title-filename | 6,000 (cws) | no | 0 |
| 17 | 56 | imgur/direct-image-links | 1,126 (gf) | yes | 2 |
| 18 | 56 | archive/pdf-download-link | 2,669 (gf) | yes | 0 |
| 19 | 54 | archive/fix-wayback-images | 1,933 (gf) | yes | 0 |
| 20 | 53 | bandcamp/download-cover-art | 3,654 (gf) | no | 0 |
| 21 | 52 | dailymotion/unblur-thumbnails | 3,016 (gf) | no | 0 |
| 22 | 52 | imgur/slideshow | 1,394 (gf) | yes | 0 |
| 23 | 52 | steam/steamdb-link | 1,397 (gf) | yes | 0 |
| 24 | 50 | kick/force-quality | 1,000 (cws) | yes | 0 |
| 25 | 50 | steam/review-percentage | 1,033 (gf) | yes | 0 |
| 26 | 50 | deepl/dark-mode | 1,000 (cws) | yes | 0 |
| 27 | 48 | soundcloud/disable-autoplay | 771 (gf) | yes | 1 |
| 28 | 48 | dailymotion/disable-autoplay | 774 (gf) | yes | 0 |
| 29 | 48 | dailymotion/force-quality | 682 (gf) | yes | 0 |
| 30 | 47 | goodreads/sort-list-by-rating | 631 (gf) | yes | 0 |
| 31 | 46 | imgur/load-all-images | 1,105 (gf) | no | 0 |
| 32 | 46 | genius/copy-lyrics | 566 (cws) | yes | 0 |
| 33 | 46 | archive/hide-wayback-toolbar | 547 (gf) | yes | 0 |
| 34 | 45 | kick/keyboard-seek | 1,000 (cws) | no | 0 |
| 35 | 44 | bandcamp/dark-mode | 429 (cws) | yes | 0 |
| 36 | 44 | imgur/minimal-layout | 879 (gf) | no | 0 |
| 37 | 43 | arxiv/html-version-link | 362 (cws) | yes | 0 |
| 38 | 42 | dailymotion/skip-ads | 305 (gf) | yes | 0 |
| 39 | 42 | letterboxd/exact-average-rating | 273 (gf) | yes | 0 |
| 40 | 42 | yahoo/direct-search-links | 629 (gf) | no | 0 |
