# Chrome Web Store review notes: permissions, single purpose, remote code

Answers for the **Privacy practices** tab of the developer dashboard. Each justification names the
user-facing feature that needs the permission and the file in the source tree that uses it. Source:
<https://github.com/kballenegger/usermods>.

**Every fenced block below is the text to paste, and each is under the dashboard's 1,000-character
limit** for that field (the remote-code field's limit is not documented; its block is held to the
same 1,000). `node scripts/listing-check.mjs` checks the lengths. Checked against the code
at 0.1.1 on 2026-09-30; the notes under a block say what changed since 0.1.0 and are not pasted.

---

## Single purpose

```
usermods is a userscript manager. Its single purpose is to create, install and run userscripts that customize the websites the user visits. Everything in the extension serves that one purpose: the side-panel chat writes a userscript by inspecting the page the user is on, the Mods view installs, updates, exports and manages userscripts, and the background worker registers the enabled ones so they run on matching pages. It differs from an ordinary userscript manager only in how a script gets written: by describing the change you want to a language model you configure, instead of typing the JavaScript yourself.
```

---

## Permission justifications

### `sidePanel`

```
The user interface of usermods is a side panel: the chat where you describe the change you want, the list of your saved mods, and Settings. The panel opens when the user clicks the toolbar icon. Used in entrypoints/background.ts (chrome.sidePanel.setPanelBehavior, setOptions, open) and declared for entrypoints/sidepanel/.
```

### `storage`

```
usermods stores the user's saved userscripts, their enabled state, the values those scripts write through GM_setValue, the chat history, and the user's own provider settings and API keys. All of it is local to the device; none of it is transmitted to the developer. Without this permission the user would lose every mod they saved whenever the service worker slept. Used throughout, principally in lib/mods.ts, lib/chats.ts, lib/settings.ts, lib/connections.ts, lib/gm.ts and lib/consent.ts.
```

### `scripting`

```
Two uses, both started by the user. (1) usermods reads the structure of the page the user is looking at so the model can write a script that targets the right elements. Its content script is normally injected declaratively, but a tab that was already open when usermods was installed or updated has no content script in it, so chrome.scripting.executeScript injects the packaged content script once, on demand, instead of asking the user to reload the tab (sendToContent in entrypoints/background.ts). (2) When the user chooses "Share as Gist", usermods opens GitHub's own gist editor in a new tab and runs one packaged function there to put the script's text into the editor; the user then presses GitHub's save button themselves (lib/sharecontroller.ts, lib/sharefill.ts). Only code shipped in the package is ever injected this way.
```

The second use is new in 0.1.1.

### `userScripts`

```
This is the core permission of the extension. usermods is a user script manager: saved mods are registered with chrome.userScripts.register so they run on the pages their @match headers cover, and a draft is run once with chrome.userScripts.execute so the user can try it before saving. chrome.userScripts.configureWorld enables messaging so the GM_* API (GM_setValue, GM_xmlhttpRequest and the rest) can reach the background worker. The userScripts API is the mechanism Chrome documents for precisely this category of extension. Used in lib/exec/adapter.ts and lib/gm.ts, driven from entrypoints/background.ts (syncRegistrations, executeInTab).
```

### `declarativeNetRequest`

```
usermods registers two dynamic rules and nothing else. The first redirects top-level navigations to URLs ending in .user.js to the extension's own install page. This is the behaviour users expect from a userscript manager: clicking an install link should show a preview of what the script matches, what GM_* permissions it asks for and what it loads, rather than a wall of raw JavaScript. The second is an "allow" rule that exempts a code host's HTML page about such a file (a GitHub or GitLab "blob" page) from the first rule, so that page loads normally. Both apply only to main_frame requests; nothing is blocked, no headers are modified, and no other traffic is observed. Used in entrypoints/background.ts (installUserJsRedirect).
```

0.1.0 had the redirect rule only, and the old text called it a "static" rule; both are dynamic
rules registered with `updateDynamicRules`.

### Host permissions: `<all_urls>`

```
A userscript manager cannot know in advance which sites its user will want to change, so it needs access to whatever site they are on. It is used to: (1) read the page being customized: while the side panel is open the content script returns a pruned copy of the DOM, matching elements and computed styles so the model can target the right element, and runs the element picker; (2) know the address and title of the active tab, to show the current site in the panel and choose a @match pattern for a new mod; (3) run the user's saved mods, each only on the sites its own @match header names; (4) capture the visible tab when the model asks for a screenshot; (5) reach the model endpoint the user connected, which may be any host including localhost; (6) fetch a userscript the user installs from a URL, and check the update address an installed script names. Page content is sent only to the model provider the user picked. Nothing is sent to the developer, who operates no server.
```

Shortened from the 0.1.0 text, which ran past 1,000 characters and had to be cut by hand in the
dashboard. Item (2) is here because 0.1.1 no longer asks for the `tabs` permission: see below. Item
(6) is new: installs from a URL were always there but unstated, and the daily update check arrives
in 0.1.1.

The content script also shows the install banner: on a page that is itself a userscript (a gist, a
GitHub file page, a plain-text `.user.js`, or a Greasy Fork or OpenUserJS script page with an update
available) it offers to open the install preview. It reads only that page and makes no request
(`lib/banner.ts`).

### `tabs`: no longer requested

0.1.0 asked for `tabs` and justified it by listing `tabs.query`, `tabs.get`, `captureVisibleTab` and
`tabs.create`. None of those needs the permission. `tabs` does not gate the tabs API; it only adds
the address and title of tabs the extension has no host access to, and with `<all_urls>` that is
browser pages and the extension's own pages. Chrome's review rejects an unnecessary permission
(violation *Purple Potassium*), and that justification made the case against itself. 0.1.1 drops
it. The dashboard will show one field fewer.

---

## Are you using remote code?

**Yes**, with the justification below (decided 2026-09-30). 0.1.0 answered No, on the reasoning
that a userscript is the user's data and not the extension's code.

Why the answer changed: the dashboard defines remote code as any JavaScript that is not in the
extension's package, and a userscript is exactly that, whoever it belongs to. usermods goes further
than an ordinary manager, because the model's draft is run on the page during the chat, before the
user has saved anything. A reviewer who watches that happen under an answer of "No" has grounds to
call the answer false. The Manifest V3 policy allows this in so many words ("execution of logic from
a remote source is permissible only when accomplished through a documented API", naming the User
Scripts API), so the defensible position is to say Yes and point at that. Answering No also
disables the justification field, so the explanation would never be read. The cost of Yes is a
slower review.

```
Yes, and only through the User Scripts API, which the Manifest V3 policy names for this purpose. usermods is a user script manager: the code it runs is the user's userscripts, never logic of its own. A userscript is written by the language model the user connected, at the user's request, or installed by the user from a file, a URL or a Tampermonkey backup. During a chat the model's draft is run once on the current tab with chrome.userScripts.execute so it can check its work; the run is shown in the transcript. Nothing is registered until the user saves it, and saved scripts run only through chrome.userScripts.register on the sites their @match header names. All of the extension's own logic is in the package: no eval, no new Function, no remotely hosted script tags, no remote configuration. A script's @require libraries are downloaded once at install and stored with it, and an update to an installed script is applied only after the user reviews it.
```

The detail behind each sentence, for a reviewer's follow-up:

- **Userscripts are user data, not extension code.** A mod is either written by a model at the
  user's request, or brought in by the user. An install from a file or a URL shows the full source in
  a preview and is stored only on **Install**; a Tampermonkey backup is imported when the user picks
  that file, with each script's on/off state as it was. Either way the user can read, disable,
  export or delete it afterwards.
- **The model's draft runs before it is saved.** That is the product: the model tests its script on
  the page (`run_script`, through `chrome.userScripts.execute` in the USER_SCRIPT world) and the
  transcript shows each run. A draft is not registered to run again until the user clicks **Save &
  enable**.
- **They execute only through `chrome.userScripts`**, in the world and at the run-at their header
  requests: `chrome.userScripts.register` for saved mods and `chrome.userScripts.execute` for a
  one-off run.
- **usermods never uses `eval`, `new Function`, inline event handlers or remotely hosted
  `<script>` tags** to run a script, and never fetches code for its own use. The system prompt also
  instructs the model not to write scripts that use `eval` or `new Function` (`lib/agent/prompt.ts`).
- **The one packaged function injected into a page's own world** is the gist editor fill
  (`lib/sharefill.ts`): it sets the editor's text and evaluates nothing.
- **`@require` and `@resource` dependencies** named in an imported script's header are downloaded
  once at install time, listed in the install preview, and stored with the mod. They are not fetched
  at page-load time.
- **An update is never installed by the extension on its own.** The daily check only learns that a
  newer version exists. The user opens a review screen showing the old and new versions and what
  changed in the script's permissions, and clicks **Install update** before anything is replaced.

---

## Data usage

See [docs/store/listing.md](listing.md) for the completed data-disclosure answers, and
[PRIVACY.md](../../PRIVACY.md) for the published privacy policy, which carries the Limited Use
affirmation.
