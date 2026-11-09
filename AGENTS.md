# Project instructions

## Canonical branding: BBS Underground

Kenneth chose **03 BBS Underground** as the canonical usermods style on 2026-09-19. Use it for all branding and future visual work. Read [docs/branding.md](docs/branding.md) for the palette, visual rules, installed assets and remaining UI work. The visual source of truth is `docs/banner.png`; the primary icon is `assets/icon.svg`, rendered into `public/icon/`.

This supersedes the older Volt OS branding direction. Preserve UI readability, accessible interactions and functional behavior while applying the BBS style. Keep this preference in this project only; do not copy it into global memory or instructions.

## Every change goes through a pull request

Every change to this repo lands through a PR against `main`. That covers code, docs, store metadata and scripts. Never push to `main` directly.

Agent work reached `origin/main` without a PR twice, on 2026-11-02 and 2026-11-09. A branch created from `origin/main` tracks `main`, and `~/.gitconfig` sets `push.default=tracking`, so a plain `git push` or `git push -u origin <branch>` from that branch updates `main`.

1. Create the branch without tracking `main`: `git switch --no-track -c <branch> origin/main` (or `git checkout --no-track -b <branch> origin/main`).
2. Before pushing, run `git rev-parse --abbrev-ref @{upstream}`. It must not print `origin/main`. On a new branch it should fail with "no upstream configured".
3. Push with an explicit refspec: `git push -u origin HEAD:refs/heads/<branch>`.
4. Open the PR with `gh pr create`.

Workflow and subagent briefs for this repo must repeat these steps.
