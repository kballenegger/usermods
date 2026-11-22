# Demand: work tools and other daily web apps (R3)

Researched 2026-11-17. 69 tasks over 18 sites: Gmail, Google Calendar, Docs, Drive, Meet, Outlook, Slack, Notion, GitHub, GitLab, Jira, Confluence, Trello, ChatGPT, Claude, Spotify, WhatsApp Web, Google Maps. Full records with every evidence URL are in `work-tools.json`.

## Method

- **Greasy Fork**: per-site lists from `api.greasyfork.org/en/scripts/by-site/<domain>.json?sort=total_installs` (the www site sits behind a Cloudflare challenge; the API subdomain does not). Google subdomains and outlook.live.com are not indexed separately, so Gmail/Calendar/Docs/Maps scripts came from the `google.com` list and keyword searches; Outlook from `live.com`. Single-script counts were re-read from `api.greasyfork.org/en/scripts/<id>.json`.
- **Chrome Web Store**: search pages (`chromewebstore.google.com/search/<q>`) are server-rendered; user counts were parsed from the embedded data, and 56 of the cited extensions were re-checked on their detail pages. Only single-purpose extensions count, except where noted in the record (Notion Boost, notion-enhancer, Blockify, Roomy).
- **Google autocomplete**: `suggestqueries.google.com` (client=firefox, hl=en, gl=us), sending the query minus its last two characters and checking that the full query comes back.
- **Threads**: web search. Reddit is blocked for both curl and the search tool, so threads are OpenAI forum, GitHub community discussions, Microsoft Q&A, Atlassian community and Google product forums.

## Score

`15 * log10(max install/user count among the evidence, min 1)` + 5 if Google autocomplete returns the query + 5 if two or more separate threads ask for it, capped at 100, rounded. No numbers estimated; metric is null where the source has none.

## Findings

- Work-tool demand is mostly in Chrome extensions, not Greasy Fork. Greasy Fork per-site counts for Slack, Jira, Trello, Notion, Figma, Asana and Linear are small (top scripts under 2,500 installs). Figma, Asana and Linear produced no task with evidence, so they are left out.
- Strongest logged-out candidates: Google Docs dark mode (public doc), ChatGPT Ctrl+Enter, export and wide chat (chatgpt.com and `/share/<id>` pages), Notion full width and floating TOC (public notion.site pages), GitHub file icons and absolute dates, Google Maps dark mode, Trello card counts (public board), Spotify upsell hiding.
- WhatsApp Web, Gmail, Outlook, Slack, Jira, Confluence, Calendar, Meet and Claude need a login (WhatsApp via phone QR; claude.ai returned 403 to curl), so they get no page this round.
- Two top GitHub entries are language-specific: mirror downloads (902,976 installs, sends users to third-party mirror hosts) and zh-CN interface translation. Keep or drop is an editorial call.
- Excluded as not client-side: Spotify lyrics (fetches genius.com), GitHub file tree (needs the API), KeepChatGPT (heartbeat requests), GitHub folder download.
- `google-maps/remove-labels` is probably not doable for the default map (labels are baked into canvas tiles); kept only as a demand record.

## Top 40

| # | Score | Page | Login | Top metric | Autocomplete | Threads |
|---|---|---|---|---|---|---|
| 1 | 95 | whatsapp/privacy-blur | yes | 1,000,000 (cws) | yes | 0 |
| 2 | 94 | google-docs/dark-mode | no | 900,000 (cws) | yes | 1 |
| 3 | 89 | github/mirror-downloads | no | 902,976 (greasyfork) | no | 0 |
| 4 | 89 | spotify/block-ads | yes | 400,000 (cws) | yes | 0 |
| 5 | 85 | chatgpt/ctrl-enter-to-send | no | 100,000 (cws) | yes | 3 |
| 6 | 85 | chatgpt/export-chat | no | 200,000 (cws) | yes | 0 |
| 7 | 80 | claude/export-chat | yes | 100,000 (cws) | yes | 0 |
| 8 | 79 | gmail/hide-gemini | yes | 80,000 (cws) | yes | 0 |
| 9 | 78 | github/translate-interface | no | 148,791 (greasyfork) | no | 0 |
| 10 | 78 | notion/full-width | no | 70,000 (cws) | yes | 1 |
| 11 | 77 | gmail/show-full-date | yes | 60,000 (cws) | yes | 0 |
| 12 | 75 | chatgpt/wide-chat | no | 20,000 (cws) | yes | 2 |
| 13 | 72 | gmail/simplify-layout | yes | 30,000 (cws) | yes | 0 |
| 14 | 72 | notion/floating-toc | no | 30,000 (cws) | yes | 0 |
| 15 | 70 | claude/wide-chat | yes | 20,000 (cws) | yes | 0 |
| 16 | 70 | github/file-icons | no | 20,000 (cws) | yes | 0 |
| 17 | 70 | google-maps/dark-mode | no | 10,000 (cws) | yes | 2 |
| 18 | 70 | google-meet/push-to-talk | yes | 20,000 (cws) | yes | 0 |
| 19 | 66 | google-drive/direct-download-links | no | 11,490 (greasyfork) | yes | 0 |
| 20 | 65 | chatgpt/folders | yes | 10,000 (cws) | yes | 0 |
| 21 | 65 | gmail/dark-mode | yes | 10,000 (cws) | yes | 0 |
| 22 | 65 | outlook/remove-ads | yes | 5,000 (cws) | yes | 3 |
| 23 | 60 | claude/enter-key | yes | 5,000 (cws) | yes | 0 |
| 24 | 60 | jira/dark-mode | yes | 5,000 (cws) | yes | 0 |
| 25 | 60 | trello/count-cards | no | 10,000 (cws) | no | 0 |
| 26 | 59 | google-calendar/shade-weekends | yes | 9,000 (cws) | no | 1 |
| 27 | 59 | slack/open-in-browser | yes | 4,000 (cws) | yes | 0 |
| 28 | 58 | github/dark-mode | no | 3,445 (greasyfork) | yes | 0 |
| 29 | 57 | google-calendar/dark-mode | yes | 3,000 (cws) | yes | 0 |
| 30 | 57 | trello/show-card-numbers | no | 3,000 (cws) | yes | 0 |
| 31 | 55 | notion/word-count | no | 2,187 (greasyfork) | yes | 0 |
| 32 | 55 | spotify/copy-track-info | no | 4,728 (greasyfork) | no | 0 |
| 33 | 55 | trello/collapse-lists | no | 2,000 (cws) | yes | 0 |
| 34 | 55 | whatsapp/hide-chat-list | yes | 2,000 (cws) | yes | 0 |
| 35 | 54 | github/old-feed | yes | 1,748 (greasyfork) | yes | 0 |
| 36 | 54 | spotify/hide-upgrade-prompts | no | 3,696 (greasyfork) | no | 0 |
| 37 | 52 | gmail/remove-ads | yes | 1,316 (greasyfork) | yes | 0 |
| 38 | 52 | gmail/unread-count-favicon | yes | 3,000 (cws) | no | 0 |
| 39 | 52 | google-drive/skip-preview-download | no | 2,953 (greasyfork) | no | 0 |
| 40 | 51 | github/filter-search | yes | 2,577 (greasyfork) | no | 0 |
