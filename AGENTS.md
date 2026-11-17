# Project instructions

## Canonical branding: BBS Underground

Kenneth chose **03 BBS Underground** as the canonical usermods style on 2026-09-19. Use it for all branding and future visual work. Read [docs/branding.md](docs/branding.md) for the palette, visual rules, installed assets and remaining UI work. The visual source of truth is `docs/banner.png`; the primary icon is `assets/icon.svg`, rendered into `public/icon/`.

This supersedes the older Volt OS branding direction. Preserve UI readability, accessible interactions and functional behavior while applying the BBS style. Keep this preference in this project only; do not copy it into global memory or instructions.

## SEO and AEO are a core tenet

The website at usermods.kennethballenegger.com (source in `site/`, operator notes in [docs/site.md](docs/site.md)) is how people and answer engines find usermods. Every new feature, page and release keeps search and answer engines in mind. The playbook is in Mind at `system/learnings/2026-11-17-aeo-seo-playbook-from-the-travel-signal.md`; read it before changing the site.

- A new feature ships with its guide page in `site/content/guide/` in the same PR, and an existing page is updated when a feature changes. Guide pages state only what the shipped build does.
- The script library stays tested and dated. Every page has a passing check on its current script. A script that fails its check gets fixed or goes noindex, which the build does on its own. No page goes up without a passing check.

Checklist for any site change:

1. Guide page written or updated for the feature, opening with a one or two sentence answer.
2. `node site/bin/check.ts` run for every task page touched, and the result recorded in `site/data/checks.json`.
3. Dates come from data: task pages from their newest passing check, guide pages from `node site/bin/build.ts --stamp-guide-dates` run before committing. Never type a date by hand.
4. Markdown twins, `llms.txt`, sitemaps and `scripts.json` come from the build. Do not edit them by hand.
5. IndexNow runs on deploy (the server submits changed URLs on startup in prod).
6. `robots.txt` allows every search and AI crawler, and they get 200, not a challenge.
7. Measure with `node site/bin/traffic.ts` and the weekly `node site/bin/ai-panel.ts` run.
8. No Reddit, X or other outreach posting.

## Every change goes through a pull request

Every change to this repo lands through a PR against `main`. That covers code, docs, store metadata and scripts. Never push to `main` directly.

Agent work reached `origin/main` without a PR twice, on 2026-11-02 and 2026-11-09. A branch created from `origin/main` tracks `main`, and `~/.gitconfig` sets `push.default=tracking`, so a plain `git push` or `git push -u origin <branch>` from that branch updates `main`.

1. Create the branch without tracking `main`: `git switch --no-track -c <branch> origin/main` (or `git checkout --no-track -b <branch> origin/main`).
2. Before pushing, run `git rev-parse --abbrev-ref @{upstream}`. It must not print `origin/main`. On a new branch it should fail with "no upstream configured".
3. Push with an explicit refspec: `git push -u origin HEAD:refs/heads/<branch>`.
4. Open the PR with `gh pr create`.

Workflow and subagent briefs for this repo must repeat these steps.
