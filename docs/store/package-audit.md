# Store package audit — v0.1.0

What is actually inside the zip that goes to the Chrome Web Store, checked file by file before the
first submission. Rebuild and re-audit with `npm run zip:store` whenever the package changes.

**Audited:** 2026-09-21 · **Commit:** `12fc38a` · **Build:** `npm run zip:store`
(`USERMODS_STORE=1 wxt zip`), output moved to `.output/store-chrome-mv3` (see CONTRIBUTING.md
"Three output folders, on purpose")

| | |
|---|---|
| Artifact | `.output/usermods-0.1.0-chrome.zip` (built from `.output/store-chrome-mv3`) |
| Size | **410,791 bytes** (401.2 KiB) |
| SHA-256 | `8b7c23dd7e5fcd539be151328f13fec6ee33b9c9e6a38f79666ac3db2226c01b` |
| Unpacked | 1,098,114 bytes (1,072.4 KiB) across **35 files**, 63% compression |

Re-derived at `12fc38a`, two days after the prior audit (`2a752fd`) and after PR #13 (Safari
support) merged and touched shared code (`lib/oauth.ts`, `lib/exec/adapter.ts` among others). File
count is unchanged at 35, but every content hash and the zip's own bytes and sha256 changed —
expected, since the shared code the store build also pulls in moved. Rebuilt twice for this audit:
same sha256 both times, byte-identical zip. The bundler's content hashes are still deterministic
for an unchanged tree.

---

## manifest.json

Read from the unzipped package, not from `wxt.config.ts`. Every line the store cares about:

| Key | Value | OK |
|---|---|---|
| `manifest_version` | `3` | ✅ |
| `name` | `usermods` | ✅ |
| `version` | `0.1.0` — matches `package.json` | ✅ |
| `description` | `Vibe-code userscripts in place. Customize any website by chatting with any LLM.` (79 chars, under the 132-char manifest limit) | ✅ |
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
| Safari-only files | **0** | `find` for `*popup*` / `*modrunner*` by name, and `grep -rl` for `modrunner`, `popup-size`, `Safari toolbar popup` across every unzipped file — both empty. `icon/` has exactly the five Chrome sizes (16/32/48/96/128), not the 256/512 Safari adds. See "Safari support and the store package" below. |

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

## Safari support and the store package

PR #13 added Safari support: a `modrunner` content script (`entrypoints/modrunner.content.ts`,
declared with `include: ['safari']`), a toolbar `popup` entrypoint (`entrypoints/popup/`, including
`popup-size.css`, gated the same way via `<meta name="wxt.include" content="['safari']" />`), and
two extra icon renders (256, 512) that Safari's Extensions list needs at a size Chrome never
requests. None of the three should reach the Chrome store zip, and none do:

- **`modrunner.content.ts` / `popup/`** — both are WXT entrypoints scoped with `include: ['safari']`,
  so they are dropped at entrypoint-discovery time for a Chrome build, not filtered out afterward.
  `find . -iname '*popup*' -o -iname '*modrunner*'` over the unzipped package is empty, and a
  content grep for `modrunner`, `popup-size`, and the `popup/index.html` file's own comment text
  ("Safari toolbar popup") matches nothing.
- **256/512 icons** — kept out by the `build:publicAssets` hook in `wxt.config.ts`, which strips
  `SAFARI_ONLY_ICON_SIZES` (`lib/manifest.ts`) from `files` for every target but `browser ===
  'safari'`. `icon/` in the unzipped package has exactly the five Chrome sizes: 16, 32, 48, 96, 128.

One string *does* legitimately appear: `background.js` contains the literal
`content-scripts/modrunner.js` (inside a minified `ContentScriptAdapter` class). That is not the
Safari-only file leaking in — it is `lib/exec/adapter.ts`'s `createExecAdapter()`, which picks
between `UserScriptsAdapter` and `ContentScriptAdapter` at runtime by feature-detecting
`chrome.userScripts` (`lib/exec/engine.ts`'s `pickEngine`), not by build target. Both adapter
classes ship in every build's `background.js`, Chrome included; only the actual
`content-scripts/modrunner.js` *file* the string names is Safari-only, and it is absent, confirmed
above. This is shared fallback code, not an exclusion-gate miss.

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
| `background.js` (service worker, incl. the bundled Anthropic SDK) | 1 | 141.2 KiB |
| `chunks/` (React runtime, side panel, dashboard, install + install preview, Tampermonkey import, style guide, a shared browser-polyfill chunk) | 8 | 127.7 KiB |
| `assets/` CSS | 6 | 12.0 KiB |
| `assets/` webfonts — IBM Plex Mono 400/500/600 and Jersey 10, each as `.woff2` + `.woff` | 8 | 102.8 KiB |
| `icon/` — 16, 32, 48, 96, 128 PNG | 5 | 1.4 KiB |
| HTML entry points — `sidepanel`, `dashboard`, `install`, `styleguide` | 4 | 3.6 KiB |
| `content-scripts/content.js`, `theme-boot.js`, `manifest.json` | 3 | 7.9 KiB |

(Group totals sum to the 406,113-byte zipped total across all 35 files — the 410,791-byte archive
figure above also includes the zip container's own overhead, e.g. the central directory; group byte
figures above are rounded to one decimal KiB.) The fonts are the single largest group after the
code. They are self-hosted on purpose: an extension must not pull a stylesheet or a font from a CDN
at runtime, and both faces carry the brand.

The group structure (file count and names per group, including the shared `browser-*.js` polyfill
chunk noted in the prior audit) is unchanged since `2a752fd`. Every group's zipped weight grew
somewhat — `background.js` 138.4 → 141.2 KiB, `chunks/` 121.7 → 127.7 KiB — which tracks PR #13
(Safari support): the shared code the Safari build depends on (`lib/oauth.ts`'s new `AUTH_HOSTS`
diagnostics, `lib/exec/adapter.ts`'s adapter-selection logic, related plumbing) is not
`__SAFARI_BUILD__`-gated out of `background.js`, so it ships — inert but present — in the Chrome
store build too. All per-file names changed with the rebuild, per the content-hash caveat above.

## Decision: the style guide ships

`styleguide.html` + its chunk and CSS total **5,839 bytes zipped — 1.4% of the package**
(`styleguide.html` 781 B + `chunks/styleguide-BiJsjzEY.js` 4,362 B +
`assets/styleguide-BtR_4bFh.css` 696 B, against the 406,113-byte group-summed zipped total). It
stays in the store build.

The reasoning, so a reviewer of this decision does not have to redo it:

- **It is not reachable by accident.** The dashboard's link to it renders only in a dev build or
  when the URL carries `?styleguide` (`StyleGuideLink` in `entrypoints/dashboard/Dashboard.tsx`).
  Nothing in the shipped UI points at it, and it is not in `web_accessible_resources`, so no web
  page can frame or navigate to it — it is reachable only by typing the
  `chrome-extension://…/styleguide.html` URL.
- **It is inert.** `entrypoints/styleguide/main.tsx` makes zero `chrome.*` calls, zero `fetch`
  calls and touches no storage. It renders swatches and components. It cannot leak anything or do
  anything, so it adds no attack surface and raises no question a reviewer would need answered.
- **It does not bloat anything.** 1.4% is below the noise floor of a single webfont weight.
- **Excluding it would cost more than it saves.** The specimen exists to be checked against the
  real build; a style guide dropped from the build it documents is one that goes stale silently,
  which is the failure mode its own source comment calls out.

If that ever stops being true — if it grows, gains a `chrome.*` call, or becomes linkable from a
shipped surface — exclude it from store builds behind the existing `__STORE_BUILD__` mechanism and
re-run this audit.

## Non-store build

`.output/chrome-mv3` was not rebuilt for this audit — per instruction, it is the folder the owner's
browser loads unpacked, and only a deliberate `npm run build` / `npm run dev` is meant to touch it
(CONTRIBUTING.md "Three output folders, on purpose"). It was already present, built from `12fc38a`
minutes before this audit ran (`manifest.json` mtime and its content both confirm this: `version`
still `0.1.0`, and `background.js` already contains the post-Safari-merge `auth.x.ai` diagnostic
string checked below), so the grep below is read against that existing build, not a fresh one.

The original two-pattern grep from the first audit, `grep -aroF -e auth.openai.com -e auth.x.ai`,
over `.output/chrome-mv3` now prints **4** matches, not the 2 recorded in the prior audit — still
all in `background.js`, still the positive control proving the store gate is a real difference and
not an empty check, but doubled since PR #13. The cause is `lib/oauth.ts`'s new `AUTH_HOSTS` map
(added for Safari, where a blocked host and a dead network both surface as the same opaque `Failed
to fetch`/`Load failed`, so the extension now needs to name the host itself to the user rather than
rely on the browser's error): `AUTH_HOSTS` lists `auth.openai.com` and `auth.x.ai` a second time
each, alongside the pre-existing `OAI_ISSUER`/`XAI_ISSUER` constants — 2 + 2 instead of 1 + 1. This
is user-facing permission-troubleshooting text, not a new sign-in code path; it is still entirely
inside `lib/oauth.ts`, which the store build's `__STORE_BUILD__` define still tree-shakes out (see
"What is not in the package" above — the store zip's own four-pattern grep is still 0).

The broader four-pattern grep used above (in "What is not in the package") now finds **11**
matches when run against this non-store build (`auth.openai.com` 2, `auth.x.ai` 2,
`chatgpt.com/backend-api` 3, `cli-chat-proxy.grok.com` 4), not the 8 recorded previously —
consistent with the same `AUTH_HOSTS`
addition plus the general growth of `lib/oauth.ts` (69 → 262 lines changed between `2a752fd` and
`12fc38a`). This is expected and not a regression: the non-store build is supposed to contain all
of it, and the count moving is a side effect of auditing a later commit against unchanged source in
that file, not evidence the store gate weakened.
