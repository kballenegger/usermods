# Demand research: video and social (R1)

Collected 2026-11-17. Sites: YouTube, Twitch, Netflix, TikTok, X, Reddit, LinkedIn, Facebook, Instagram, Threads, Bluesky, Pinterest, Discord, Hacker News. 106 tasks in `video-social.json`, ranked by score.

## Method

- **Greasy Fork**: top 150 scripts per domain by total installs from `api.greasyfork.org/en/scripts/by-site/<domain>.json?sort=total_installs` (the greasyfork.org HTML is behind a Cloudflare challenge; the API host is not). Keyword searches on the same API filled gaps. Every cited script's install count was re-read from `api.greasyfork.org/en/scripts/<id>.json`.
- **Chrome Web Store**: store search pages (`chromewebstore.google.com/search/<query>`), parsed from the embedded data. The main extensions were re-read on their detail pages ("N users"). Store counts are rounded by Google (e.g. 300,000). The `note` says where each number was read.
- **Google autocomplete**: `suggestqueries.google.com/complete/search?client=firefox&hl=en&q=<query>`. It counts as a hit only when a suggestion equals the query or starts with it. The suggestions are kept in the evidence note.
- **Threads**: Reddit is blocked for both curl (403) and the search tool, and DuckDuckGo and Bing returned bot walls. Threads come from the Stack Exchange API (webapps), the HN Algolia API and a few forum threads found by web search. Each title was read and only real asks were kept. Show HN posts and news stories were left out. This undercounts threads, so the +5 thread bonus is conservative across the board.
- Only tasks a userscript can do in the page are listed. Server-side or account-setting changes are out.

## Score

`15 * log10(max install or user count in evidence, min 1)` + 5 if autocomplete returns the query + 5 if two or more separate threads ask for it, capped at 100 and rounded. The same formula is used in all three groups.

Caveats for the ranking:
- Some top numbers come from multi-feature extensions where the task is a headline feature: Unhook (home feed, recommendations), Enhancer for YouTube (resize player), Control Panel for Twitter (Following tab, Who to follow, Premium), Control Panel for YouTube (ambient mode), Fluff Busting Purity. The `notes` field says so.
- `youtube/hide-ads` tops the list on raw demand (Adblock for Youtube, 11M users), but YouTube fights ad blocking, so a page for it will break often.
- `discord/bulk-delete-messages` (Undiscord) automates Discord's API with the user's session, which Discord's ToS treats as self-botting.
- Six tasks have autocomplete evidence only (score 5). They are kept because the demand is real but unmeasured.

## Top 40

| # | Score | Site | Task | Best evidence | AC | Threads | Login | Logged-out test URL |
|---|---|---|---|---|---|---|---|---|
| 1 | 100 | youtube | hide-ads | 11,000,000 (CWS: Adblock for Youtube™) | yes | 0 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 2 | 100 | youtube | return-dislikes | 5,000,000 (CWS: Return YouTube Dislike) | yes | 0 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 3 | 95 | youtube | hide-recommendations | 1,000,000 (CWS: Unhook - Remove YouTube Recommended & Shorts) | yes | 1 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 4 | 94 | youtube | hide-shorts | 400,000 (CWS: Youtube-shorts block) | yes | 3 | no | https://www.youtube.com/results?search_query=minecraft |
| 5 | 92 | youtube | default-playback-speed | 300,000 (CWS: Youtube Playback Speed Control) | yes | 2 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 6 | 91 | discord | bulk-delete-messages | 582,551 (GF: Undiscord) | yes | 0 | yes | - |
| 7 | 90 | x | hide-who-to-follow | 200,000 (CWS: Control Panel for Twitter) | yes | 2 | yes | - |
| 8 | 90 | youtube | hide-home-feed | 1,000,000 (CWS: Unhook - Remove YouTube Recommended & Shorts) | no | 0 | no | https://www.youtube.com/ |
| 9 | 90 | youtube | resize-player | 1,000,000 (CWS: Enhancer for YouTube™) | no | 0 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 10 | 85 | facebook | hide-feed | 200,000 (CWS: News Feed Eradicator) | yes | 0 | yes | - |
| 11 | 85 | facebook | hide-suggested-posts | 100,000 (CWS: Fluff Busting Purity) | yes | 2 | yes | - |
| 12 | 85 | x | hide-for-you | 200,000 (CWS: Control Panel for Twitter) | yes | 0 | yes | - |
| 13 | 85 | x | hide-premium-upsells | 200,000 (CWS: Control Panel for Twitter) | yes | 0 | yes | - |
| 14 | 85 | youtube | force-hd-quality | 200,000 (CWS: YouTube Auto HD + FPS) | yes | 0 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 15 | 80 | twitch | auto-claim-channel-points | 100,000 (CWS: Twitch Channel Points Auto Clicker) | yes | 0 | yes | - |
| 16 | 80 | youtube | block-channels | 100,000 (CWS: Channel Blocker) | yes | 0 | no | https://www.youtube.com/results?search_query=minecraft |
| 17 | 80 | youtube | disable-ambient-mode | 100,000 (CWS: Control Panel for YouTube) | yes | 0 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 18 | 80 | youtube | more-videos-per-row | 100,000 (CWS: YouTube Row Fixer) | yes | 1 | no | https://www.youtube.com/@YouTube/videos |
| 19 | 79 | reddit | old-reddit-redirect | 80,000 (CWS: Old Reddit Redirect) | yes | 0 | no | https://www.reddit.com/r/AskReddit/ |
| 20 | 78 | pinterest | remove-login-popup | 75,918 (GF: Browse your interests without registration) | yes | 0 | no | https://www.pinterest.com/ideas/ |
| 21 | 75 | netflix | show-imdb-ratings | 50,000 (CWS: Trim: IMDB Rating on Netflix, Prime & Disney+) | yes | 0 | yes | - |
| 22 | 75 | youtube | disable-autoplay | 20,000 (CWS: Disable Autoplay for YouTube™) | yes | 3 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 23 | 74 | instagram | hide-explore | 40,000 (CWS: Antigram - Explore & Reels Blocker) | yes | 0 | yes | - |
| 24 | 74 | instagram | hide-reels | 40,000 (CWS: Antigram - Explore & Reels Blocker) | yes | 0 | yes | - |
| 25 | 73 | twitch | disable-quality-downscale | 34,400 (GF: Twitch - Disable automatic video downscale) | yes | 0 | no | https://www.twitch.tv/directory |
| 26 | 72 | instagram | video-controls | 30,000 (CWS: Better Videos for Instagram: Playback & Volume) | yes | 0 | no | https://www.instagram.com/nasa/reels/ |
| 27 | 72 | reddit | remove-login-popup | 14,325 (GF: Remove Reddit Login Requirement) | yes | 2 | no | https://www.reddit.com/r/AskReddit/ |
| 28 | 72 | youtube | auto-continue-watching | 30,000 (CWS: NonStop Youtube - Auto Continue Watching) | yes | 1 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 29 | 72 | youtube | hide-end-screens | 30,000 (CWS: Remove YouTube End Cards & End Screen Videos) | yes | 0 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 30 | 70 | discord | toggle-channel-list | 20,000 (CWS: Hide Discord Sidebar) | yes | 0 | yes | - |
| 31 | 70 | reddit | hide-promoted | 20,000 (CWS: Reddit Promoted Ad Blocker) | yes | 0 | no | https://www.reddit.com/r/AskReddit/ |
| 32 | 68 | x | original-images | 16,704 (GF: Twitter image viewing enhancement) | yes | 0 | no | https://x.com/NASA |
| 33 | 67 | facebook | hide-sponsored | 13,520 (GF: FB - Clean my feeds) | yes | 1 | yes | - |
| 34 | 67 | youtube | hide-sign-in-prompt | 13,596 (GF: Youtube - dismiss sign-in) | yes | 0 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 35 | 66 | netflix | auto-next-episode | 11,342 (GF: Netflix Marathon) | yes | 0 | yes | - |
| 36 | 65 | pinterest | open-original-image | 10,273 (GF: Pinterest - Open Original Image) | yes | 0 | no | https://www.pinterest.com/ideas/ |
| 37 | 65 | reddit | delete-comment-history | 10,000 (CWS: Bulk Delete Reddits Posts & Comments Extension) | yes | 0 | yes | - |
| 38 | 65 | youtube | hide-comments | 10,000 (CWS: Turn Off YouTube Comments & Live Chat) | yes | 1 | no | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| 39 | 65 | youtube | hide-live-chat | 10,000 (CWS: Turn Off YouTube Comments & Live Chat) | yes | 1 | no | https://www.youtube.com/@LofiGirl/live |
| 40 | 65 | youtube | redirect-shorts | 20,311 (GF: Youtube shorts redirect) | no | 0 | no | https://www.youtube.com/shorts/tPEE9ZwTmy0 |
