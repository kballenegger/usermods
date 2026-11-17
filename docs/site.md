# The usermods website

usermods.kennethballenegger.com is a library of tested userscripts, one page per task ("Hide YouTube Shorts"), plus a guide with one page per usermods feature. It exists so people and answer engines find usermods. Why it is built the way it is: [AGENTS.md](../AGENTS.md#seo-and-aeo-are-a-core-tenet).

Everything is in `site/`. It runs on Node 24 with no npm dependencies: TypeScript is run directly (`node site/bin/x.ts`). Playwright, already a dev dependency of the extension, is used only by the check harness.

## Layout

| Path | What it is |
|---|---|
| `site/content/<site>/site.json` | One per site: name, domains, category, intro |
| `site/content/<site>/<task>/page.json`, `script.user.js` | One library page and its userscript |
| `site/content/guide/<feature>.md`, `index.json` | Guide pages and their order and descriptions |
| `site/content/README.md` | How to write a library page: format, script rules, checks, the answer paragraph |
| `site/data/checks.json` | Every check result, per page and script hash. Decides what is published and its date |
| `site/data/check-logs/` | Logs and screenshots from check runs |
| `site/data/guide-dates.json` | Guide page dates, stamped from git |
| `site/data/panel-prompts.json` | The fixed prompts for the answer-engine panel |
| `site/src/build/`, `site/src/templates/`, `site/src/markdown.ts` | The static generator |
| `site/src/server.ts` | The server: static files, markdown twins, install redirect, request log, IndexNow |
| `site/bin/` | CLIs: `build.ts`, `check.ts`, `traffic.ts`, `ai-panel.ts` |
| `site/assets/` | CSS, icons, guide screenshots (`assets/guide/`) |
| `site/Dockerfile` | The production image |
| `site/test/` | Tests: `npm run test:site` |

## Add a library page

Follow `site/content/README.md`. In short: write `page.json` and `script.user.js`, run its check, and build. A page is published only when its current script has a passing check; the build leaves the rest out.

## Add or change a guide page

1. Write `site/content/guide/<feature>.md`. The first `# ` line is the title. Open with one or two sentences that answer the question on their own. Images go in `site/assets/guide/` and are linked as `/assets/guide/<file>`.
2. Add `{ "slug", "description" }` to `site/content/guide/index.json` in the order it should appear.
3. Before committing, run `node site/bin/build.ts --stamp-guide-dates`. It writes each page's last commit date to `site/data/guide-dates.json`, or the current time for a new or changed file. The build fails on a guide page without a date.

## Run checks

```sh
node site/bin/check.ts youtube/hide-shorts      # one page
node site/bin/check.ts --site youtube           # one site
node site/bin/check.ts --all                    # everything
```

Each run loads the page logged out in headless Chromium, once without the script and once with it, and records `pass`, `fail` or `blocked` in `site/data/checks.json` with logs and screenshots under `site/data/check-logs/<run>/`. It exits 0 only if every page passed.

Sites that wall headless Chrome (Google answers with its `/sorry/` page) need a real remote browser. `--browserbase` creates a Browserbase session with proxies and needs `BROWSERBASE_API_KEY` in the environment; the `browserbase` skill says where to get it. `--cdp <wsEndpoint>` attaches to any other remote browser. Browserbase's captcha solving is not always fast enough: a run that never gets past the wall is recorded as `blocked`, which leaves the last pass standing. Run it once more, then report it.

## Build

```sh
node site/bin/build.ts                 # writes site/dist
node site/bin/build.ts --out /tmp/x    # somewhere else
```

The build validates every page and names the file and field that is wrong. It writes HTML, markdown twins, `llms.txt`, `robots.txt`, sitemaps, `scripts.json` and `site/dist/manifest.json`. None of these are edited by hand.

## Serve locally

```sh
node site/bin/build.ts && node site/src/server.ts
```

The server listens on `PORT` (default 8080), serves `SITE_DIST` (default `site/dist`) and logs requests to `DATA_DIR/site.db` (default `site/.data`). `/healthz.json` reports the commit, build time and page counts. Analytics, search-console verification tags and IndexNow are only active when their environment variables are set and, for IndexNow, `SITE_ENV=prod`.

## Deploy

The site runs as the `usermods-site` app in the klaw-vps Docker Compose stack, behind Caddy and Cloudflare. The app is defined in `deploy.yaml` in the `kballenegger/klaw-vps` repo; read that repo's README and AGENTS.md first. Deploys go by commit SHA from the klaw-vps checkout on the droplet, as the deploy user:

```sh
bin/deploy app usermods-site prod <full-sha> --dry-run
bin/deploy app usermods-site prod <full-sha>
```

The image runs the build at image build time, so the site deployed is the content at that commit. The deploy smoke checks `/healthz.json` and that the analytics tag is on the live page. On startup in prod the server submits every indexable URL that changed since the last submission to IndexNow.

After a deploy, check `/healthz.json` shows the new commit, and that a crawler user agent (for example `GPTBot`) gets 200 on `/robots.txt` and a page.

## Read traffic and the answer-engine panel

```sh
node site/bin/traffic.ts --days 7          # in the container in prod, where DATA_DIR=/data
node site/bin/ai-panel.ts --engine grok    # or --engine openai
```

`traffic.ts` reports pages served by agent class and bot, the top pages fetched by ChatGPT-User, ChatGPT and other AI referrals, install clicks by page (browsers only) and top landing pages for people. `ai-panel.ts` asks an answer engine with live web search the prompts in `site/data/panel-prompts.json` and records, per prompt, whether the site was cited, at what rank, and which domains were. It needs `XAI_API_KEY` or `OPENAI_API_KEY`. Run it weekly and compare with earlier runs.

## Re-check schedule

Library pages show the date of their last passing check, so the checks have to be re-run. Re-run `node site/bin/check.ts --all` at least weekly (Google pages with `--browserbase`), commit `site/data/checks.json`, and deploy. A page whose current script fails is taken out of the index by the build until its script is fixed and passes again.
