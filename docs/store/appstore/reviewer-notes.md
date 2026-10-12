# Notes for App Review: iPhone and iPad

What goes in the **App Review Information** section of the iOS version in App Store Connect
(record 6820909625), and the longer explanation to answer a reviewer's follow-up from. The Chrome Web
Store equivalent is [../reviewer-notes.md](../reviewer-notes.md); this file follows it.

**The build under review is the full Safari build** (`npm run build:safari`), with the ChatGPT and
SuperGrok subscription sign-ins in it, as Kenneth decided on 2026-10-09. The notes therefore address
the sign-ins directly (guidelines 3.1.1 and 3.1.3) and the running of user scripts (guideline
2.5.2), rather than waiting to be asked.

## The fields

| Field | Value |
|---|---|
| Sign-in required | **No.** usermods has no account of its own and no server, so there is nothing to sign in to. The AI feature needs a model endpoint and key, which are given in the Notes, not in the sign-in fields: they are not a username and password for usermods, and putting them there would tell the reviewer the app has a login it does not have. |
| User name / Password | Leave empty (unchecked "Sign-in required" hides them). Demo account: **not applicable**, for the same reason. |
| Contact: first name, last name | `<CONTACT FIRST NAME>` `<CONTACT LAST NAME>` |
| Contact: phone | `<CONTACT PHONE>` |
| Contact: email | `<CONTACT EMAIL>`. Use the address whose mailbox someone reads during the review: a rejection or a question arrives there, and the Chrome rejection sat unread for eight days. |
| Notes | The block under [Notes](#notes) below, with the three placeholders filled in at paste time. 4,000-character limit. |
| Attachment | Optional, and worth adding: a screen recording of steps 1 to 8 on an iPhone, under a minute. An extension that lives inside Safari is the kind of app a reviewer fails to find; a video removes the doubt. |

**The endpoint and key are not in this repository** and never go in it. They live in 1Password, in
the project vault. The Chrome review key ("Ornith API - chrome-app-review") expires on
**2026-10-17**, and an App Review can take longer than that once a question or a resubmission is
involved, so **issue a separate key for App Review** with at least 30 days on it, store it in
1Password as its own item, and paste its values into the Notes. A reviewer who meets an expired key
sees an authentication error inside the chat, which looks exactly like a broken app and is a
rejection under guideline 2.1.

The block below holds the placeholders `<BASE_URL>` and `<API_KEY>` in place of those values.
Replace both, and nothing else, when pasting. The model id `ornith` is not a secret and is filled in.

---

## Notes

```
usermods is a Safari web extension for iPhone and iPad: a userscript manager where the user describes a change to a web page and an AI model of their choosing writes the userscript. The app itself is one screen of setup steps; everything happens inside Safari.
No account or sign-in is needed. To test the AI feature, use this test endpoint (OpenAI-compatible):
Base URL: <BASE_URL>
API key: <API_KEY>
Model: ornith

ENABLE THE EXTENSION
1. Open the usermods app once. It shows these steps.
2. Settings > Apps > Safari > Extensions > usermods: turn it on, and set All Websites to Allow. (iOS 17 and earlier: Settings > Safari > Extensions.)

TEST (about 3 minutes)
3. In Safari, open en.wikipedia.org/wiki/Common_kingfisher
4. Tap the page menu button in Safari's address bar, then usermods. A sheet opens over the page. Tap "I understand" on the data notice.
5. Tap Menu (top right) > Settings. Under "Add provider", tap "Custom OpenAI API". In the card that opens, replace ALL of Base URL (it starts as http://localhost:) with the Base URL above, and paste the API key into "API key". Settings save as you type.
6. Tap "‹ Chat". Tap the model chip in the top bar (it reads "No model"), type ornith, and tap Use "ornith" on Custom OpenAI API.
7. Type: hide the table of contents, and tap Send. The model reads the page and tests a script on it (the contents box disappears), then shows a proposed mod with its code.
8. Tap "Save & enable". Close the sheet and reload the page: the saved script hides the contents box again.

SUBSCRIPTION SIGN-IN (optional; not needed for the test)
Settings also lists "ChatGPT subscription" and "SuperGrok subscription". They let a person who already pays that provider use their plan instead of an API key. The sign-in is the provider's own device-code flow: usermods shows a short code and opens the provider's page in Safari, the person approves it there, and the provider's token is stored only on the device and sent only to that provider.
usermods sells nothing. There is no purchase, price, upgrade, subscription offer or link to a purchase page anywhere in the app. Nothing is locked: every feature works the same with the user's own API key or a model server they run. The subscription is bought from the provider, outside the app and not for it, and the developer receives nothing from it, so no in-app purchase rule is engaged (3.1.1, 3.1.3).

USER SCRIPTS (2.5.2)
Userscripts are user data, run on web pages inside Safari, never in the app. All of the app's and the extension's own code is in the submitted binary; nothing is downloaded or executed to add or change their features.
A userscript is either written by the model at the user's request (the user sees the code and must tap Save) or installed by the user from a link or file after a preview of what it does. It runs in Safari's web-extension sandbox through the extension's own bundled content script, only on the sites its header names and the user allowed. It changes how a web page looks for that user, as a content blocker does; it cannot change the native app, call native APIs or reach other apps. Updates to a script are never automatic.
Same category as the userscript managers already on the App Store, such as Userscripts and Stay.

WHAT IS SENT WHERE
Only when the user sends a message, only to the provider that chat uses: the message, the page's address and title, a pruned copy of the page's text and structure (form field values are never sent), details of elements the model looks up, what its test scripts return, attached images, and a screenshot of the page if the model asks for one. The notice in step 4 lists this before anything is sent. Keys, saved scripts and chats stay on the device. Nothing is sent to the developer, who runs no server; no analytics, no tracking.

Source (MIT): https://github.com/kballenegger/usermods
```

3,855 of 4,000 characters **with the placeholders in**. Filling in `<BASE_URL>` (10 characters) and
`<API_KEY>` (9) with the real values adds their length less 19, so the real base URL and key
together must stay under about 160 characters. Re-count after pasting if the key is unusually long:
App Store Connect refuses a Notes field over 4,000 rather than truncating it.

The `‹` in step 6 is the character the button really shows, so the reviewer can match it by eye.
Every quoted label in the steps (`I understand`, `Add provider`, `Custom OpenAI API`, `No model`,
`Use "ornith" on Custom OpenAI API`, `Save & enable`) was checked against the source: `Consent.tsx`,
`ProvidersSection.tsx`, `lib/connections.ts`, `Chat.tsx`, `ModelPicker.tsx` and `lib/artifact.ts`.
If any of those strings changes, change the step.

---

## Long version: reference, and for answering follow-up questions

### What the app is

The iOS app is a host for a Safari web extension, the arrangement Apple requires for one. The app
target (`safari/App/ViewController.swift`) is a single screen that says where the switch is,
because no app can deep link into the Safari extension settings on iOS. All of usermods' function is
in the extension, and on iPhone its UI is the toolbar popup, which Safari shows as a sheet over the
page; on iPad it is a 440 × 660 popover. There is no side panel on Safari. See
[../../safari.md](../../safari.md) for the port.

The extension is a userscript manager in the same category as the Safari userscript managers already
on the App Store: it stores userscripts with standard `==UserScript==` headers and runs them on the
pages their `@match` patterns cover. What is different is how a script gets written: the user
describes the change to a language model they connect, and the model writes the script by inspecting
the real page.

### Enabling, and what a reviewer sees if a step is skipped

- **Extension not turned on:** usermods does not appear in Safari's page menu at all. The app screen
  repeats the path. On iOS 18 and later it is Settings > Apps > Safari > Extensions; on iOS 17 and
  earlier, Settings > Safari > Extensions. The deployment target is iOS 16.4.
- **Turned on, but no site access:** `<all_urls>` is a request on Safari, not a grant. With All
  Websites left at Ask, Safari prompts per site when the popup opens, and a mod matches only the
  sites the user has allowed. That is why step 2 sets All Websites to Allow.
- **The page menu button** is the icon at the leading edge of Safari's address bar on iOS 17 and
  18; its look has changed between iOS versions, which is why the Notes call it by its name rather
  than describing the glyph.

### About the provider and the key

usermods ships no credentials. The user connects one or more providers in Settings. Settings opens on
a **Providers** list ("No provider yet" on a fresh install) followed by an **Add provider** row of
presets: the key presets (Anthropic, OpenAI, xAI Grok, OpenRouter, Ollama, LM Studio), then the two
subscription presets, then **Custom Anthropic API** and **Custom OpenAI API** (`presetsFor()` in
`lib/connections.ts`). The reviewer key is for an OpenAI-compatible endpoint, so the preset is
**Custom OpenAI API**, the last button.

Its card's first fields are **Name**, **Base URL** and **API key**. Base URL is seeded with the stub
`http://localhost:`, which must be replaced entirely; this is the one place a reviewer can get stuck,
which is why the Notes put "ALL" in capitals. Settings autosaves. There is no Model field in
Settings: the model is picked from the chip in the chat's top bar, which reads **No model** until
one is chosen. Its sheet has a filter field; typing a model id offers *Use "ornith" on Custom OpenAI
API* whether or not the endpoint lists its models.

`localhost` on a phone is the phone. The Ollama and LM Studio presets point there and are unusable
on iOS unless the user changes them to a computer's address on their network; the provider card and
the app screen both say so. They are not needed for review.

### What the test does

After step 7 the model reads the page, runs a draft of its script on that open page once to test it
(the table of contents disappears at that point, and the transcript shows the step), and posts a
**proposed mod** card with the code, **Run once** and **Save & enable**. On iPhone a draft pill above
the message box offers the same save. **Save & enable** stores the script; the button then reads
**Saved · enabled**. Reloading the page shows the saved mod applied by the extension's content
script, with no chat running. To clean up: Menu > Mods, open the mod's actions, **Delete**.

### Subscription sign-in: how it works

Present in this build because it is the full Safari build. The Chrome Web Store build and
`build:safari:store` compile it out (`SUBSCRIPTIONS_OFF` in `lib/buildflags.ts`).

- Two presets, **ChatGPT subscription** and **SuperGrok subscription**, each limited to one
  connection. The card shows **Sign in with ChatGPT** / **Sign in with SuperGrok**.
- Both use the OAuth 2.0 **device authorization grant** (RFC 8628) with the vendor's public client
  id, the same one the vendors' own command-line tools use (`lib/oauth.ts`). `startXaiLogin` /
  `startChatgptLogin` ask the vendor for a device code and a short user code. No redirect URL, no
  embedded web view, no password ever typed into usermods.
- The record needed to resume (device code, user code, verification address, interval, expiry) is
  written to `chrome.storage.local` before the user is sent anywhere (`lib/pendinglogin.ts`),
  because on iOS opening the vendor's page in a new tab dismisses the popup and Safari suspends the
  background within seconds. Reopening the popup shows the same code, **Open … page**, **Copy
  code** and **Cancel**.
- The user approves on the vendor's own website, signed in to their own account there. The popup (or
  the background, when it wakes) polls the vendor's token endpoint at the vendor's own interval,
  one step at a time, until it is approved, denied or expires.
- The resulting access and refresh tokens are stored in `chrome.storage.local` under `oauth:<vendor>`
  and sent only to that vendor, as the authorization header of the user's own requests, refreshed
  automatically. **Sign out** deletes them.
- The account label shown ("Signed in to ChatGPT as …") is read out of the vendor's token on the
  device. Nothing about the account is sent anywhere else.

A reviewer cannot exercise this without a paid subscription of their own, and does not need to: the
Notes say it is optional. If App Review asks to see it, answer with a screen recording of Kenneth
signing in on his own device, rather than sharing an account.

### Subscription sign-in: the guideline position

The argument, in the order a reviewer is likely to press it:

1. **3.1.1 (in-app purchase) is not engaged.** It applies when an app unlocks features or
   functionality with payment. Nothing in usermods is unlocked by anything: every feature is
   present and works with the user's own API key or with a model server they run, at no cost from
   usermods. The developer sells nothing, takes no commission, and has no account system that could
   hold an entitlement.
2. **3.1.3 (other purchase methods): no call to action.** There is no price, purchase button,
   upgrade prompt, subscription offer, or link to a purchase page anywhere in the app, the
   extension or the metadata. The subscription sentence in the description says the person
   *already* has one. The sign-in card's only links are to the vendor's sign-in page for the
   device code.
3. **3.1.3(b) (multiplatform services).** Kenneth's brief names it, and it is the right family of
   rule, but read it carefully before quoting it at a reviewer: it lets an app give access to
   content or subscriptions *acquired elsewhere*, and it expects those items to also be offered as
   in-app purchases. That parity clause is written for a developer selling its own subscription on
   several platforms. usermods sells no subscription anywhere, so there is nothing to offer as an
   in-app purchase; the subscription belongs to a third party the user chose, the way a mail
   client lets you sign in to the mail account you already pay for. The Notes therefore cite 3.1.1
   and 3.1.3 and do not lean on 3.1.3(b); use this paragraph if a reviewer raises it.
4. **5.2.2 (third-party services) is the real exposure, and it is not in the Notes.** It requires
   that an app using a third-party service be permitted to under that service's terms. The comment
   at the top of `lib/buildflags.ts` says it plainly: the subscription endpoints are ones the
   vendors do not document or license for third parties; usermods uses the same public device-code
   clients the vendors' own CLIs and several open-source agents use. If a reviewer cites 5.2.2, or
   asks for authorization from either vendor, there is no document to show. Kenneth accepted the
   3.1.3 / 2.5.2 risk on 2026-10-09; this one was not named then and is worth his decision before
   submitting.

**The fallback, if App Review rejects over the sign-in:** stage the App Store variant
(`node scripts/safari-xcode.mjs stage --store`, which builds `build:safari:store`), rebuild, and
resubmit. That build has no subscription code at all, and a profile that held a subscription shows it
as unavailable with a message naming the App Store build (`unavailableProviderMessage`). Remove the
subscription sentence from the description and the SUBSCRIPTION SIGN-IN section from the Notes at
the same time.

### User scripts and guideline 2.5.2

2.5.2 says an app may not download, install or execute code that introduces or changes features or
functionality of the app. The position:

- **The app's own code is all in the binary.** The native app is one static screen. The extension's
  JavaScript (popup, background, content scripts) is bundled at build time from this repository and
  signed into the `.appex`; nothing is fetched and evaluated for the app's or the extension's own
  use, and there is no remote configuration.
- **Userscripts are user data that act on web pages, not on the app.** Safari has no `userScripts`
  API, so the extension runs them itself: one declared content script
  (`entrypoints/modrunner.content.ts`, `<all_urls>`, `document_start`, all frames) asks the
  background which saved scripts match this document and runs them in the extension's isolated
  world (or, for `@grant none`, in the page). Everything they can do is what a content script in
  Safari's web-extension sandbox can do on a page the user allowed. They cannot touch the native
  app, native APIs, other apps or the file system.
- **The extension's GM API is an allowlist, gated by a capability token** the background mints per
  script per frame (`lib/exec/grants.ts`, `lib/exec/protocol.ts`): a script cannot claim another
  script's identity, storage or network allowlist, and page-world scripts get no token at all.
  See "What the isolation actually is" in [../../safari.md](../../safari.md).
- **Every script is the user's doing.** A model-written script is shown with its code and installed
  only when the user taps Save. During a chat the model does run test scripts on the one open page,
  as part of the request the user just made; each run is a line in the transcript, and nothing runs
  on any later visit until saved. A script installed from a link or file is previewed first (sites,
  grants, `@require` libraries). Updates are offered, never applied without review.
- **Precedent.** Userscript managers are an established App Store category on iOS: *Userscripts*
  (by quoid) and *Stay* are both Safari web extensions that run user-supplied JavaScript on web
  pages. usermods does the same thing; the model is how the script gets written, not a different
  kind of execution.
- **`@require` and `@resource`** files a script names are downloaded once, at install, listed in the
  preview, and stored with the script. They are part of that userscript, run on web pages under the
  same rules, and are never loaded into the app.

### What is sent where

Matches [PRIVACY.md](../../../PRIVACY.md) section 2 and the first-run notice
(`entrypoints/sidepanel/Consent.tsx`). When the user sends a message, the one provider that chat uses
receives: the conversation, the page's address and title, a pruned copy of the page's HTML or its
readable text (scripts, styles, hidden elements and all form field values removed), details of
elements the model queries or the user points at, the output of test scripts it runs, attached
images (downscaled, EXIF stripped), and a screenshot of the visible tab only if the model asks.
Nothing goes anywhere else. Keys, tokens, saved scripts, their stored values and chats stay in the
extension's local storage.

Other requests, each started by the user except the update check: listing a provider's models;
fetching a userscript the user installs, and its `@require` files; the daily update check against
the address an installed script's own header names (no cookies); and the subscription sign-in above.

**The privacy label is "Data Not Collected"**, and if asked: Apple's definition of collecting is
transmitting data off the device in a way that the developer or its third-party partners can access
it. Nothing reaches the developer, who has no server. The model provider is not the developer's
partner; it is a service the user chose, configured with the user's own credentials, and receives
data only at the user's direction to perform the user's request.

### The paths that need no model

Worth naming if a reviewer wants to see the app do something without the test key:

1. **Install from a link.** Open a `.user.js` address in Safari and the extension's install page
   previews what the script matches, what grants it asks for and what it loads, before anything is
   saved. A real script with both a `@require` and `GM.*` grants:
   `https://update.greasyfork.org/scripts/478687/GitHub%20Custom%20Global%20Navigation.user.js`.
   On Safari the redirect is done by watching navigations rather than by a network rule, so the raw
   script text can show for a moment before the install page replaces it (see Limitations in
   [../../safari.md](../../safari.md)). That is expected.
2. **Import a file:** Mods, import a `.user.js` from Files.
3. **Tampermonkey migration:** Mods, Migrate from Tampermonkey, pick a backup file.
4. **Updates:** checked at most once a day per script; nothing installs without **Install update**.
5. **Export and share:** download, copy, or open GitHub's gist editor in a tab with the script filled
   in, where the user presses GitHub's own save button. usermods holds no GitHub credentials.

### Before pressing Submit

- [ ] The build uploaded is the **full** variant: `node scripts/safari-xcode.mjs stage` (no
      `--store`). Check on a device that Add provider lists the two subscription presets.
- [ ] The App Store version string matches the build's `CFBundleShortVersionString` (record created
      as 1.0, build is 0.1.1; see [listing.md](listing.md)).
- [ ] `ITSAppUsesNonExemptEncryption` is `false` in both Info.plists (it is in `safari/App/Info.plist`
      and `Info-macOS.plist`), so export compliance answers itself.
- [ ] A reviewer key with at least 30 days left is in 1Password and in the pasted Notes; the Notes
      are under 4,000 characters after pasting.
- [ ] PRIVACY.md's "Two builds" paragraph says the App Store build keeps the sign-in.
- [ ] The contact email in the fields above is one someone is reading.

### Source

MIT licensed, full history public: https://github.com/kballenegger/usermods. The Safari port is
documented in [../../safari.md](../../safari.md) and the API survey behind it in
[../../browsers.md](../../browsers.md).
