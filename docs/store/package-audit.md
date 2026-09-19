# Store package audit — v0.1.0

What is actually inside the zip that goes to the Chrome Web Store, checked file by file before the
first submission. Rebuild and re-audit with `npm run zip:store` whenever the package changes.

**Audited:** 2026-09-19 · **Build:** `npm run zip:store` (`USERMODS_STORE=1 wxt zip`)

| | |
|---|---|
| Artifact | `.output/usermods-0.1.0-chrome.zip` |
| Size | **375,303 bytes** (366.5 KiB) |
| SHA-256 | `5ab0332f5bc9c01f502bd2fdc8610c7456f3caa4dbaae50a1bdea74ae19f4360` |
| Unpacked | 974,411 bytes (952 KiB) across **34 files**, 62% compression |

The zip is reproducible only up to the bundler's content hashes: rebuilding from the same tree
yields the same file list, but a changed chunk renames itself, so the checksum above identifies
this exact build rather than the source revision.

---

## manifest.json

Read from the unzipped package, not from `wxt.config.ts`. Every line the store cares about:

| Key | Value | OK |
|---|---|---|
| `manifest_version` | `3` | ✅ |
| `name` | `usermods` | ✅ |
| `version` | `0.1.0` — matches `package.json` | ✅ |
| `description` | `Vibe-code userscripts in place. Customize any website by chatting with any LLM.` (78 chars, under the 132-char manifest limit) | ✅ |
| `icons` | 16, 32, 48, 96, 128 — all five present in `icon/` | ✅ |
| `permissions` | `sidePanel`, `storage`, `scripting`, `tabs`, `userScripts`, `declarativeNetRequest` — exactly these six, no more | ✅ |
| `host_permissions` | `["<all_urls>"]` | ✅ |
| `minimum_chrome_version` | `135` (the `userScripts` API's floor) | ✅ |
| `side_panel` | `{ "default_path": "sidepanel.html" }` | ✅ |
| `options_ui` | `{ "page": "dashboard.html", "open_in_tab": true }` | ✅ |
| `action` | `default_title: "Open usermods"`, `default_icon` at 16/32/48/128 | ✅ |
| `background` | `{ "service_worker": "background.js" }` | ✅ |
| `content_scripts` | one, `<all_urls>` at `document_idle` | ✅ |
| `web_accessible_resources` | `install.html` only (needed by the `.user.js` redirect rule) | ✅ |

No `activeTab` — `<all_urls>` already grants everything it would, and nothing in the code reads it.

## What is not in the package

| Checked for | Found | How |
|---|---|---|
| Source maps | **0** | no `*.map` files; no `sourceMappingURL` comment in any file |
| `.DS_Store` | **0** | `find -name .DS_Store` |
| Test files, scripts, TypeScript sources, `package.json`, `tsconfig.json`, Markdown | **0** | `find` over `*.ts *.tsx *.test.* *.mjs package.json tsconfig.json *.md` |
| Subscription OAuth endpoints | **0** | `grep -aroF -e auth.openai.com -e auth.x.ai` over the unzipped tree prints nothing (the store-build gate) |

The `__STORE_BUILD__` define does its job. `lib/oauth` is gone from the bundle: neither
`CHATGPT_CODEX_BASE` (`chatgpt.com/backend-api/codex`) nor `XAI_PROXY_BASE`
(`cli-chat-proxy.grok.com`) appears anywhere in the package, and no device-code flow with it. What
survives in `background.js` is the stub side of the RPC surface — `oauth.status` returning
`{signedIn:false}` and `oauth.start` returning the "not available in the Chrome Web Store build"
message — which is what makes a profile saved by the GitHub build degrade gracefully instead of
throwing.

A plain `grep oauth background.js` does match other strings, all of them inside the bundled
`@anthropic-ai/sdk` (`urn:ietf:params:oauth:grant-type:jwt-bearer`, the `oauth-2025-04-20` beta
header, `user_oauth` config names). They are vendor SDK constants on a code path usermods does not
call, not usermods' own sign-in.

## What is in the package

| Group | Files | Zipped |
|---|---|---|
| `background.js` (service worker, incl. the bundled Anthropic SDK) | 1 | 125.6 KiB |
| `chunks/` (React runtime, side panel, dashboard, install, Tampermonkey import, style guide) | 8 | 119.1 KiB |
| `assets/` CSS | 5 | ~12 KiB |
| `assets/` webfonts — IBM Plex Mono 400/500/600 and Jersey 10, each as `.woff2` + `.woff` | 8 | 108.0 KiB |
| `icon/` — 16, 32, 48, 96, 128 PNG | 5 | ~1.7 KiB |
| HTML entry points — `sidepanel`, `dashboard`, `install`, `styleguide` | 4 | ~3 KiB |
| `content-scripts/content.js`, `theme-boot.js`, `manifest.json` | 3 | ~6 KiB |

The fonts are the single largest group after the code. They are self-hosted on purpose: an
extension must not pull a stylesheet or a font from a CDN at runtime, and both faces carry the
brand.

## Decision: the style guide ships

`styleguide.html` + its chunk and CSS total **5,843 bytes zipped — 1.6% of the package**. It stays
in the store build.

The reasoning, so a reviewer of this decision does not have to redo it:

- **It is not reachable by accident.** The dashboard's link to it renders only in a dev build or
  when the URL carries `?styleguide` (`StyleGuideLink` in `entrypoints/dashboard/Dashboard.tsx`).
  Nothing in the shipped UI points at it, and it is not in `web_accessible_resources`, so no web
  page can frame or navigate to it — it is reachable only by typing the
  `chrome-extension://…/styleguide.html` URL.
- **It is inert.** `entrypoints/styleguide/main.tsx` makes zero `chrome.*` calls, zero `fetch`
  calls and touches no storage. It renders swatches and components. It cannot leak anything or do
  anything, so it adds no attack surface and raises no question a reviewer would need answered.
- **It does not bloat anything.** 1.6% is below the noise floor of a single webfont weight.
- **Excluding it would cost more than it saves.** The specimen exists to be checked against the
  real build; a style guide dropped from the build it documents is one that goes stale silently,
  which is the failure mode its own source comment calls out.

If that ever stops being true — if it grows, gains a `chrome.*` call, or becomes linkable from a
shipped surface — exclude it from store builds behind the existing `__STORE_BUILD__` mechanism and
re-run this audit.

## Non-store build

`npm run build` (no `USERMODS_STORE`) still succeeds after this audit, and the same grep over
`.output/chrome-mv3` prints **2** matches — the two subscription endpoints — which is the positive
control proving the store gate is a real difference and not an empty check.
