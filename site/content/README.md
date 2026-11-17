# Writing library pages

Each page in the library answers one question about one site ("How do I hide YouTube Shorts on desktop?") with a userscript that was run against the live site. This file is everything you need to add one. You do not need to read the generator.

The three pilot pages are working examples. Copy one and change it:

- `youtube/hide-shorts`: CSS only, checked locally.
- `reddit/remove-sidebar`: CSS only, fixes a layout as well as hiding something.
- `google/remove-ai-overview`: CSS plus a MutationObserver, finds its target by text, checked through Browserbase.

## Files

```
site/content/<site>/site.json                    one per site
site/content/<site>/<task>/page.json             one per page
site/content/<site>/<task>/script.user.js        the userscript, served byte for byte
```

Slugs are kebab-case (`[a-z0-9-]+`) and equal the directory name. `guide`, `install` and `assets` are reserved site slugs. All JSON is strict JSON (no comments, no trailing commas).

### site.json

```json
{
  "slug": "youtube",
  "name": "YouTube",
  "domains": ["youtube.com", "www.youtube.com"],
  "category": "video",
  "intro": "One or two plain sentences for the hub page."
}
```

`category` is one of `video`, `social`, `search`, `shopping`, `news`, `work`, `reference`, `other`. If the site directory already exists, leave `site.json` alone unless it is wrong.

### page.json

| Field | Required | What goes in it |
|---|---|---|
| `slug` | yes | The task slug, equal to the directory name. |
| `title` | yes | The task, imperative, no date: "Hide YouTube Shorts". Also the script's `@name`. |
| `question` | yes | The question people type into a search box or ChatGPT, in their words. |
| `answer` | yes | One paragraph, 40-90 words. See "The answer paragraph" below. |
| `prompt` | yes | The sentence someone would type into usermods' chat to get this mod. |
| `details` | no | Short markdown: what the script changes, what it leaves alone, its limits. |
| `alternatives` | no | `[{ "kind", "title", "body" }]`, `kind` one of `site-setting`, `ublock`, `extension`, `other`. `body` is markdown; put uBlock filters in a fenced block. |
| `related` | no | `["<site>/<task>", ...]`. Links to pages that are not published yet are dropped with a build warning, so you can link to pages other builders are writing. |
| `demand` | no | `{ "score": 0-100, "evidence": [{ "type", "url", "note" }] }` from the demand research files in `site/data/demand/`. Copy, don't invent. |
| `check` | yes | How the harness proves the script works. See below. |

The generator validates every page on build and names the file and field that is wrong.

## The script

A complete userscript. Header:

```js
// ==UserScript==
// @name         Hide YouTube Shorts
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  One sentence: what it hides or changes.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/hide-shorts.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/hide-shorts.user.js
// ==/UserScript==
```

Rules:

- `@name` equals the page `title`. `@namespace`, `@downloadURL` and `@updateURL` exactly as above with your site and task.
- `@grant` is `GM_addStyle` or `none`. The harness rejects anything else.
- Bump `@version` on every change to the script. Any change to the file, even whitespace, changes its SHA-256, and the page needs a new passing check before it is published again.
- `@match` uses Chrome match patterns (`https://*.example.com/*`). No `@include`, no `@require`, no `@resource`, no network calls, no remote code.
- Prefer injected CSS for hiding things: `GM_addStyle` at `document-start` means nothing flashes on screen, and it keeps working across the site's in-page navigation for free. `:has()` works in Chrome and often saves you from JavaScript.
- Use a MutationObserver only when CSS can't select the target (text matching, as in the Google example). Recompute from the current DOM on each change rather than assuming the first match is final; pages are half-built when `document-start` scripts run.
- Pick selectors that will last: element names (`ytd-reel-shelf-renderer`), ids, `aria-label`, `href` patterns and visible text beat generated class names (`.M8OgIe`), which change weekly on Google and Facebook.
- Comment the non-obvious parts. People read these scripts before they install them.

## The check

`check` tells the harness how to prove three things on the live site, logged out:

```json
"check": {
  "urls": ["https://www.youtube.com/results?search_query=minecraft"],
  "loggedOut": true,
  "waitFor": "ytd-video-renderer",
  "settleMs": 4000,
  "baseline": "[...document.querySelectorAll('a[href^=\"/shorts/\"]')].some((a) => a.checkVisibility())",
  "expect": "(() => { const l = [...document.querySelectorAll('a[href^=\"/shorts/\"]')]; return l.length > 0 && l.every((a) => !a.checkVisibility()); })()",
  "intact": "[...document.querySelectorAll('ytd-video-renderer')].filter((v) => v.checkVisibility()).length >= 5"
}
```

For each URL the harness loads the page twice in a fresh logged-out Chromium (desktop Chrome user agent, 1366x900, `en-US`):

1. **Without the script.** After `waitFor` and `settleMs`, it runs `actions` (if any) and evaluates `baseline`. It must be true. This proves the thing the script removes is really on the page.
2. **With the script**, injected at its `@run-at` time with a `GM_addStyle` that behaves like usermods' own. After the same waits and `actions`, `expect` must be true (the script did its job) and `intact` must be true (the page still works).

Field notes:

- `urls`: pages where the target shows up for a logged-out visitor. Search result URLs are good because they are stable and full of content. Add `hl=en` or similar when the page's language matters (the Google script matches English text). Every URL must pass for the page to pass, so use one unless a second page type matters.
- `loggedOut` must be `true`. The harness has no accounts. A task that only exists behind a login gets no page for now.
- `waitFor`: a CSS selector that exists (attached, not necessarily visible) once the content has loaded. The harness waits up to 30 s for it, across redirects and captcha solves.
- `settleMs`: extra wait after `waitFor` for late content. 3000-4000 is typical.
- `baseline`, `expect`, `intact`: JS **expressions** evaluated in the page, coerced to boolean. Promises are awaited. Wrap statements in an IIFE: `(() => { ...; return x; })()`.
- `actions`: optional JS **statements** run in both loads before the assertions, for tasks that need an interaction (a key press for a shortcut task).

Writing good assertions:

- Use `element.checkVisibility()` for "is it on screen"; it is false for anything inside a `display: none` ancestor.
- `expect` must prove the target still exists and is hidden, not just that a selector finds nothing. `l.length > 0 && l.every((e) => !e.checkVisibility())` fails if the site renamed its markup, which is what you want. `!document.querySelector('.x')` passes on a page that never had `.x`.
- `intact` checks the main content is still there and visible: at least N results, posts or videos. This is what caught the first Google script hiding every result.
- Never weaken `baseline` to get a pass. If the target won't appear logged out, the result is `blocked`; report it and pick another task.

## Running it

```sh
node site/bin/check.ts youtube/hide-shorts           # one page
node site/bin/check.ts --site youtube                # every page of a site
node site/bin/check.ts --all
node site/bin/check.ts google/remove-ai-overview --browserbase
```

Each load has a 60 s deadline, so a run takes at most about two minutes per URL. It prints one line per page (`pass`, `fail` or `blocked` with the reason), appends one entry per page to `site/data/checks.json`, and writes details plus a screenshot of each load to `site/data/check-logs/<run>/`. Look at the `-script.png` screenshot before you call a pass done: the assertions only see what you asked about.

Results:

- `pass`: baseline, expect and intact all true on every URL.
- `fail`: the script threw, `expect` or `intact` was false. A fail on the current script takes a published page out of the index until it passes again.
- `blocked`: the page never showed the target without the script, a load timed out, or a captcha, bot wall or login wall that the load without the script didn't show stopped it. A wall present on both loads (Reddit's reCAPTCHA iframe is on every page) doesn't excuse failed assertions: that is a `fail`. Not a pass. Doesn't unpublish a page that passed before.

`checks.json` keeps the 10 newest entries per page. Only entries whose `scriptSha` matches the current file count. Don't edit it by hand.

## Walled sites: Browserbase

Gimel's headless Chromium is fine for YouTube and Reddit, but Google answers it with an "unusual traffic" captcha. `--browserbase` runs the check in a Browserbase cloud browser with residential proxies; Browserbase solves Google's captcha itself, and the `waitFor` wait covers the time that takes. It needs `BROWSERBASE_API_KEY` in the environment (the key is in Kenneth's Klaw vault; the `browserbase` skill shows how to read it) and optionally `BROWSERBASE_PROJECT_ID`. The session is released when the run ends. `--cdp <wsEndpoint>` attaches to any other CDP browser instead.

Captcha solving is not reliable every time. If a Browserbase run comes back `blocked`, run it once more; if it is blocked again, report it.

## The answer paragraph

Answer engines quote this paragraph whole, so it has to stand on its own:

- 40-90 words. First sentence answers the question directly, including "there is no setting for this" when that's true.
- Say what the usermods script on this page does, concretely: which parts of the page it hides or changes.
- End with the plain alternative that needs no extension, if there is one (a site setting, a URL parameter, old.reddit.com).
- Only claim what the script does and the check covers. If the script also handles a page the check doesn't load, say so in `details` and say the check doesn't cover it.
- No dates, no "updated every", no superlatives, no em dashes. Plain sentences.

`details` explains how the script works and what it leaves alone. `alternatives` give the honest other routes: site settings first, then uBlock filters (say they aren't run by the check), then other extensions.

## Before you hand off a page

- `node site/bin/check.ts <site>/<task>` printed `pass`, and you looked at the screenshot.
- `node site/bin/build.ts` builds without errors naming your files.
- `@version`, `@name`, the URLs in the header and the slugs all agree.
