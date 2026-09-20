# Browser support: Firefox and Safari

usermods ships on Chrome (manifest requires **Chrome 135+**, for the "Allow User Scripts" toggle
`chrome.userScripts` needs) and on Safari for iPhone and iPad. This is a from-primary-sources look at
what shipping on Firefox and Safari takes, API by API, plus effort estimates and a verdict for each.

The Safari port is built. Read [docs/safari.md](safari.md) for how it works, how to build and install
it, what its isolation guarantees are and what it cannot do. This page is the research the port came
out of; it is kept as written, with the Safari verdict updated to match what shipped.

Method: `grep -rn 'chrome\.' entrypoints/ lib/` for the exact call sites, then each API's support,
minimum version and behavioral differences checked against MDN's webextensions browser-compat-data
(the same data that feeds the MDN compatibility tables), the Chrome/Firefox API reference docs, the
Firefox Add-on Policies, and Apple's Safari Web Extension and App Review docs.

## APIs usermods calls

Full `chrome.*` surface as of this check (`entrypoints/` + `lib/`):

| API | Call sites |
|---|---|
| `userScripts.{configureWorld,register,update,unregister,getScripts,execute}` | `entrypoints/background.ts`, `lib/gm.ts` |
| `runtime.onUserScriptMessage` / port from the user-script world | `entrypoints/background.ts` (listener), `lib/gm.ts` (`chrome.runtime.sendMessage`/`connect` called *from inside* registered mod code) |
| `sidePanel.setPanelBehavior` | `entrypoints/background.ts` |
| `declarativeNetRequest.updateDynamicRules` (redirect, `regexSubstitution`) | `entrypoints/background.ts` |
| `scripting.executeScript` (with `files`) | `entrypoints/background.ts` (content-script fallback injection) |
| `storage.local` | `entrypoints/background.ts`, `lib/chats.ts`, `lib/consent.ts`, `lib/oauth.ts` |
| `storage.session` | **Not actually called.** README's "Chat history is kept per tab in `chrome.storage.session`" does not match the code — `lib/chats.ts` persists chats, messages and items in `chrome.storage.local` (see below). |
| `tabs.captureVisibleTab` | `entrypoints/background.ts` (screenshot tool) |
| `tabs.{query,get,create,remove,getCurrent,sendMessage,onActivated,onUpdated}` | `entrypoints/background.ts`, `entrypoints/sidepanel/App.tsx`, `entrypoints/install/main.tsx` |
| `runtime.{onInstalled,onStartup,onMessage,onConnect,connect,sendMessage,getURL}` | `entrypoints/background.ts`, `entrypoints/content.ts`, `entrypoints/sidepanel/Chat.tsx`, `lib/gm.ts` |
| `identity` | Not used (confirmed by grep — OAuth device-code flows in `lib/oauth.ts` use plain `fetch`, not `chrome.identity`) |

**Doc bug found in passing:** the README (`## How it works`) says chat history lives in
`chrome.storage.session`. The code (`lib/chats.ts`) uses `chrome.storage.local` for the chat index,
message history and panel transcript. Worth a one-line README fix — flagged here, not changed, since
this pass owns only `docs/browsers.md`.

---

## Per-API support: Chrome vs. Firefox vs. Safari

Versions below are `version_added` from MDN's `browser-compat-data` (`webextensions/api/*.json`),
cross-checked against the MDN and Chrome API reference pages. "false" means never shipped.

### `userScripts` (register/update/execute, worlds, `configureWorld`)

| | Chrome | Firefox | Safari |
|---|---|---|---|
| `userScripts` API at all | 120 (MV3 only) | **136** (MV3 only; desktop), **138** (Android) | **Not supported** |
| `ExecutionWorld` (`USER_SCRIPT`/`MAIN`) | 120 | 136 | — |
| `RegisteredUserScript.worldId` (per-script world isolation) | 133 | 136 | — |

- [MDN: `userScripts`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts) · [Chrome: `chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts)

Firefox's `userScripts` (shipped Firefox 136, March 2025) is close to a drop-in replacement:
`register`/`update`/`unregister`/`getScripts`/`execute`/`configureWorld` all exist with matching
shapes, and it adds `getWorldConfigurations`/`resetWorldConfiguration` Chrome doesn't have. Two real
differences:

1. **Permission model.** Chrome requires the `userScripts` manifest permission *and* a manual
   "Allow User Scripts" toggle in `chrome://extensions` (or Developer Mode pre-138) — a user gesture
   usermods currently detects and messages around (`userScriptsStatus()` in `background.ts`).
   Firefox instead uses `optional_permissions` + runtime `permissions.request({permissions:
   ['userScripts']})` — no separate browser-chrome toggle, but the request has to happen from a user
   gesture in the extension UI, which usermods' first-run / settings flow would need to trigger.
2. **Policy, not code.** Firefox's Add-on Policies restrict `userScripts` to "user script managers"
   — extensions "that allow users to manage website-specific scripts" — and state the API "cannot be
   used to extend or modify the functionality of the user script manager itself," with a requirement
   that installing a script be an explicit user action and that installed scripts be visible/removable
   ([Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)). usermods'
   *saved mods* flow (LLM proposes → user clicks Save → registered) fits this cleanly. The *Try* flow
   (`chrome.userScripts.execute` running a draft the user hasn't saved yet, `executeInTab()` in
   `background.ts`) is closer to "run arbitrary code the model wrote" than "manage installed scripts" —
   worth an explicit read from AMO reviewers before submitting, not a blocker on the API itself.

Safari has **no `userScripts` API, legacy or MV3** — confirmed absent from MDN's compat data
(`version_added: false` on every sub-interface) and from how the existing Safari userscript
managers work: [quoid/userscripts](https://github.com/quoid/userscripts), the most complete Safari
userscript manager, injects via its own content-script/native-messaging machinery rather than a
`browser.userScripts` primitive, and documents that Safari content scripts cannot bypass a page's
CSP the way `userScripts`' isolated world can elsewhere. There is nothing to port to; this is a
rewrite of the entire execution layer (see [Safari verdict](#safari-verdict)).

### `runtime.onUserScriptMessage` / ports from the user-script world

| | Chrome | Firefox | Safari |
|---|---|---|---|
| `runtime.onUserScriptMessage` | 120 | **136** (requires `userScripts` permission) | Not supported |
| `runtime.onUserScriptConnect` (ports) | 120 | 136 | Not supported |

- [MDN: `runtime.onUserScriptMessage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onUserScriptMessage)

Same shape on Firefox: registered code calls `chrome.runtime.sendMessage`/`chrome.runtime.connect`
from inside the `USER_SCRIPT` world (as `lib/gm.ts`'s generated wrapper does today), and the
background listens on the dedicated `onUserScriptMessage`/`onUserScriptConnect` handlers instead of
generic `onMessage`/`onConnect`, exactly matching Chrome's separation. No shim needed beyond the
`browser.*` vs `chrome.*` namespace (webextension-polyfill or WXT's built-in browser global handles
that). Ports specifically (`lib/gm.ts`'s `chrome.runtime.connect({name: 'gm:' + id})` for live
cross-tab `GM_addValueChangeListener` pushes) work the same way via `onUserScriptConnect`.

### `sidePanel` vs. Firefox's `sidebar_action` / Safari's absence

| | Chrome | Firefox | Safari |
|---|---|---|---|
| `sidePanel.*` | 114 (`open`/`setOptions` 116) | **Not supported** | **Not supported** |
| Equivalent | — | `sidebarAction` (`sidebar_action` manifest key), Firefox 54+, stable well before MV3 | No sidebar/side-panel surface for extensions |

- [MDN: `sidePanel`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidePanel) (Firefox: `version_added: false` on every member) · [MDN: `sidebarAction`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction)

Not a version gap, an entirely different API: different manifest key (`sidebar_action` vs.
`side_panel`), different lifecycle (Firefox's sidebar is per-window and opened with
`sidebarAction.open()` from a user gesture — no `setPanelBehavior({openPanelOnActionClick: true})`
equivalent, so the action-click-opens-panel behavior `background.ts` sets up needs to become an
explicit `action.onClicked` → `sidebarAction.open()` handler), different methods (`open`, `close`,
`toggle`, `setPanel`, `setIcon`, `setTitle` vs. Chrome's `setOptions`/`getOptions`). The panel UI
itself (React tree in `entrypoints/sidepanel/`) is portable; the host chrome around it — the entry
point's manifest wiring and open/close triggering — is not, and needs a Firefox-specific code path.
Safari has neither API; a Safari build would need the toolbar-popup pattern instead (see
[Safari verdict](#safari-verdict)).

### `declarativeNetRequest` (dynamic rules, `regexSubstitution` redirect)

| | Chrome | Firefox | Safari |
|---|---|---|---|
| `declarativeNetRequest` (base) | 84 | 113 | **15** |
| `updateDynamicRules` | 84 | 113 | **15.4** |
| `RuleAction` (redirect actions, incl. `regexSubstitution`) | 84 | 113 | **15** |

- [MDN: `declarativeNetRequest`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest) · [MDN: `declarativeNetRequest.updateDynamicRules`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/updateDynamicRules)

usermods' one rule (`installUserJsRedirect()` in `background.ts`: redirect `*.user.js` navigations to
`install.html#<url>` via `regexFilter` + `action.redirect.regexSubstitution`) is supported as-is on
both Firefox and Safari at the versions above — regex redirect rules, `resourceTypes: ['main_frame']`
and dynamic rule updates are all covered. This is the one API in the list that needs literally no
porting work.

### `scripting.executeScript` (with `files`)

| | Chrome | Firefox | Safari |
|---|---|---|---|
| `scripting.executeScript` | 88 | 102 | **15.4** |
| `world: 'MAIN'` | 95 | 128 | 15.4 |
| `injectImmediately` | 102 | 102 | 15.4 (partial — Safari always injects immediately) |

- [MDN: `scripting.executeScript`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript)

usermods' only use (`sendToContent()`'s fallback: inject `content-scripts/content.js` by file path
when `tabs.sendMessage` fails because the content script isn't there yet) is supported everywhere,
including Safari, at versions far below any other floor this list sets. No porting work.

### `storage.local` and `storage.session`

| | Chrome | Firefox | Safari |
|---|---|---|---|
| `storage.local` | long-standing | long-standing | long-standing |
| `storage.session` | 102 | **115** | **16.4** |

- [MDN: `storage.session`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session)

Moot for the actual port: as noted above, usermods doesn't call `storage.session` anywhere in
`entrypoints/` or `lib/` — only `storage.local`, which is universally supported. If the README's
description is ever made true (moving chat history to `storage.session`), that would still be safe
on Firefox 115+/Safari 16.4+, both well under every other floor here.

### `tabs.captureVisibleTab`

| | Chrome | Firefox | Safari |
|---|---|---|---|
| `tabs.captureVisibleTab` | 5 | **47** (`<all_urls>` only through FF125; `<all_urls>` *or* `activeTab` from FF126) | **14** |

- [MDN: `tabs.captureVisibleTab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab)

Supported everywhere at versions far below the `userScripts` floor. usermods requests
`host_permissions: ['<all_urls>']` already (no `activeTab`), which satisfies every version on every
browser here — no permission changes needed for the screenshot tool specifically.

### `sidePanel` vs. `sidebar_action`, `declarativeNetRequest`, `scripting`, `storage.session`, `tabs.captureVisibleTab`, `identity`

Summarized in the tables above; `identity` isn't called anywhere (`lib/oauth.ts` does its device-code
flows with plain `fetch`, no `chrome.identity`), so there's nothing to port for it.

---

## Firefox: effort estimate and port plan

**Verdict: feasible, moderate effort.** Every API usermods calls either exists on Firefox in
close-to-identical shape (`userScripts`, `onUserScriptMessage`/`onUserScriptConnect`,
`declarativeNetRequest`, `scripting.executeScript`, `storage.*`, `tabs.captureVisibleTab`) or has a
well-documented Firefox-native equivalent that needs a real adapter (`sidePanel` → `sidebarAction`).
`userScripts` landed in Firefox 136 (March 2025), so the floor is recent but stable — this is not
waiting on an unshipped API anymore, which is presumably why the README's roadmap entry ("Firefox,
once its side panel story is settled") predates Firefox 136 shipping `userScripts` at all; the
side-panel gap is now the only structural blocker, not the userscript execution model.

**Build target:** `npx wxt build -b firefox` (WXT's Firefox target handles the `manifest_version`/
`browser_specific_settings` shape and the `chrome.*` → `browser.*` promise-based namespace via its
built-in polyfill, so most of `lib/` and `entrypoints/` need zero change).

**What needs a Firefox-specific code path (not just a version bump):**

1. **Side panel → sidebar.** The one real architecture change. `chrome.sidePanel.setPanelBehavior({
   openPanelOnActionClick: true })` (`background.ts:24`) has no Firefox counterpart; replace with
   `browser.action.onClicked.addListener(() => browser.sidebarAction.open())` behind a
   `browser.sidePanel ? ... : ...` feature check (or a build-time `import.meta.env.FIREFOX` branch,
   which WXT provides). The panel's own React code (`entrypoints/sidepanel/`) is unaffected — it's
   the same page, opened differently. `entrypoints/sidepanel/App.tsx`'s `tabs.onActivated`/
   `tabs.onUpdated` listeners (used to track which tab's chat to show) work unchanged since
   `sidebarAction` panels, like `sidePanel`, are long-lived pages that can listen for tab events.

2. **`userScripts` permission request flow.** Chrome's model is a static manifest permission plus an
   out-of-band browser-chrome toggle, which `userScriptsStatus()` already detects and surfaces as an
   error message with instructions. Firefox's model is `optional_permissions: ['userScripts']` in the
   manifest plus a runtime `browser.permissions.request(...)` call that must originate from a user
   gesture in the extension's own UI (e.g. a "Enable user scripts" button in Settings, not an
   automatic call on load). This replaces the toggle-detection logic with a request-and-await flow;
   size: small, self-contained in `background.ts` + a Settings UI affordance.

3. **`chrome.*` → cross-browser namespace.** WXT's polyfill covers this for the promise-based APIs
   used throughout `lib/` and `entrypoints/`. The one spot to check by hand:
   `lib/gm.ts`'s generated wrapper code is a **string template injected into registered user
   scripts**, not bundled application code — it calls `chrome.runtime.sendMessage`/`connect`
   directly (`typeof chrome !== 'undefined'` checks already present) because that's what
   `chrome.userScripts.register()`'s `js: [{code}]` executes into, and WXT's bundler-level polyfill
   doesn't touch strings interpreted at runtime inside the browser. Firefox exposes `chrome.*` as an
   alias for `browser.*` in extension contexts including the `USER_SCRIPT` world (both are
   Promise/callback-dual APIs there), so the existing `chrome.runtime.sendMessage(msg, callback)`
   callback-style calls in the generated GM shim should work verbatim — worth a direct Firefox smoke
   test of `GM_setValue`/`GM_addValueChangeListener` specifically, since this is the one code path
   that bypasses the polyfill by construction.

4. **AMO listing language for the `userScripts` policy.** Not code — the review-facing description
   needs to frame usermods within "user script manager" terms (explicit install action via Save,
   visible/removable list in the Mods tab, both true today) and be ready to explain the Try/run-once
   flow (`chrome.userScripts.execute` on an unsaved draft) if a reviewer asks, since it's arguably
   outside "managing installed scripts." Doesn't block submission on its own, but is worth having an
   answer for before submitting rather than after a rejection.

5. **Regenerate store assets / manifest metadata** — `browser_specific_settings.gecko.id` and
   `strict_min_version` (`136` for MV3 `userScripts`), an AMO listing separate from the Chrome Web
   Store one, and updated screenshots if the sidebar chrome looks different from the side panel
   (cosmetic, not architectural).

**Not needed:** any change to the agent loop, provider adapters, mod header parsing, GM API surface,
Tampermonkey import, or the install-page `.user.js` redirect — all of that is either pure TypeScript
with no `chrome.*` calls or calls into APIs Firefox already matches.

**Rough sizing:** the sidebar adapter and permission-request flow are each a day or so of focused
work plus testing; the GM-shim namespace check is a few hours of manual verification, not new code;
AMO listing copy and screenshots are a documentation task. Call it a small-to-medium single-session
port, not a rearchitecture — bounded mostly by how much manual testing of `userScripts`/GM API
parity on real Firefox is warranted before shipping, since that surface is exactly the part that
can't be typechecked or unit-tested (`npm test` covers header/backup parsing only; there's no browser
integration harness for `chrome.userScripts` and none is planned by this doc).

## Safari verdict

**Updated after the port.** This section originally read "not feasible without rearchitecting the
mod-execution layer". The first half of that was right and the rearchitecture has since been done:
usermods ships on Safari for iPhone and iPad, and [docs/safari.md](safari.md) documents the build, the
isolation guarantees and the limitations. The API research below is unchanged and still accurate,
because none of it was wrong. What changed is the conclusion drawn from it.

Two separate problems were identified. The first is solved. The second is still open, and it is a
distribution question rather than an engineering one.

**1. No `userScripts` API. Solved by writing a second execution engine.** The finding stands: Safari
Web Extensions have never shipped `browser.userScripts` in any form, so there was nothing to port to
and the entire mod lifecycle had to be rebuilt on Safari's own primitives. That is what `lib/exec/`
is. One content script declared on `<all_urls>` at `document_start` in all frames asks the background
which mods belong to its document, and the background answers with code built and bound to that
frame; the runner honours each mod's `@run-at` itself, because Safari always injects immediately.
`scripting.executeScript` turned out to be the wrong primitive for this, not the right one: it takes
`files` or a serialized `func` and never a code string, so it cannot run source a model just wrote.

Two consequences were predicted here and both are real. The isolated-world CSP bypass that
`userScripts` gives elsewhere is gone, so a `@grant none` mod fails on CSP-strict sites and usermods
reports it blocked rather than rewriting the site's CSP. And the GM bridge had to be rebuilt, because
GM traffic now shares `runtime.onMessage` with every other extension surface; a self-declared `modId`
on that channel would be a forgeable claim, so identity moved to a capability token the background
mints per mod per frame (`lib/exec/grants.ts`). The `sidePanel` gap was the UI-shell swap this section
predicted: the popup is the whole of usermods on iOS, which turned out to be a genuine mobile UI
project rather than a swap.

**2. App Store review: guideline 2.5.2 still applies, and nothing here tests it.** Apple's guideline
2.5.2 blocks apps and their extensions from downloading, installing or executing code that
"introduces or changes features or functionality", with a narrow carve-out for educational
code-execution apps that keep all such code viewable and editable by the user
([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)). A model writing
a script that the extension then runs is close to the case that guideline exists to catch, and the
educational framing probably does not apply: usermods writes code for the user rather than teaching
them to write it. This is independent of which API runs the code, so the rewrite above does not touch
it.

What that means in practice: building and installing on your own device with your own Apple developer
account works today and is what [docs/safari.md](safari.md) describes. App Store distribution has not
been attempted, is not attempted by that work, and would need a real read from App Review before
anyone counts on it. Packaging is not the obstacle. Apple's format is close to Chrome's (a
WebExtension bundled as an `.appex` inside a host app) and the repository carries a hand-written Xcode
project that builds it.

---

## Sources

- [MDN: `userScripts`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts) · [`userScripts.register()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts/register) · [`runtime.onUserScriptMessage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onUserScriptMessage) · [`sidePanel`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidePanel) · [`sidebarAction`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction) · [`declarativeNetRequest`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest) · [`scripting.executeScript`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript) · [`storage.session`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session) · [`tabs.captureVisibleTab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureVisibleTab)
- [mdn/browser-compat-data](https://github.com/mdn/browser-compat-data) — `webextensions/api/{userScripts,runtime,sidePanel,declarativeNetRequest,scripting,storage,tabs}.json`, the machine-readable source for every version number above
- [Chrome for Developers: `chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts)
- [Firefox Extension Workshop: Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) — `userScripts`-for-user-script-managers-only rule, remote-code prohibition, reviewable-source requirement
- [Apple: App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — Guideline 2.5.2
- [quoid/userscripts](https://github.com/quoid/userscripts) — reference for how Safari userscript managers work today in the absence of a `userScripts` API
