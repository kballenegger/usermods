# Manual QA checklist

For Kenneth to run in real Chrome. Automation (`npm run smoke`) drives the chat/agent loop
headless against a mock LLM, but it cannot flip Chrome's own "Allow User Scripts" toggle, sign
in to a real subscription, or click a real `chrome://extensions` UI — so everything here is the
part nothing else has run.

Target: about an hour, most of it in the GM API and import/export sections. The basic chat/agent
loop (send a message, watch it inspect the page, get a proposal) already works and gets a
2-minute pass at the top rather than full coverage.

**Before you start:** `npm install && npm run build`, then load `.output/chrome-mv3` as an
unpacked extension (`chrome://extensions` → Developer mode → Load unpacked). Use a throwaway
Chrome profile or one you don't mind littering with test mods. Where a step says "reload the
extension," that means the ⟳ icon on usermods' card in `chrome://extensions`, not just closing
the panel.

**When something fails**, the "if it fails, send me" line on each item says which console to
copy from:
- **side panel DevTools** — right-click inside the open side panel → Inspect.
- **service worker console** — `chrome://extensions` → usermods card → **service worker** link (opens if not already).
- **page console** — DevTools on the tab you're testing on (F12), Console tab.

Copy the full red error text and stack, not just the first line.

---

## 0. Fresh install, consent notice, toggle notice (2 min sanity pass)

You've already confirmed the basic chat/agent loop works. This section just re-confirms the
first-run surfaces still look right — skip deeper testing here.

1. Remove any existing usermods install, then Load unpacked from `.output/chrome-mv3`.
   **Expected:** extension installs with no console errors; icon appears in the toolbar.
   **If it fails:** service worker console.
2. Click the toolbar icon to open the side panel while still on the Details page (before turning
   on "Allow User Scripts").
   **Expected:** a banner reading *"usermods needs the "Allow User Scripts" toggle. 1. Open
   chrome://extensions 2. Click Details on usermods 3. Turn on "Allow User Scripts""* (or, on
   Chrome < 138, a Developer Mode variant) appears above the tabs.
   **If it fails:** side panel DevTools.
3. Go to `chrome://extensions` → Details on usermods → turn on **Allow User Scripts**. Return to
   the panel (click into it, or refocus the window).
   **Expected:** the toggle banner disappears within a couple seconds (it rechecks on window
   focus).
   **If it fails:** side panel DevTools.
4. On the **Chat** tab, with nothing accepted yet, confirm the **"Before your first message"**
   consent card is showing instead of the composer, with sections *What gets sent*, *Where it
   goes*, *What stays here*, and a primary button labeled **"I understand"**.
   **Expected:** clicking **I understand** replaces the card with the normal chat composer.
   **If it fails:** side panel DevTools.
5. Open a normal page (not `chrome://…`), type a one-line request in the composer (e.g. "make
   the background pink"), hit Enter, and let it run to a proposal card with **Try now** / **Save
   & enable** buttons.
   **Expected:** streaming text appears, at least one tool call row appears and resolves (✓), and
   a proposal card renders with a name, description, match chips, and both buttons enabled.
   **If it fails:** side panel DevTools (chat) and service worker console (tool calls / model
   traffic).

---

## 1. Save & enable, reload, confirm the mod ran

1. From the proposal you just got in step 0.5, click **Save & enable**.
   **Expected:** the button's label changes to **"Saved & enabled"** and becomes disabled.
   **If it fails:** side panel DevTools.
2. Go to the **Mods** tab.
   **Expected:** the mod appears under **On this site**, its **on** checkbox is checked, and
   **Show code** reveals the full userscript with a `==UserScript==` header.
   **If it fails:** side panel DevTools.
3. Reload the page (F5 or Cmd+R) the mod matches.
   **Expected:** the change described in the proposal is visible on the page without touching
   the extension again.
   **If it fails:** page console — also check the mod's **Show code** for the actual generated
   selector/logic if the visual result looks wrong rather than absent.
4. In Mods, click **Run now** on the mod.
   **Expected:** no error alert; the effect is (re)applied live without a reload.
   **If it fails:** page console.
5. Uncheck the **on** checkbox, reload the page.
   **Expected:** the mod's effect is gone (this is the enable/disable — there is no separate
   archive state; unchecking "on" is the closest thing to archiving, and **Delete** is the only
   way to remove a mod for good).
   **If it fails:** page console; also re-check Mods tab shows it unchecked, greyed out (0.6
   opacity card).

---

## 2. Element references (`@` picker)

1. In Chat, click **⌖ Point at element**.
   **Expected:** button label changes to **"Click an element…"**, and hovering the page now
   highlights elements under the cursor.
   **If it fails:** page console (the picker is a content-script overlay).
2. Click a distinctive element (e.g. a heading or button on the page).
   **Expected:** the picker closes, an `@token` (e.g. `@h1.title`) is inserted into the composer
   at the cursor, and a chip reading `@token → <label>` appears above the composer.
   **If it fails:** side panel DevTools.
3. Pick a second, different element while the first chip is still present.
   **Expected:** a second chip with a distinct token (no collision/overwrite of the first).
   **If it fails:** side panel DevTools.
4. Click the **×** on one chip.
   **Expected:** that chip disappears and its `@token` text is removed from the composer text.
   **If it fails:** side panel DevTools.
5. Send a message that still contains one `@token`.
   **Expected:** in the sent message bubble, the reference chip shows under the text (only refs
   whose token is still present in the message text are attached — confirm a chip you deleted in
   step 4 is *not* attached).
   **If it fails:** side panel DevTools; service worker console if the model's tool calls don't
   reflect the referenced element's selector.

---

## 3. Queue mid-run and Stop

1. Send a message that will take a few tool calls to answer (e.g. "read the whole page, list all
   the buttons, then propose something").
2. While it's still running (composer shows **Queue** button instead of **Send**, and a **Stop**
   button is visible), type a second message and click **Queue**.
   **Expected:** the message appears in the transcript marked **"queued · will be sent between
   steps"**.
   **If it fails:** side panel DevTools.
3. Let the run continue.
   **Expected:** the queued message eventually loses its "queued" label once the agent reaches a
   point between tool calls (an `accepted` event un-queues it); it is answered without you doing
   anything further.
   **If it fails:** side panel DevTools, service worker console.
4. Start another long-running message. This time click **Stop** while it's mid-run.
   **Expected:** streaming stops promptly; the **Stop** button disappears and **Send** returns;
   the transcript keeps whatever was produced so far (no crash, no stuck spinner).
   **If it fails:** side panel DevTools, service worker console.
5. Repeat step 4, but this time queue a message *then* hit Stop before it's accepted.
   **Expected:** the queued (unaccepted) message is dropped back into the composer text box (an
   `unqueued` event refunds it) rather than silently lost — check the composer text after
   stopping.
   **If it fails:** side panel DevTools.

---

## 4. Chat persistence: panel reload, browser restart, second chat, archive/unarchive

1. With an existing chat with a few messages, close and reopen the side panel (or switch tabs
   away and back).
   **Expected:** the same transcript is still there, no reload/refetch flash of an empty chat.
   **If it fails:** side panel DevTools.
2. Fully quit and relaunch Chrome (Chrome menu → Quit, not just closing the window), reopen the
   same page, open the side panel.
   **Expected:** the chat transcript for that site survives (chat history is `chrome.storage.
  session`-backed per the README's session note — confirm it actually does survive a full
   restart; if it does not, that's a real finding worth reporting, not a checklist bug).
   **If it fails:** side panel DevTools — note whether the chat list is empty or just the
   selected transcript is empty.
3. On the same site, click **New chat**, then send a different request than your first chat.
   **Expected:** a second entry appears in the chat switcher dropdown (`<title> · <relative
   time>`), and switching between the two in the dropdown shows each transcript independently.
   **If it fails:** side panel DevTools.
4. With two+ chats on a site, use the dropdown to switch to the older one, then click the
   **Delete** button next to the dropdown.
   **Expected:** a confirm dialog naming the chat's title; on confirming, that chat disappears
   from the dropdown and the panel falls back to the next most recent chat (or the empty "New
   chat" state if none remain).
   **If it fails:** side panel DevTools.
5. Note: there is no separate archive/unarchive action for **chats** in this build — only
   **Delete**. For mods, "archive" is the **on/off** checkbox covered in section 1 step 5. If you
   expected a dedicated archive control and don't see one anywhere (chat switcher, Mods cards),
   that's expected — not a bug — but flag it if the UI looks different from this description.

---

## 5. Install from a Greasy Fork link (`.user.js` redirect)

1. Find any real userscript on Greasy Fork (greasyfork.org) — open a script's page and click its
   **Install this script** link (a `.user.js` URL).
   **Expected:** instead of Chrome downloading/opening raw JavaScript, you land on usermods' own
   **Install userscript** page (`install.html#https://…`), showing "Fetching from `<url>`" then a
   full preview card: name, version chip, description, "Runs on (N)" chips, Permissions, "Can
   request" (if it has `@connect`), "Loads N libraries" (if `@require`), Resources (if
   `@resource`), "Runs at `<run-at>`", and a **Show full source** disclosure.
   **If it fails:** page console on the install tab; note the exact URL that didn't redirect.
2. Click **Install**.
   **Expected:** an "Installed" card confirming the name is installed and enabled, with a
   **Close tab** button; the mod now appears in the Mods tab (matching site if the URL's site is
   one it targets).
   **If it fails:** side panel DevTools (open Mods tab after) and service worker console (the
   `@require`/`@resource` fetch happens there).
3. Open the extension's Mods tab and confirm the newly installed mod shows a **Update** button
   (present only when the script has a `@downloadURL`) — most Greasy Fork scripts have one.
   **Expected:** **Update** button visible.
   **If it fails:** side panel DevTools.

---

## 6. `@require` + `GM_setValue`/`GM_getValue`, synced across two tabs

Write (or find) a small test script with a header like:

```js
// ==UserScript==
// @name         QA GM test
// @match        https://example.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// ==/UserScript==
GM_setValue('qaSeen', (GM_getValue('qaSeen', 0)) + 1);
document.title = 'qa:' + GM_getValue('qaSeen') + (typeof jQuery !== 'undefined' ? ':jq-ok' : ':jq-missing');
GM_addValueChangeListener('qaSeen', (key, oldV, newV, remote) => {
  if (remote) document.title += ':remote-update';
});
```

1. Install it via **Import file** (Mods tab) or **Install from URL**, confirm the preview shows
   **"Loads 1 library"** with the jQuery URL under it, and install.
   **Expected:** install succeeds (the library is fetched and stored at install time).
   **If it fails:** service worker console (the `@require` fetch), and check the specific URL
   named in the error.
2. Open two separate tabs on `https://example.com/`.
   **Expected:** both tabs' titles start with `qa:` and end `:jq-ok` (confirms `@require`
   evaluated before the script body, and `GM_getValue`/`GM_setValue` both work).
   **If it fails:** page console on each tab.
3. Compare the counters in the two tabs' titles.
   **Expected:** each fresh page load increments from the value stored at registration time —
   confirm the number is *not* stuck at 1 in both (i.e. `GM_setValue` writes persist across
   loads).
   **If it fails:** page console; service worker console for the write RPC.
4. With both tabs open and loaded, reload just one of them.
   **Expected:** per the README, the *other*, still-open tab's title gets `:remote-update`
   appended shortly after — confirms writes are "pushed live to the script's other open tabs" via
   `GM_addValueChangeListener`.
   **If it fails:** page console in the tab that should have received the remote update; service
   worker console for the broadcast.

---

## 7. `GM_xmlhttpRequest` with and without a matching `@connect`

Use a test script like:

```js
// ==UserScript==
// @name         QA XHR test
// @match        https://example.com/*
// @grant        GM_xmlhttpRequest
// @connect      httpbin.org
// ==/UserScript==
GM_xmlhttpRequest({
  url: 'https://httpbin.org/get',
  onload: (r) => { document.title = 'xhr-ok:' + r.status; },
  onerror: (e) => { document.title = 'xhr-fail'; console.error(e); },
});
GM_xmlhttpRequest({
  url: 'https://example.org/',   // NOT covered by @connect httpbin.org
  onload: (r) => { document.title += ':blocked-ok-unexpected'; },
  onerror: (e) => { document.title += ':blocked-as-expected:' + (e && e.error); },
});
```

1. Install and run on `example.com`.
   **Expected:** title becomes `xhr-ok:200` from the first request (host `httpbin.org` matches
   the `@connect httpbin.org` line).
   **If it fails:** page console; service worker console (the request is proxied through the
   background worker).
2. Check the second request's result.
   **Expected:** title gets `:blocked-as-expected:` appended, and the `onerror` callback's error
   / the console shows the exact refusal text: `GM_xmlhttpRequest to example.org is not allowed
   by this script's @connect list. Add "// @connect example.org" to its header to permit it.`
   **If it fails:** page console — copy the literal error string, it should name the host and the
   exact `// @connect` line needed.
3. Edit the script to add `// @connect *` instead, save it as an update, reload the page.
   **Expected:** both requests now succeed (any host allowed).
   **If it fails:** page console, service worker console.
4. Try a script with `// @connect self` whose `@match` is `https://example.com/*` only, requesting
   `https://example.com/get` vs `https://sub.example.com/get`.
   **Expected:** both succeed — per the README, `self` covers the script's own `@match`/
   `@include` domain and its subdomains.
   **If it fails:** page console; copy the exact refusal text if one host is unexpectedly
   blocked.

---

## 8. `@grant none` script in the page world

```js
// ==UserScript==
// @name         QA page-world test
// @match        https://example.com/*
// @grant        none
// ==/UserScript==
window.qaPageWorldMarker = true;
document.title = 'pageworld:' + (typeof unsafeWindow === 'undefined' ? 'isolated-globals' : 'shared-globals');
```

1. Install it, open the Mods tab.
   **Expected:** the mod's card shows a **"page world"** chip (amber/warn styling), with tooltip
   "Runs in the page's own JavaScript context (@grant none or unsafeWindow)."
   **If it fails:** side panel DevTools.
2. Load `example.com`, open the page's own DevTools console, and type `window.qaPageWorldMarker`.
   **Expected:** `true` — confirms the script ran in the MAIN world and can set a real page
   global (an isolated-world script could not do this).
   **If it fails:** page console.
3. Try a `GM_setValue` call in a `@grant none` script (add `GM_setValue('x', 1)` to the body
   above) and reload the page twice.
   **Expected:** per the README, this updates only the in-page copy and **cannot be persisted**
   — confirm the value does *not* survive a reload (unlike section 6's isolated-world script).
   **If it fails:** page console; this is documented, expected behavior, not a bug, but confirm
   it matches so the README claim is accurate.

---

## 9. Update button

1. Take the mod installed in section 5 (has a `@downloadURL`/Update button), or install any
   Greasy Fork script with an old cached version.
2. In Mods, click **Update** on it.
   **Expected:** status line shows either `"<name>" is up to date.` or `"<name>" updated to
   <version>.` — no error, no duplicate mod card created.
   **If it fails:** side panel DevTools; service worker console for the refetch/compare against
   `@version`.
3. If you can find/construct a script whose remote copy differs from the installed one (e.g.
   re-host a locally edited copy with a bumped `@version` at a URL you control, install it, then
   edit the remote file and bump the version again), click **Update**.
   **Expected:** status reads `"<name>" updated to <new version>.`, **Show code** reflects the
   new source, and any `GM_setValue` values previously stored are **not** wiped by the update.
   **If it fails:** side panel DevTools; diff the mod's stored values before/after via a
   `GM_listValues`-reading test line if needed.

---

## 10. Tampermonkey export/import — JSON and ZIP, including stored values

You need a Tampermonkey install (or another Chrome profile with it) to produce real backups.

1. In Tampermonkey: install 2+ scripts (one with a `GM_setValue` store — e.g. run it once so it
   writes a value — and one disabled). Dashboard → **Utilities** tab → **File** → **Export**,
   save as **JSON**.
2. In usermods, Mods tab → expand **Migrate from Tampermonkey** (**Show** button) → **Choose
   backup file** → pick the `.json` file.
   **Expected:** a status line summarizing the import (counts of imported/updated/skipped, from
   `summarizeImport`), and the scripts appear in the Mods list with the same enabled/disabled
   state they had in Tampermonkey.
   **If it fails:** side panel DevTools; service worker console (the parse happens via an RPC).
3. Confirm the stored value came across: run the migrated script (or inspect via **Show code** /
   a small GM_getValue test line) and check it sees the same value it had in Tampermonkey, not a
   fresh/empty one.
   **If it fails:** page console on a page the script matches.
4. Repeat steps 1–3 but export from Tampermonkey as **ZIP** instead of JSON.
   **Expected:** same result — status summary, correct enabled state, stored values present.
   Internally the ZIP has one `.user.js` per script plus `.options.json`/`.storage.json`
   sidecars; confirm the import handles it without you needing to know that.
   **If it fails:** side panel DevTools; if you get "That file is not a ZIP archive." or "No
   scripts found in that archive.", copy the exact message plus the tool/version you used to
   create the ZIP.
5. Re-import the *same* JSON or ZIP a second time (same scripts, no version bump).
   **Expected:** per the README, matching is by `@downloadURL` (or `@namespace`+`@name`), so a
   duplicate mod should NOT appear — it should update the existing one in place, keeping its
   registration and id, and merge in the backup's values rather than creating a second copy.
   **If it fails:** side panel DevTools — count the mods in the list before and after; report if
   the count grew.

---

## 11. ChatGPT subscription sign-in and a turn

Only present in the GitHub build (`npm run build`), not `build:store`. Skip if testing the store
build.

1. Settings tab → click the **ChatGPT** preset button (or set Provider to "ChatGPT subscription
   (Sign in with ChatGPT)").
   **Expected:** a card reading "Not signed in to ChatGPT." with a primary **Sign in with
   ChatGPT** button.
   **If it fails:** side panel DevTools.
2. Click **Sign in with ChatGPT**.
   **Expected:** a new tab opens to the vendor's device-code page, and the panel shows a large
   monospace user code plus **Open sign-in page** / **Copy code** / **Cancel** buttons and
   "Waiting for approval…".
   **If it fails:** side panel DevTools; service worker console (device-code request).
3. Complete sign-in in the opened tab with a real ChatGPT Plus/Pro/Team account, entering the
   code shown.
   **Expected:** within ~2 s polling intervals, the panel updates to "Signed in to ChatGPT as
   `<label>`" with a **Sign out** button.
   **If it fails:** side panel DevTools, service worker console (poll/token exchange) — copy any
   error from the "Sign-in was interrupted. Start again." path if polling times out.
4. Click **Fetch models** in the Model field.
   **Expected:** a dropdown-backed list of model ids populates, or an explicit error if the plan
   returns none.
   **If it fails:** side panel DevTools.
5. Pick a model, go to Chat, send a real one-line request on a real page.
   **Expected:** a real streamed response and (ideally) a working proposal, same shape as the
   mock-LLM smoke test but against the live ChatGPT backend. This exercises real API usage
   against your subscription — keep it to one small turn.
   **If it fails:** side panel DevTools, service worker console.
6. Click **Sign out**.
   **Expected:** reverts to "Not signed in to ChatGPT."
   **If it fails:** side panel DevTools.

---

## 12. SuperGrok sign-in and a turn

Same flow as section 11, with the **SuperGrok subscription** preset / "xAI subscription
(SuperGrok / X Premium+)" provider option. Also GitHub-build only.

1. Sign in via the same device-code flow. The button reads **Sign in with xAI** (not "SuperGrok"
   — the card's vendor label is "xAI" even though the preset is called "SuperGrok subscription").
   **Expected:** same device-code UI as ChatGPT; caption text says "Requires SuperGrok, or X
   Premium+ on the X account you sign in with. Some standard-tier accounts are rejected by xAI
   with a 403."
   **If it fails:** side panel DevTools, service worker console.
2. If you hit a 403 on a standard-tier account, that matches a documented, known caveat — note it
   but it is not itself a bug unless the error is unhandled/uncaught (panel should show a
   readable error, not crash or hang on "Waiting for approval…" forever).
   **If it fails:** side panel DevTools, service worker console — copy the exact status/error.
3. Once signed in, **Fetch models**, confirm the datalist has entries (default model preset is
   `grok-4.6`).
   **If it fails:** side panel DevTools.
4. Send one real turn in Chat.
   **Expected:** streamed response, tool calls resolve.
   **If it fails:** side panel DevTools, service worker console.
5. Sign out, confirm it reverts cleanly.

---

## 13. `npm run build:store` — no subscription options

1. From the worktree root: `npm run build:store`.
   **Expected:** build completes clean (same as a normal build, just with `USERMODS_STORE=1`).
   **If it fails:** paste the build output.
2. Load `.output/chrome-mv3` (the store build's output — same output dir, so unload/reload the
   dev build first or use a separate profile) as an unpacked extension.
3. Open Settings.
   **Expected:** the preset row has **no** "ChatGPT subscription" or "SuperGrok subscription"
   buttons; the Provider `<select>` has only **"Anthropic (Messages API)"** and **"OpenAI-
   compatible (chat/completions)"** — no ChatGPT/xAI subscription options at all.
   **If it fails:** side panel DevTools — view page source / React DevTools if available to
   confirm the options are actually absent from the DOM, not just hidden.
4. Open the consent notice (Settings → **Review data notice**, or fresh profile first run).
   **Expected:** the "Where it goes" section does **not** mention "your ChatGPT or SuperGrok
   subscription", and "What stays here" does not mention "and subscription tokens" — the
   `STORE_BUILD` conditionals in `Consent.tsx` should have dropped that language.
   **If it fails:** side panel DevTools; screenshot the exact wording that leaked through.
5. If you have a profile previously signed in to ChatGPT/xAI from the GitHub build, point this
   store build at that same profile's data (or manually set `provider: 'chatgpt'` in storage).
   **Expected:** a red banner: "This build of usermods does not include subscription sign-in, so
   your ChatGPT / SuperGrok provider was switched back to the default. Add an API key below, or
   install the GitHub build to sign in with a subscription again." — and Settings falls back to
   the Anthropic provider with empty base URL / API key.
   **If it fails:** side panel DevTools.

---

## 14. Export a mod, import it into Tampermonkey

1. In usermods Mods tab, pick any saved mod and click **Export**.
   **Expected:** a `.user.js` file downloads, named from the mod's name (lowercased, non-word
   chars replaced with `-`), e.g. `my-mod-name.user.js`.
   **If it fails:** side panel DevTools (check for a blocked-download permission prompt too).
2. Open the downloaded file in a text editor.
   **Expected:** a valid `==UserScript==` header block followed by the script body — the same
   source shown under the mod's **Show code**.
3. In Tampermonkey's dashboard, use **Utilities** → **File** → **Import**, or drag the `.user.js`
   file into a new tab (Tampermonkey usually intercepts local `.user.js` file opens too) and
   confirm the install prompt.
   **Expected:** Tampermonkey installs it successfully — matches, grants, and the `==UserScript==`
   metadata are recognized. This exercises the reverse of section 10: is the exported file a
   *standard*, portable userscript?
   **If it fails:** note whatever error Tampermonkey's own install dialog shows and which header
   field it complained about (usually visible directly in Tampermonkey's UI, no separate console
   needed).
4. Load the page it matches in the Tampermonkey-only profile/tab.
   **Expected:** same effect as it has under usermods.
   **If it fails:** page console.

---

## Pass/fail table

| # | Section | Pass / Fail | Notes |
|---|---------|:---:|---|
| 0 | Fresh install, consent + toggle notice (sanity) | | |
| 1 | Try now / Save & enable, reload, mod ran | | |
| 2 | Element references (picker) | | |
| 3 | Queue mid-run and Stop | | |
| 4 | Chat persistence: reload, restart, second chat | | |
| 5 | Install from Greasy Fork `.user.js` link | | |
| 6 | `@require` + `GM_setValue`/`GM_getValue` sync (2 tabs) | | |
| 7 | `GM_xmlhttpRequest` with/without matching `@connect` | | |
| 8 | `@grant none` in page world | | |
| 9 | Update button | | |
| 10 | Tampermonkey import — JSON | | |
| 10 | Tampermonkey import — ZIP | | |
| 11 | ChatGPT subscription sign-in + turn | | |
| 12 | SuperGrok subscription sign-in + turn | | |
| 13 | `npm run build:store` — no subscription options | | |
| 14 | Export a mod → import into Tampermonkey | | |

For any **Fail** row, file an issue (or note here) with: the step number, the exact error text
copied from the console named in that step, the Chrome version (`chrome://version`), and whether
it's the GitHub build or the store build.
