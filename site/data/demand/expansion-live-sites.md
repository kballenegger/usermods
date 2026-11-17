# Demand research: more tasks on live sites (X1)

Collected 2026-11-17. More tasks for sites that already have pages and work logged out: YouTube, Reddit, Hacker News, GitHub, Stack Overflow and other Stack Exchange sites, Wikipedia, Twitch, Google, Bing, DuckDuckGo, ChatGPT, IMDb, Medium, Pinterest, Spotify and Trello. 84 tasks in `expansion-live-sites.json`, ranked by score. None repeats an existing page, an assigned task or a task already in the R1-R3 demand files.

## Method

- **Greasy Fork**: up to 300 scripts per domain by total installs from `api.greasyfork.org/en/scripts/by-site/<domain>.json?sort=total_installs` (pages 1-3). Install counts are the API's `total_installs`. Downloaders, ad-block bypasses and anything that needs network calls were left out.
- **Chrome Web Store**: for each task, the top five results of `chromewebstore.google.com/search/<query>`; user counts were read on each detail page. Only single-purpose extensions that do the task count; all-in-one suites and extensions that do the opposite (an NSFW blocker for an unblur task) were not cited.
- **Google autocomplete**: `suggestqueries.google.com/complete/search?client=firefox&hl=en&q=<query>`. "Returns the query" means the exact query is in the suggestion list.
- **Threads**: Stack Exchange API search on webapps and superuser (the API rate-limited this host partway through, so tasks on ChatGPT, IMDb, Medium, Pinterest, Spotify and Trello got no Stack Exchange search) and HN Algolia `tags=ask_hn`. Only threads that ask for the task were kept, picked by hand.
- **Score**: `15 * log10(largest install or user count, min 1)`, plus 5 if autocomplete returns the query, plus 5 if two or more separate threads ask for it, capped at 100, rounded. Same formula as R1-R3, so the files merge.
- **Test URLs**: each one was fetched with curl. Exceptions are in each record's notes: Medium and Stack Exchange return a Cloudflare 403 to curl, IMDb returns an AWS WAF challenge, GitHub rate-limited blob URLs, and Reddit is unreachable from this host (the Reddit URLs are ones the harness already loaded in checks.json). Six tasks have no test URL because they need a specific post or ChatGPT share link that was not found.
- Dropped for lack of evidence or because they need network calls: CNN lite redirect, Google Maps to OpenStreetMap, IMDb spoiler hiding, Substack dark mode, Hacker News and Google infinite scroll.

## Build notes

- Some tasks overlap existing or assigned pages and could merge: youtube/disable-autopause with youtube/background-play, reddit/load-more-comments with reddit/expand-threads, medium/redirect-freedium with medium/read-member-stories, pinterest/hide-shopping with pinterest/hide-promoted-pins.
- Checks that need conditions at run time: twitch/hide-extensions and twitch/reload-on-error (live channel, overlay, an error), youtube/hide-paid-promotion (a video with the label), youtube/like-keyboard-shortcut (liking needs sign-in, so only the click on the like button can be checked).

## Top 40

| # | Site | Task | Score | Top evidence | Autocomplete |
|---|---|---|---|---|---|
| 1 | youtube | video-screenshot | 90 | 500,000 users (Screenshot YouTube) | yes |
| 2 | youtube | loop-video | 89 | 400,000 users (Looper for YouTube) | yes |
| 3 | youtube | faster-playback-speed | 87 | 300,000 users (Youtube Playback Speed Control) | yes |
| 4 | youtube | old-layout | 85 | 100,000 users (YouTube Redux) | yes |
| 5 | youtube | rotate-video | 84 | 90,000 users (Rotate that Video Player) | yes |
| 6 | wikipedia | redirect-to-wikiwand | 80 | 200,000 users (Wikiwand - Wikipedia Modernized) | no |
| 7 | youtube | disable-60fps | 80 | 100,000 users (enhanced-h264ify) | yes |
| 8 | youtube | show-video-tags | 79 | 80,000 users (YouTube Tags) | yes |
| 9 | youtube | volume-boost | 79 | 90,000 users (Volume Booster for YouTube™) | yes |
| 10 | youtube | disable-autopause | 74 | 40,000 users (YouTube Auto Pause Blocker) | yes |
| 11 | youtube | reverse-playlist | 72 | 30,000 users (Youtube Playlist Reverser) | yes |
| 12 | youtube | always-theater-mode | 70 | 20,000 users (Theater Mode for YouTube™) | yes |
| 13 | google | other-engines-buttons | 68 | 15,700 installs (soTab - Search Engine Switcher) | yes |
| 14 | youtube | background-play | 68 | 14,893 installs (Video Background Play Fix) | yes |
| 15 | youtube | clean-description-links | 68 | 36,460 installs (Direct links out) | no |
| 16 | youtube | like-keyboard-shortcut | 66 | 5,741 installs (Youtube like/dislike video and skip ad keyboard shortcuts) | yes |
| 17 | reddit | image-viewer | 65 | 10,000 users (Reddit Image Opener) | yes |
| 18 | youtube | disable-channel-autoplay | 65 | 10,544 installs (Kill YouTube Channel Video Autoplay) | yes |
| 19 | youtube | scroll-volume | 65 | 10,000 users (Youtube Volume Scroll) | yes |
| 20 | youtube | show-full-titles | 65 | 10,000 users (YouTube Full Title For Videos) | yes |
| 21 | youtube | view-thumbnail | 64 | 9,000 users (Youtube™ Thumbnail Preview) | yes |
| 22 | github | readme-toc | 63 | 7,038 installs (Toc Bar, auto-generating table of content) | yes |
| 23 | google | disable-safe-search | 63 | 3,523 installs (Google Disable SafeSearch automatically) | yes |
| 24 | medium | redirect-freedium | 62 | 6,000 users (Freedium Link Converter) | yes |
| 25 | pinterest | declutter | 62 | 13,073 installs (Pinterest Plus) | no |
| 26 | reddit | remove-nsfw-blur | 61 | 11,133 installs (Reddit NSFW Unblur) | no |
| 27 | youtube | start-from-beginning | 61 | 5,698 installs (YouTube No Resume) | yes |
| 28 | youtube | expand-description | 60 | 10,115 installs (YouTube - Proper Description) | no |
| 29 | chatgpt | rtl-support | 59 | 4,000 users (ChatGPT RTL) | yes |
| 30 | duckduckgo | block-domains | 59 | 4,109 installs (DuckDuckGo Enhancements) | yes |
| 31 | imdb | external-links | 59 | 3,844 installs (IMDb: Link 'em all!) | yes |
| 32 | twitch | hide-extensions | 59 | 4,000 users (Disable Twitch extensions) | yes |
| 33 | youtube | hide-paid-promotion | 59 | 4,000 users (YouTube paid promotion hider) | yes |
| 34 | reddit | hide-mature-popup | 58 | 6,989 installs (Remove Reddit Over 18 Login Requirement Popup) | no |
| 35 | chatgpt | latex-copy | 57 | 3,000 users (ChatGPT LaTeX Copy Tool) | yes |
| 36 | spotify | open-in-app | 57 | 3,000 users (Open Spotify Desktop App) | yes |
| 37 | twitch | reload-on-error | 57 | 3,000 users (Twitch player auto-reload) | yes |
| 38 | reddit | multi-column | 55 | 2,189 installs (Reddit Multi Column) | yes |
| 39 | youtube | open-links-new-tab | 55 | 2,218 installs (Open Youtube video links in new tab) | yes |
| 40 | google | show-favicons | 54 | 1,815 installs (Google Favicons) | yes |
