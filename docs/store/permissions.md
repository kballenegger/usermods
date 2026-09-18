# Chrome Web Store review notes: permissions, single purpose, remote code

Answers for the **Privacy practices** tab of the developer dashboard. Each justification names the
user-facing feature that needs the permission and the file in the source tree that uses it. Source:
<https://github.com/kballenegger/usermods>.

---

## Single purpose

> usermods is a userscript manager. Its single purpose is to create, install and run userscripts
> that customize the websites the user visits. Everything in the extension serves that one purpose:
> the side-panel chat writes a userscript by inspecting the page the user is on, the Mods view
> installs and manages userscripts from files and from sites like Greasy Fork, and the background
> worker registers the enabled ones so they run on matching pages. It differs from an ordinary
> userscript manager only in how a script gets written — by describing the change you want to a
> language model you configure, instead of typing the JavaScript yourself.

---

## Permission justifications

### `sidePanel`

The entire user interface of usermods is a side panel: the chat where you describe the change you
want, the list of your saved mods, and Settings. The panel opens when the user clicks the toolbar
icon. Used in `entrypoints/background.ts` (`chrome.sidePanel.setPanelBehavior`) and declared for
`entrypoints/sidepanel/`.

### `storage`

usermods stores the user's saved userscripts, their enabled state, the values those scripts write
through `GM_setValue`, the chat history, and the user's own provider settings and API key. All of it
is local to the device; none of it is transmitted to the developer. Without this permission the user
would lose every mod they saved whenever the service worker slept. Used throughout, principally in
`lib/mods.ts`, `lib/chats.ts`, `lib/settings.ts`, `lib/gm.ts` and `lib/consent.ts`.

### `scripting`

usermods reads the structure of the page the user is looking at so the model can write a script that
targets the right elements. Its content script is normally injected declaratively, but a tab that
was already open when usermods was installed or updated has no content script in it. In that case
`chrome.scripting.executeScript` injects it once, on demand, so that the page-inspection features
work without asking the user to reload the tab. Used in `entrypoints/background.ts`
(`sendToContent`).

### `tabs`

The side panel is a separate document from the page being modified, so usermods must know which tab
the user is actually looking at in order to act on it. It uses `chrome.tabs.query` to find the
active tab, `chrome.tabs.onActivated`/`onUpdated` to follow the user as they switch tabs, and
`chrome.tabs.get` to read that tab's address and title — which the chat needs both to show the
current site in the panel header and to choose a sensible `@match` pattern for a new mod. It also
uses `chrome.tabs.captureVisibleTab` for the screenshot tool described below, and
`chrome.tabs.create` to open a vendor's sign-in page and to implement `GM_openInTab` for userscripts
that call it. Used in `entrypoints/sidepanel/App.tsx` and `entrypoints/background.ts`.

### `userScripts`

This is the core permission of the extension. usermods is a user script manager: saved mods are
registered with `chrome.userScripts.register` so they run on the pages their `@match` headers cover,
and a draft is run once with `chrome.userScripts.execute` so the user can try it before saving.
`chrome.userScripts.configureWorld` enables messaging so the `GM_*` API (`GM_setValue`,
`GM_xmlhttpRequest` and the rest) can reach the background worker. The `userScripts` API is the
mechanism Chrome documents for precisely this category of extension. Used in
`entrypoints/background.ts` (`syncRegistrations`, `executeInTab`) and `lib/gm.ts`.

### `declarativeNetRequest`

usermods registers exactly one static redirect rule, which sends top-level navigations to URLs
ending in `.user.js` to the extension's own install page. This is the behaviour users expect from a
userscript manager: clicking an install link on Greasy Fork should show a preview of what the script
matches, what `GM_*` permissions it asks for and what it loads, rather than a wall of raw
JavaScript. The rule redirects only `main_frame` requests for `.user.js` URLs; it blocks nothing,
modifies no headers, and observes no other traffic. Used in `entrypoints/background.ts`
(`installUserJsRedirect`).

### Host permissions: `<all_urls>`

A userscript manager cannot know in advance which sites its user will want to change, so it needs
access to whatever site they are on. `<all_urls>` is used for three things, each tied to a feature on
the listing:

1. **Reading the page you are customizing.** While the side panel is open, the content script
   returns a pruned copy of the DOM, lists elements matching a selector, and reports computed styles
   (`entrypoints/content.ts`, `lib/snapshot.ts`), so the model can write a script that targets the
   right element. It also implements the element picker.
2. **Running the user's saved mods.** Each mod runs only on the sites its own `@match` header names,
   but those sites are chosen by the user at save time and could be any site on the web, so the
   extension itself must hold broad host access (`entrypoints/background.ts`).
3. **Taking a screenshot of the visible tab** when the model asks for one, so it can check a visual
   result (`chrome.tabs.captureVisibleTab` in `entrypoints/background.ts`), and reaching the model
   endpoint the user configured, which may be any host including `localhost`
   (`lib/providers/`).

No narrower set of hosts would work: restricting usermods to a fixed list of sites would mean it
could not customize the site a given user cares about. Page content is read only while the user is
using the panel on that tab, and is sent only to the model endpoint that user configured. It is
never sent to the developer, who operates no server.

---

## Are you using remote code?

**No.** Select *No, I am not using remote code.*

The extension ships with all of its own executable code in the package; nothing in the extension
itself is fetched and evaluated at runtime, as Manifest V3 requires.

The following is worth stating explicitly, because usermods is a userscript manager and a reviewer
will reasonably ask about it:

- **Userscripts are user data, not extension code.** A mod is either written by a model at the
  user's request, or imported by the user from a file, a URL or a Tampermonkey backup. In every case
  the user sees the full source in a preview screen and clicks **Save** before it is stored, and can
  read, disable, export or delete it afterwards.
- **They execute only through `chrome.userScripts`**, the API Chrome documents for user script
  managers, in the world and at the run-at their header requests — `chrome.userScripts.register` for
  saved mods and `chrome.userScripts.execute` for a one-off test run.
- **usermods never uses `eval`, `new Function`, inline event handlers or remotely hosted
  `<script>` tags** to run a script, and never fetches code for its own use. The system prompt also
  instructs the model not to write scripts that use `eval` or `new Function` (`lib/agent/prompt.ts`).
- **`@require` and `@resource` dependencies** named in an imported script's header are downloaded
  once at install time, listed in the install preview, and stored with the mod. They are not fetched
  at page-load time.

---

## Data usage

See [docs/store/listing.md](listing.md) for the completed data-disclosure answers, and
[PRIVACY.md](../../PRIVACY.md) for the published privacy policy, which carries the Limited Use
affirmation.
