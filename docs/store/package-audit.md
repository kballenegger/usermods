# Store package audit — v0.1.0

What is actually inside the zip that goes to the Chrome Web Store, checked file by file before the
first submission. Rebuild and re-audit with `npm run zip:store` whenever the package changes.

**Audited:** 2026-09-19 · **Commit:** `2a752fd` · **Build:** `npm run zip:store`
(`USERMODS_STORE=1 wxt zip`), output moved to `.output/store-chrome-mv3` (see CONTRIBUTING.md
"Three output folders, on purpose")

| | |
|---|---|
| Artifact | `.output/usermods-0.1.0-chrome.zip` (built from `.output/store-chrome-mv3`) |
| Size | **400,699 bytes** (391.3 KiB) |
| SHA-256 | `8175a054e00d82acb75d49107c0b74ea8444a65edd0d2ec159022357e5384caf` |
| Unpacked | 1,058,300 bytes (1,033.5 KiB) across **35 files**, 63% compression |

Rebuilt twice for this audit: same sha256 both times, byte-identical zip. The bundler's content
hashes are still deterministic for an unchanged tree — the earlier caveat here (a changed chunk
renames itself, so the checksum identifies this exact build rather than the source revision) still
holds across *source* changes, it just did not fire between these two back-to-back builds.

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
No `declarative_net_request` ruleset key — `declarativeNetRequest` is declared only as a permission
(above); the extension registers rules at runtime via the API, not through a static
`declarative_net_request.rule_resources` manifest entry, so there is nothing further to check here.

## What is not in the package

| Checked for | Found | How |
|---|---|---|
| Source maps | **0** | no `*.map` files; no `sourceMappingURL` comment in any file |
| `.DS_Store` | **0** | `find -name .DS_Store` |
| Test files, scripts, TypeScript sources, `package.json`, `tsconfig.json`, Markdown | **0** | `find` over `*.ts *.tsx *.test.* *.mjs package.json tsconfig.json *.md` |
| Subscription OAuth endpoints | **0** | `grep -aroF -e auth.openai.com -e auth.x.ai -e chatgpt.com/backend-api -e cli-chat-proxy.grok.com` over the unzipped tree prints nothing (the store-build gate) |

The grep now also checks the two subscription base URLs by name (`CHATGPT_CODEX_BASE` /
`chatgpt.com/backend-api/codex` and `XAI_PROXY_BASE` / `cli-chat-proxy.grok.com`, both defined in
`lib/buildflags.ts`), not just their auth hosts, and still finds nothing. The `__STORE_BUILD__`
define does its job: `lib/oauth.ts` is loaded only via `import('@/lib/oauth')` behind `if
(STORE_BUILD)` checks in `entrypoints/background.ts`, so the bundler drops that dynamic import —
and the device-code flow it contains — from the store build entirely. What survives in
`background.js` is the stub side of the RPC surface: `oauth.status` returns `{signedIn:false}`,
`oauth.start`/`oauth.poll` return the "not available in the Chrome Web Store build" message from
`unavailableProviderMessage()`, and `oauth.signout`/`oauth.cancel` return `{ok:true}` — confirmed
directly in the minified `background.js` (`case'oauth.status':return{signedIn:!1}`). This is what
lets a connection profile saved by the GitHub build degrade gracefully instead of throwing: see
"Store build and a GitHub-saved subscription connection" below.

A plain `grep oauth background.js` does still match other strings, all of them inside the bundled
`@anthropic-ai/sdk` (`urn:ietf:params:oauth:grant-type:jwt-bearer`, the `oauth-2025-04-20` beta
header, `user_oauth` config names, `/v1/oauth/token`). Still accurate: these remain vendor SDK
constants on a code path usermods does not call, not usermods' own sign-in.

## Store build and a GitHub-saved subscription connection

The two subscription providers (ChatGPT, SuperGrok/xAI) are unavailable in the store build, but a
profile carried over from the GitHub build is not rewritten or deleted. Per the comment in
`lib/buildflags.ts` and the logic in `lib/connections.ts`: `providerAvailable()` returns `false` for
a subscription kind when `STORE_BUILD` is true, `connectionStatus()` maps that straight to the
`'unavailable'` status (`canAdd()` also blocks adding a new one), `pickerGroups()` leaves an
unavailable connection out of the in-chat model picker, and Settings shows it with the
`unavailableProviderMessage()` explanation instead of a sign-in control. Nothing migrates or
deletes the stored connection, so reopening the same profile in the GitHub build finds it exactly
as it was. (There is no `oauth.status` stub involved in this path — that RPC only backs the
sign-in UI's status poll — and no `migrateSettingsForBuild` function exists in the codebase; this
is pure runtime gating on `STORE_BUILD`, not a settings migration.)

## What is in the package

| Group | Files | Zipped |
|---|---|---|
| `background.js` (service worker, incl. the bundled Anthropic SDK) | 1 | 138.4 KiB |
| `chunks/` (React runtime, side panel, dashboard, install + install preview, Tampermonkey import, style guide, a shared browser-polyfill chunk) | 8 | 121.7 KiB |
| `assets/` CSS | 6 | 11.8 KiB |
| `assets/` webfonts — IBM Plex Mono 400/500/600 and Jersey 10, each as `.woff2` + `.woff` | 8 | 102.8 KiB |
| `icon/` — 16, 32, 48, 96, 128 PNG | 5 | 1.4 KiB |
| HTML entry points — `sidepanel`, `dashboard`, `install`, `styleguide` | 4 | 3.4 KiB |
| `content-scripts/content.js`, `theme-boot.js`, `manifest.json` | 3 | 7.3 KiB |

(Group totals sum to the 396,021-byte zipped total across all 35 files; group byte figures above
are rounded to one decimal KiB.) The fonts are the single largest group after the code. They are
self-hosted on purpose: an extension must not pull a stylesheet or a font from a CDN at runtime,
and both faces carry the brand.

The `chunks/` group grew by one file since the last audit — a small shared `browser-*.js` chunk
(WXT's browser-API polyfill, pulled out as its own chunk by the bundler; not tied to any single
entry point) — and the per-file names have all changed with the rebuild, per the content-hash
caveat above. The feature surface behind these chunks is materially larger than before (retry /
resume, per-chat output folders, the vision/Images setting, editing an installed mod from chat, the
providers list and in-chat model picker all merged since the prior audit), yet the group's zipped
weight moved only from 119.1 KiB to 121.7 KiB — tree-shaking and shared chunking are absorbing most
of the growth.

## Decision: the style guide ships

`styleguide.html` + its chunk and CSS total **5,841 bytes zipped — 1.5% of the package**
(`styleguide.html` 784 B + `chunks/styleguide-2jHS_56v.js` 4,361 B +
`assets/styleguide-BtR_4bFh.css` 696 B, against the 396,021-byte zipped total). It stays in the
store build.

The reasoning, so a reviewer of this decision does not have to redo it:

- **It is not reachable by accident.** The dashboard's link to it renders only in a dev build or
  when the URL carries `?styleguide` (`StyleGuideLink` in `entrypoints/dashboard/Dashboard.tsx`).
  Nothing in the shipped UI points at it, and it is not in `web_accessible_resources`, so no web
  page can frame or navigate to it — it is reachable only by typing the
  `chrome-extension://…/styleguide.html` URL.
- **It is inert.** `entrypoints/styleguide/main.tsx` makes zero `chrome.*` calls, zero `fetch`
  calls and touches no storage. It renders swatches and components. It cannot leak anything or do
  anything, so it adds no attack surface and raises no question a reviewer would need answered.
- **It does not bloat anything.** 1.5% is below the noise floor of a single webfont weight.
- **Excluding it would cost more than it saves.** The specimen exists to be checked against the
  real build; a style guide dropped from the build it documents is one that goes stale silently,
  which is the failure mode its own source comment calls out.

If that ever stops being true — if it grows, gains a `chrome.*` call, or becomes linkable from a
shipped surface — exclude it from store builds behind the existing `__STORE_BUILD__` mechanism and
re-run this audit.

## Non-store build

`npm run build` (no `USERMODS_STORE`, i.e. `npx wxt build`) still succeeds after this audit and
still writes to `.output/chrome-mv3` — the only folder meant to be loaded unpacked in a real
browser (CONTRIBUTING.md "Three output folders, on purpose"); the store build never touches it. The
original two-pattern grep from the first audit, `grep -aroF -e auth.openai.com -e auth.x.ai`, over
`.output/chrome-mv3` still prints **2** matches — both in `background.js`, the two subscription
auth hosts — which is the positive control proving the store gate is a real difference and not an
empty check. (The broader four-pattern grep used above against the store zip finds 8 matches
against this non-store build — `chatgpt.com/backend-api` and `cli-chat-proxy.grok.com` each appear
more than once in `background.js` — which is expected and not a regression: those two extra
patterns were added to this audit to also catch the subscription base URLs by name, not just their
auth hosts, and the non-store build is supposed to contain all of it.)
