# Store package audit — v0.1.2

What is inside the zip that goes to the Chrome Web Store, checked before the 0.1.2 submission. Rebuild
and re-audit with `npm run zip:store` whenever the package changes.

**Audited:** 2026-11-02 · **Build:** `npm run zip:store` (`USERMODS_STORE=1 wxt zip`), built into
`.output/store-chrome-mv3` · **Source:** the commit that introduces this audit; the zip depends only
on the source tree, and rebuilding at that commit reproduces the checksum below.

| | |
|---|---|
| Artifact | `.output/usermods-0.1.2-chrome.zip` |
| Size | **518,976 bytes** (506.8 KiB) |
| SHA-256 | `a3dcb8f9575120e8d02a5535103193da2a00e4028a485afe7358c18a5edbfb11` |
| Unpacked | 1,447,711 bytes across **36 files** |

Built twice for this audit with the same SHA-256 both times: the build is deterministic for an
unchanged tree.

The 0.1.0 package (410,791 bytes, 35 files, `8b7c23dd…`, commit `12fc38a`) is the one that was
submitted on 2026-09-22. It is superseded: besides the listing problem it was rejected for, it had a
first-run bug that would have failed review (see [submission.md](submission.md#what-the-resubmission-changes)).

---

## manifest.json

Read from the unzipped package, not from `lib/manifest.ts`.

| Key | Value | OK |
|---|---|---|
| `manifest_version` | `3` | ✅ |
| `name` | `usermods` | ✅ |
| `version` | `0.1.1`, matches `package.json` | ✅ |
| `description` | `Vibe-code userscripts in place. Customize any website by chatting with any LLM.` (79 chars, under the 132-char limit) | ✅ |
| `icons` | 16, 32, 48, 96, 128, all five present in `icon/` | ✅ |
| `permissions` | `sidePanel`, `storage`, `scripting`, `userScripts`, `declarativeNetRequest`: exactly these five. **`tabs` is gone since 0.1.0** ([why](permissions.md#tabs-no-longer-requested)) | ✅ |
| `host_permissions` | `["<all_urls>"]` | ✅ |
| `minimum_chrome_version` | `135` | ✅ |
| `side_panel` | `{ "default_path": "sidepanel.html" }` | ✅ |
| `options_ui` | `{ "page": "dashboard.html", "open_in_tab": true }` | ✅ |
| `action` | `default_title: "Open usermods"`, `default_icon` at 16/32/48/128 | ✅ |
| `background` | `{ "service_worker": "background.js" }` | ✅ |
| `content_scripts` | one, `<all_urls>` at `document_idle` | ✅ |
| `web_accessible_resources` | `install.html` only (needed by the `.user.js` redirect rule) | ✅ |

No `activeTab` and no `tabs`: `<all_urls>` covers what either would add for anything usermods does.
No `declarative_net_request` ruleset key: the two rules are registered at runtime with
`updateDynamicRules`.

## What is not in the package

| Checked for | Found | How |
|---|---|---|
| Source maps | **0** | no `*.map` files; no `sourceMappingURL` in any file |
| `.DS_Store` | **0** | `find -name .DS_Store` |
| Test files, scripts, TypeScript sources, `package.json`, `tsconfig.json`, Markdown | **0** | `find` over `*.ts *.tsx *.test.* *.mjs package.json tsconfig.json *.md` |
| Safari-only files | **0** | no file named `*popup*` or `*modrunner*`; no `popup-size` or "Safari toolbar popup" string; `icon/` has the five Chrome sizes, not the 256/512 Safari adds |
| Remotely loaded scripts | **0** | every `<script src>` in the four HTML files is a package path (`/chunks/…`, `/theme-boot.js`); no `importScripts` |
| Code strings injected with `chrome.scripting` | **0** | `scripting.executeScript` is called with the packaged content script, the packaged gist-editor function and the packaged document-identity function only; model-written and user scripts run through `chrome.userScripts` alone |
| `eval(` / `new Function(` calls | **0** | the only two matches in the package are inside the regular expressions in `background.js` that *refuse* a proposed script using them (`lib/agent/propose.ts`) |

**Subscription sign-in is in this package, on purpose, from 0.1.2.** `auth.openai.com`, `auth.x.ai`,
`chatgpt.com/backend-api` and `cli-chat-proxy.grok.com` each appear in one file. On 2026-11-02 the
packaged build offered both presets, and "Sign in with ChatGPT" got a code and opened
`auth.openai.com`. Approving a code and using a subscription from this build was not tested. The
manifest's permissions are the same as 0.1.1's. Sections below that were written for 0.1.1 and not
re-measured say so by their own date.

A plain `grep oauth background.js` also matches strings inside the bundled `@anthropic-ai/sdk`
(`urn:ietf:params:oauth:grant-type:jwt-bearer` and similar). They are vendor SDK constants on a code
path usermods does not call.

## Things that are in the package and look odd

- **`content-scripts/modrunner.js` is named in `background.js` but is not in the package.** Both
  execution engines (`lib/exec/adapter.ts`) are compiled into every build, and that string belongs to
  Safari's. Since 0.1.1 the engine is chosen from the manifest, which asks for `userScripts` on
  Chrome, so the Safari engine cannot be picked here. (In 0.1.0 it could be, and was, on every fresh
  install: that was the first-run bug.)
- **Two debug switches** (`debug:safariMode`, `debug:retryPolicy`) are read from extension storage.
  Nothing in the UI sets them; the smoke flows do.
- **`styleguide.html`** ships, about 6 KB zipped. It is linked from nowhere in the shipped UI, is
  not web accessible, and makes no `chrome.*` or network call.

None of the three does anything a reviewer would need explained, and removing them is not worth a
change to the package under review. They are listed so that nobody rediscovers them as a surprise.

## What is in the package

| Group | Files | Zipped |
|---|---|---|
| `background.js` (service worker, including the bundled Anthropic SDK) | 1 | 166.4 KiB |
| `chunks/` (React runtime, side panel, dashboard, install and update review, a shared menu chunk, style guide, browser polyfill) | 8 | 185.3 KiB |
| `assets/` CSS | 7 | 14.0 KiB |
| `assets/` webfonts: IBM Plex Mono 400/500/600 and Jersey 10, each as `.woff2` and `.woff` | 8 | 102.8 KiB |
| `icon/`: 16, 32, 48, 96, 128 PNG | 5 | 1.4 KiB |
| HTML entry points: `sidepanel`, `dashboard`, `install`, `styleguide` | 4 | 3.6 KiB |
| `content-scripts/content.js`, `theme-boot.js`, `manifest.json` | 3 | 22.2 KiB |

The fonts are self-hosted on purpose: an extension must not pull a stylesheet or a font from a CDN
at runtime.

Growth since 0.1.0 (410,791 → 512,270 bytes, 35 → 36 files) is the features merged in between:
markdown rendering, reviewed updates, sharing, the install banner, thinking levels, and the agent's
reworked tools (`test_mod`, the page reads, what a run reports).

## How the package was tested

- `npm test`: 1,293 unit tests pass.
- `npm run smoke`: every flow passes against the test build.
- `npm run reviewer-walkthrough`: against **this store build**, from a fresh profile. The setup
  banner shows with the toggle off; the toggle is turned on through `chrome://extensions` under the
  running worker; a script installed before that starts running; the toggle survives off and on
  again; a provider is added and a model chosen by the words in the test instructions; the model's
  script really runs on the page; the finished script is tested as the saved mod on a fresh page
  load and the proposal card says so; no temporary registration is left behind; the mod is saved,
  applies after a reload, and is gone after being deleted.

What none of this covers: a real model. The walk-through uses the scripted mock, so the reviewer key
and its endpoint have to be checked by hand before submitting (see
[submission.md](submission.md#resubmitting)).
