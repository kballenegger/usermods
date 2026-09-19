# Notes for reviewers

The text to paste into the developer dashboard's **Notes for reviewers** field (Privacy practices
tab, below the permission justifications).

**Before pasting:** the placeholder `[reviewer key: PASTE HERE]` must be replaced with the real
reviewer key. Do not do it by hand and do not commit the key back into this file — run:

```sh
USERMODS_REVIEWER_KEY='…' node scripts/reviewer-notes.mjs | pbcopy
```

which prints the short version with the key substituted, ready to paste.

**The reviewer key is time-limited.** The current one is an OpenAI-compatible endpoint
(`[reviewer base URL: PASTE HERE]`, model `ornith`) and **expires 2026-10-03**. If a review runs
past that date the reviewer will hit an auth error, which is why the pasted text tells them to ask
via the support URL rather than conclude the extension is broken. Re-issue the key and update the
listing's note if the review is still open near that date.

A note on the field itself: Google does not document this field or its character limit anywhere on
developer.chrome.com — it exists in the dashboard UI but not in the published docs. The short
version below is **2,489 characters**, which is under every limit the field has been reported to
have. Paste the short version. If the field turns out to accept more, the long version underneath
adds the detail; it is otherwise reference material for answering a reviewer's follow-up email.

---

## Short version — paste this

```
WHAT IT IS
usermods is a user script manager. You describe a change to the page you are on in plain language,
a language model writes a userscript for it, and usermods saves and runs that script on matching
pages — the same job Tampermonkey does, with the script written by chat instead of by hand.

REQUIRED SETUP: ALLOW USER SCRIPTS
Chrome requires this of every user script manager; nothing works without it:
  1. Open chrome://extensions
  2. Click Details on usermods
  3. Turn on "Allow User Scripts"
The extension shows a banner with these steps until the toggle is on.

MODEL API KEY
The chat needs a model API key the user supplies. None is bundled; there is no account and no
server of ours. We provide one for your review. In the side panel open Settings (slider icon, top
right), click the "Custom OpenAI API" preset, then fill in all three fields — the preset selects
the OpenAI-compatible provider but does not fill these in:

  Base URL   [reviewer base URL: PASTE HERE]
  Model      ornith
  API key    [reviewer key: PASTE HERE]

Settings saves itself; there is no Save button. This key expires 2026-10-03 — if it has, please
request a new one at the support URL on our listing rather than reporting the chat broken.

5-MINUTE TEST
  1. Open https://en.wikipedia.org/wiki/Common_kingfisher
  2. Click the usermods toolbar icon to open the side panel; accept the first-run data notice.
  3. Type "hide the table of contents" and press Enter. It inspects the page and proposes a script.
  4. On the proposal card click "Run once" to see it applied, then "Open in draft". In the Draft
     panel at the bottom, click "Save".
  5. Reload the page — the table of contents stays hidden. Then Mods tab → Delete on that mod.

NO KEY NEEDED FOR THE IMPORT PATHS
Installing and running scripts needs no model or key. Open this URL for the install preview, then
Install (it exercises @require and GM.* grants):
https://update.greasyfork.org/scripts/478687/GitHub%20Custom%20Global%20Navigation.user.js
The Mods tab also imports from a file and from a Tampermonkey backup.

PRIVACY
No data goes to the developer. No account, no server, no telemetry — requests go only to the model
endpoint the user configured.
Policy: https://github.com/kballenegger/usermods/blob/main/PRIVACY.md

SINGLE PURPOSE
To create, install and run userscripts that customize the websites the user visits.

Each permission is justified individually above.
Source (MIT): https://github.com/kballenegger/usermods
```

---

## Long version — reference, and for answering follow-up questions

### What the extension is

usermods is a user script manager in the same category as Tampermonkey, Violentmonkey and
Greasemonkey: it stores userscripts with standard `==UserScript==` headers and registers them
through `chrome.userScripts` so they run on the pages their `@match` patterns cover. What
distinguishes it is how a script gets written — the user describes the change they want to a
language model they configure, and the model writes the script by inspecting the real page, rather
than the user typing the JavaScript themselves.

### Why "Allow User Scripts" is required

Since Chrome 138 the `chrome.userScripts` API is gated behind a per-extension **Allow User
Scripts** toggle (before that, behind Developer mode). Chrome requires this of every user script
manager; it is not specific to usermods and the extension cannot turn it on for the user. Until it
is on, `chrome.userScripts` is undefined and the extension shows a banner with the three steps
above on every surface. `minimum_chrome_version` is 135 for this reason.

This is also why some of the automated test flows in the repository cannot test a script end to
end: an automated Chrome profile cannot flip that toggle either.

### About the API key

usermods ships no credentials of any kind. The user chooses a provider and supplies their own key,
which is stored in `chrome.storage.local` on their device and sent only to that provider's
endpoint as an `Authorization` header on their own requests. It is never sent to the developer, who
operates no server.

The key supplied to the reviewer is for an **OpenAI-compatible** endpoint, not a named vendor, so
the preset to pick is **"Custom OpenAI API"** — the second of the two buttons on the bottom row of
the Presets block.

That preset is a starting point, not a complete configuration. It sets the provider to
*OpenAI-compatible (chat/completions)* and seeds **Base URL** with the stub `http://localhost:`,
leaving **Model** empty; both have to be typed in by hand, over the stub in the case of Base URL.
That is the one place a reviewer could get stuck, which is why the short version spells out all
three values and says explicitly that the preset does not fill them in. The three fields are
labelled exactly **Base URL**, **API key** and **Model**, in that order, and Settings autosaves
about 300 ms after the last keystroke — there is no Save button to look for.

The named presets behave differently and are worth knowing about if a reviewer explores: the
**Anthropic**, **OpenAI**, **xAI Grok** and **OpenRouter** presets each fill in a real base URL and
a default model, so they need only a key. **Ollama** and **LM Studio** point at `localhost` and
need no key, but need a model server running on the reviewer's own machine, so they are not usable
for review.

The reviewer key is **time-limited and expires 2026-10-03**. After that the endpoint returns an
auth error, which would look exactly like a broken extension — hence the line in the pasted notes
telling the reviewer to request a fresh key through the listing's support URL instead. If a review
is still open near that date, re-issue the key and update the notes field in the dashboard.

The two **subscription** presets visible in the screenshots (ChatGPT, SuperGrok) are **not in this
package**. They ship only in the GitHub build. The Chrome Web Store build is compiled with a flag
that removes that code entirely — see `lib/buildflags.ts` — because signing in with a vendor
subscription uses endpoints the vendors do not document for third parties, which does not belong in
a listing that has to state exactly what it talks to. If a preset for one is selected in a profile
carried over from the GitHub build, the store build falls back to the Anthropic provider and says
why.

### What is sent where, during the test above

When the user sends a message with the panel open on a tab, what goes to their configured model
endpoint is: their message, a pruned snapshot of that page's DOM, details of any elements the model
queries, and — only if the model asks for one — a screenshot of the visible tab. That is the whole
list, and the first-run data notice states it before the first message leaves. Nothing else is
transmitted anywhere. Saved mods, chat history, stored `GM_setValue` values and the API key stay in
local extension storage.

### The paths that need no model

Three features are entirely independent of the chat and of any API key, and are worth exercising
because they are what makes this a userscript manager rather than an AI toy:

1. **Install from URL.** The `declarativeNetRequest` rule redirects top-level navigations to
   `.user.js` URLs to the extension's own install page, which previews what the script matches,
   what `GM_*` grants it asks for and what it `@require`s, before anything is saved. The Greasy Fork
   URL in the short version is a real, popular script (GitHub Custom Global Navigation, ~170 KB,
   v1.7.0) chosen because it has both a `@require` library and `GM.*` grants, so the preview shows
   everything it can show.
2. **File import.** Mods tab → import a `.user.js` file from disk.
3. **Tampermonkey migration.** Mods tab → "Migrate from Tampermonkey" → import a Tampermonkey
   backup file, which restores each script with its on/off state and its stored values.

### Remote code

The answer in the form is **No, I am not using remote code**, and that is accurate. No code is
fetched and evaluated for the extension's own use; everything the extension runs is in this
package. Userscripts are user data, not extension code: each one is written by a model at the
user's request or imported by the user, shown in full in a preview, saved only on an explicit click,
and executed only through `chrome.userScripts` in the world its header requests. The extension uses
no `eval`, no `new Function`, no inline handlers and no remotely hosted `<script>` tags, and the
system prompt instructs the model not to write scripts that use `eval` or `new Function`. Scripts'
`@require` and `@resource` dependencies are fetched once at install time, listed in the install
preview, and stored with the mod — not fetched at page load.

### Permissions

Each is justified in its own field on this tab; `docs/store/permissions.md` in the repository is the
source those justifications are pasted from. In brief: `sidePanel` is the entire UI, `storage` holds
the user's mods and settings, `scripting` injects the content script into tabs that predate the
install, `tabs` finds the active tab and captures it for the screenshot tool, `userScripts` is the
core mechanism, `declarativeNetRequest` is the single `.user.js` install redirect, and
`<all_urls>` is required because a userscript manager cannot know in advance which sites its user
will want to change.

### Source

MIT licensed, full history public: https://github.com/kballenegger/usermods

The exact package submitted is built with `npm run zip:store`; `docs/store/package-audit.md`
records its checksum and a file-by-file audit of what is in it.
