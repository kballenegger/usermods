# Notes for reviewers

What goes in the developer dashboard's **Test instructions** form, and the longer explanation to
answer a reviewer's follow-up from.

The form has three fields, and none of them takes a long note:

| Field | Limit | What goes in it |
|---|---|---|
| Username | 100 characters | The reviewer endpoint's base URL (starts with `https://`). |
| Password | 100 characters | The reviewer API key. |
| Additional instructions | 500 characters | The block under [Test instructions](#test-instructions) below, as it is. |

The base URL and the key are **not in this repository** and never go in it. They live in 1Password
(project vault, item "Ornith API - chrome-app-review - 14 days"). The instructions block carries
neither, so it is pasted straight from this file.

**The reviewer key is time-limited.** The one issued for the first submission expires on
2026-10-03. Before resubmitting, issue a new one that outlasts the review (give it a month), put
it in the Password field, and check that the model name in step 4 below is still the one the
endpoint serves. A reviewer who meets an expired key sees an auth error, which looks exactly like a
broken extension.

`npm run reviewer-walkthrough` follows these instructions against the store build: a fresh profile,
the toggle turned on through `chrome://extensions`, the buttons found by the words below, a script
really run on the page, the mod saved and applied again after a reload. Run it after any change to
the panel's wording. `node scripts/listing-check.mjs` checks the block is within 500 characters.

---

## Test instructions

```
Username = API base URL, Password = API key (test AI model; no login).
1. chrome://extensions > usermods > Details > turn on "Allow User Scripts".
2. Open en.wikipedia.org/wiki/Common_kingfisher. Click the usermods icon (puzzle menu), then "I understand".
3. Settings (sliders icon) > Add provider > "Custom OpenAI API". Replace all of Base URL with Username; API key = Password.
4. Chat > "Pick a model" > type ornith, Enter.
5. Send: hide the table of contents. Click "Save & enable", reload.
```

---

## Long version: reference, and for answering follow-up questions

### What the extension is

usermods is a user script manager in the same category as Tampermonkey, Violentmonkey and
Greasemonkey: it stores userscripts with standard `==UserScript==` headers and registers them
through `chrome.userScripts` so they run on the pages their `@match` patterns cover. What
distinguishes it is how a script gets written: the user describes the change they want to a
language model they connect, and the model writes the script by inspecting the real page, rather
than the user typing the JavaScript themselves.

### Why "Allow User Scripts" is required

Since Chrome 138 the `chrome.userScripts` API is gated behind a per-extension **Allow User
Scripts** toggle (before that, behind Developer mode). Chrome requires this of every user script
manager; it is not specific to usermods and the extension cannot turn it on for the user. Until it
is on, `chrome.userScripts` is undefined, and the extension shows a banner with the three steps
in the side panel and the dashboard. The side panel's banner goes away by itself within a couple of
seconds of the toggle being turned on, and the extension works from that moment: no reload of the
extension or restart of the browser is needed. `minimum_chrome_version` is 135 for this reason.

### About the API key

usermods ships no credentials of any kind. The user connects one or more providers and supplies
their own key for each, which is stored in `chrome.storage.local` on their device and sent only to
that provider's endpoint as an `Authorization` header on their own requests. It is never sent to
the developer, who operates no server. Removing a provider deletes its key.

Settings opens on a **Providers** list (empty on a fresh install, with the line "No provider yet")
followed by an **Add provider** row of preset buttons. The key supplied to the reviewer is for an
**OpenAI-compatible** endpoint, not a named vendor, so the preset to click is **"Custom OpenAI
API"**, the last button in the Add provider row. Clicking it adds a provider card and opens it.

The card's first three fields are labelled exactly **Name**, **Base URL** and **API key**. The
preset seeds **Base URL** with the stub `http://localhost:`, which has to be replaced; that is the
one place a reviewer could get stuck. Name and the fields below the key can be left alone. Settings
autosaves as you type, so there is no Save button to look for.

There is no Model field in Settings. The model is chosen in the chat: in the bar above the
conversation is a button that reads **Pick a model** until one is chosen (or **No provider
connected** before a provider is added). Clicking it opens a list of the connected provider's
models with a text field on top; typing `ornith` and pressing Enter selects that model whether or
not the endpoint lists its models, because a typed id is offered as *Use "ornith" on Custom OpenAI
API* when nothing listed matches. Until a model is picked, **Send** is disabled and a line by the
message box says what is missing, so a reviewer who skips this step sees an instruction rather than
an error.

The named presets behave differently and are worth knowing about if a reviewer explores: the
**Anthropic**, **OpenAI**, **xAI Grok** and **OpenRouter** presets each fill in a real base URL and
offer a default model, so they need only a key. **Ollama** and **LM Studio** point at `localhost`
and need no key, but need a model server running on the reviewer's own machine, so they are not
usable for review. Several providers can be connected at once, and the model can be changed in the
middle of a conversation; none of that is needed for the test above.

Subscription sign-in (ChatGPT, SuperGrok) is **not in this package**. It ships only in the GitHub
build. The Chrome Web Store build is compiled with a flag that removes that code entirely (see
`lib/buildflags.ts`), because signing in with a vendor subscription uses endpoints the vendors do
not document for third parties, which does not belong in a listing that has to state exactly what it
talks to. None of the store screenshots shows it. If a profile carried over from the GitHub build
holds a subscription provider, the store build keeps it in the list marked **Not available in this
build**, leaves it out of the model picker, and says why.

### What the test does, step by step

After step 5's message is sent, the model reads the page, runs a draft of its script on it once
(the table of contents disappears at that point), and posts a **Proposed mod** card with the code
and three controls: **Run once**, **Save & enable** and **Open in draft**. **Save & enable** stores
the script and registers it with `chrome.userScripts`, and the button then reads **Saved ·
enabled**. Reloading the page shows the saved mod applied with nothing else running. To clean up:
**Mods** tab, **Delete** on that mod.

### What is sent where, during the test above

When the user sends a message with the panel open on a tab, what goes to the provider that chat is
using (the one named in the chat bar, and no other) is: their message, a pruned snapshot of that
page's DOM, details of any elements the model queries, the output of a script the model runs on the
page, and, only if the model asks for one, a screenshot of the visible tab. That is the whole list,
and the first-run data notice states it before the first message leaves. Nothing else is
transmitted anywhere. Saved mods, chat history, stored `GM_setValue` values and the API keys stay in
local extension storage.

### The paths that need no model

These features are independent of the chat and of any API key, and are worth exercising because
they are what makes this a userscript manager rather than a chat window:

1. **Install from URL.** The `declarativeNetRequest` rule redirects top-level navigations to
   `.user.js` URLs to the extension's own install page, which previews what the script matches,
   what `GM_*` grants it asks for and what it `@require`s, before anything is saved. A real,
   popular script with both a `@require` library and `GM.*` grants, so the preview shows everything
   it can show:
   `https://update.greasyfork.org/scripts/478687/GitHub%20Custom%20Global%20Navigation.user.js`
2. **File import.** Mods tab → import a `.user.js` file from disk.
3. **Tampermonkey migration.** Mods tab → "Migrate from Tampermonkey" → import a Tampermonkey
   backup file, which restores each script with its on/off state and its stored values.
4. **Updates.** Installed scripts are checked for a newer version at most once a day, from the
   address their own header names. Nothing is installed by a check: an update is shown on the row,
   and installing it means opening a review screen and clicking **Install update**. *Check installed
   mods for updates* in Settings turns the check off.
5. **Export and share.** The Export menu on a mod downloads it, copies it, or opens GitHub's gist
   editor (or Greasy Fork's form) in a new tab with the script filled in, where the user presses
   the site's own save button. usermods holds no credentials for either site and submits nothing
   itself.

### Remote code

The recommended answer in the form is **Yes**, with the justification in
[permissions.md](permissions.md#are-you-using-remote-code): userscripts are JavaScript that is not in
the package, and the User Scripts API is the documented way to run them. No code is fetched and
evaluated for the extension's own use; all of the extension's own logic is in this
package. Userscripts are user data, not extension code: each one is written by a model at the
user's request or brought in by the user (an install from a file or URL is previewed in full first;
a Tampermonkey backup is imported when the user picks the file), and executed only through
`chrome.userScripts` in the world its header requests. During a chat the model's draft is run once
on the page to test it, which the transcript shows; nothing is registered until the user saves it. The extension uses
no `eval`, no `new Function`, no inline handlers and no remotely hosted `<script>` tags, and the
system prompt instructs the model not to write scripts that use `eval` or `new Function`. Scripts'
`@require` and `@resource` dependencies are fetched once at install time, listed in the install
preview, and stored with the mod, not fetched at page load. An update to an installed script is
never applied without the user reviewing it and clicking **Install update**.

### Permissions

Each is justified in its own field on the Privacy practices tab; `docs/store/permissions.md` in the
repository is the source those justifications are pasted from. In brief: `sidePanel` is the UI,
`storage` holds the user's mods and settings, `scripting` injects the content script into tabs that
predate the install and fills GitHub's gist editor when the user shares a mod, `userScripts` is the
core mechanism,
`declarativeNetRequest` is the `.user.js` install redirect and its one exception, and `<all_urls>`
is required because a userscript manager cannot know in advance which sites its user will want to
change. `tabs` is not requested: host access already covers everything it was used for.

### Source

MIT licensed, full history public: https://github.com/kballenegger/usermods

The exact package submitted is built with `npm run zip:store`; `docs/store/package-audit.md`
records its checksum and an audit of what is in it.
