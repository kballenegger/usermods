# Using usermods

The long version of everything the [README](../README.md) introduces in a line: the providers you
can connect, how the model and its thinking level are picked in the chat, subscriptions instead of
API keys, editing a mod you already have, importing scripts and migrating from Tampermonkey,
attaching images, sharing a mod as a gist or on Greasy Fork, the install banner, the dashboard, and where the side panel opens.

For what happens underneath — the agent loop, drafts, compaction, storage and the security notes —
see [architecture.md](architecture.md). For the `GM_*` surface a script can count on, see
[gm-api.md](gm-api.md).

- [Providers](#providers)
  - [Choosing the model in the chat](#choosing-the-model-in-the-chat)
  - [How much the model thinks](#how-much-the-model-thinks)
  - [Using a subscription instead of an API key](#using-a-subscription-instead-of-an-api-key)
- [Editing a mod you already have](#editing-a-mod-you-already-have)
- [Importing scripts and migrating from Tampermonkey](#importing-scripts-and-migrating-from-tampermonkey)
  - [Attaching images](#attaching-images)
  - [Screenshots, and models that cannot see them](#screenshots-and-models-that-cannot-see-them)
  - [Migrating from Tampermonkey](#migrating-from-tampermonkey)
- [Updates](#updates)
- [Sharing a mod: Export, a gist, Greasy Fork](#sharing-a-mod-export-a-gist-greasy-fork)
- [The install banner](#the-install-banner)
- [Dashboard](#dashboard)
- [Where the panel opens](#where-the-panel-opens)

## Providers

Two wire protocols, any endpoint:

| Preset | Protocol | Base URL |
|---|---|---|
| Anthropic | Anthropic Messages | `https://api.anthropic.com` |
| OpenAI | OpenAI chat completions | `https://api.openai.com/v1` |
| xAI Grok | OpenAI chat completions | `https://api.x.ai/v1` |
| OpenRouter | OpenAI chat completions | `https://openrouter.ai/api/v1` |
| Ollama, LM Studio, vLLM, mlx_lm | OpenAI chat completions | your local server |
| Custom | either | anything you type |

The base URL is always editable. Anything that speaks one of the two protocols will work, so a self-hosted gateway, a corporate proxy, or a model router all drop in.

A preset is a starting point, not a slot: **Add provider** adds to a list, so you can have Anthropic,
OpenRouter and two different local servers connected at the same time, each with its own name, key,
Images setting and model list. A provider counts as *connected* once it has what it needs — an API
key, a sign-in, or a base URL of your own that needs neither — and its status line says which.
Removing a provider deletes its key from the device.

Upgrading from a build that had a single provider: your provider, base URL, key, model and Images
setting become the first entry in the list, and the chat keeps using the same model. Nothing to redo.

<img src="screenshots/04-settings.png" width="420" alt="Settings showing three connected providers, one opened to its name, base URL, API key and Fetch models, and the Add provider presets below.">

### Choosing the model in the chat

Under the message box is the model this chat is talking to. Open it and you get every model from
every connected provider, grouped by provider, with a filter; **Refresh models** asks the providers
again, and **Manage providers…** goes to Settings. Lists are cached, and refreshed when you open the
picker if they are a day old.

- **It is per chat.** Each chat remembers its model, across reloads and restarts; a new chat starts
  on the last model you picked. The dashboard shows each chat's model.
- **Swap whenever you like.** The next turn goes to the new model with the full conversation —
  tool calls, tool results, images, and any compaction summary — converted for that provider's
  protocol. The transcript marks the spot: *switched to claude-sonnet-5 · Anthropic*. What does not
  travel is another model's private reasoning (OpenAI's encrypted reasoning items): those are only
  ever sent back to the model that wrote them.
- **Swapping during a run** applies from the next turn, and the panel says so; the reply in progress
  finishes on the model it started with. A message queued behind it uses the new one.
- **An endpoint that cannot list its models** (plenty of local servers) still works: type the model
  id into the picker's field and choose *Use "…" on* that provider. It is remembered.
- **If a chat's provider is removed or signed out**, the chat says so above the message box and
  waits for you to pick another model. It never quietly sends your page to a different provider.
- Titles and compaction summaries use the chat's model too. The context budget is one setting for
  every provider, so set it for the smallest context window you use.

### How much the model thinks

In the model dropdown, under the models, is **Thinking**: how hard this chat asks the model to
reason before it answers, mapped onto whatever knob that provider actually has. It shows only the
levels the chosen model accepts, and it is not shown at all for a model that has none. When it is
not Default the chip in the chat bar says so (`claude-opus-5 · high`).

- **Default changes nothing.** Every chat starts there, and a chat left on Default sends exactly
  the request it always did. The other levels are **Off**, **Low**, **Medium**, **High** and
  **Max** — whichever of them the model supports.
- **One scale, each provider's own knob.** On current Claude models it is `output_config.effort`,
  and on older ones a thinking token budget; on ChatGPT and SuperGrok it is `reasoning.effort`; on
  an OpenAI-compatible endpoint it is `reasoning_effort`, or Qwen 3's `enable_thinking`.
- **What a model cannot do is not offered.** SuperGrok cannot stop reasoning, so it has no Off;
  Claude Fable and Mythos always think, so they have no Off either; Grok's `-fast` variants and
  ordinary chat models like `gpt-4o` take no reasoning setting at all, so the row is hidden.
- **It is per chat**, like the model: remembered across reloads, and a new chat starts on the last
  level you picked. Changing it applies from the next turn and the transcript marks the spot
  (*thinking: high*). The dashboard shows it beside the chat's model.
- **Titles and compaction summaries always run at the lowest level the model allows**, whatever the
  chat is set to. They are short mechanical calls you did not ask for, and you pay for them.
- **For a local server that needs something else**, each OpenAI-compatible provider has a
  **Reasoning field** setting in Settings — Auto (guessed from the model name), `reasoning_effort`,
  `chat_template_kwargs: enable_thinking`, or None — and a **Custom request fields** box for extra
  JSON merged into every request. If a server answers 400 to the reasoning field, usermods sends
  that one request again without it, says so, and leaves it out for that model from then on.

### Using a subscription instead of an API key

Two subscriptions can sign in directly from Settings, with no API key and no local process:

| Preset | Plans | How |
|---|---|---|
| ChatGPT subscription | Plus, Pro, Team | "Sign in with ChatGPT" device code. Opens a page, you type a short code, done. |
| SuperGrok subscription | SuperGrok, or X Premium+ on the X account you sign in with | xAI's coding-agent OAuth, same device-code flow. |

Both talk to the vendor's Responses API backend that their own coding agents use. Tokens are stored in extension local storage and refreshed automatically. The model picker lists the model ids your plan allows once you are signed in (the ChatGPT backend is asked the way the open-source Codex CLI asks it). If a listing fails, a short built-in list is offered instead, marked as such, and you can always type a model id.

Caveats worth knowing:

- Neither vendor publishes developer docs for this. The endpoints and headers are the ones their CLIs use, as reused by several open-source agents. OpenAI and xAI have both said third-party tools may use these logins, but that is a statement, not a contract.
- Usage counts against your plan's limits.
- xAI has been seen to reject some standard-tier SuperGrok accounts with a 403 even when the subscription is active.
- Anthropic forbids using a Claude subscription outside its own clients, so there is no Claude sign-in. Anthropic's sanctioned route is the Agent SDK credit, which requires the Claude Code CLI on your machine. If you run a local proxy built on that, point a Custom Anthropic preset at it.

For any other subscription, the same rule applies: run a local proxy that exposes it as an Anthropic- or OpenAI-compatible endpoint and point a Custom preset at it.

**Not in the Chrome Web Store build.** Subscription sign-in ships only in the GitHub build — the one you get from [Install (from source)](../README.md#install-from-source). `npm run build:store` and `npm run zip:store` produce the Web Store variant, which sets a compile-time flag that removes the two subscription presets, their provider options and the sign-in card, and tree-shakes the OAuth module out of the bundle entirely, so that build contacts no vendor auth endpoint. These logins rely on endpoints neither vendor documents or licenses for third parties, which does not fit a listing that has to declare exactly what it talks to. If you install the Web Store build over a profile that was signed in, Settings falls back to the default provider and tells you why; the GitHub build keeps every feature, this one included.

## Editing a mod you already have

A mod is rarely finished the first time. **Edit in chat** opens any installed mod as the draft of a
conversation: the script you have is v1, the model is told it is editing something already installed
rather than writing something new, and **Update mod** writes your changes back over the same mod —
same id, same on/off state, same `GM_setValue` store, no second copy running beside the first.

<img src="screenshots/11-editing.png" width="420" alt="A chat whose draft is an installed mod. Under the draft bar, a line reads Editing Kingfisher Notes, with Save as a new mod instead beside it; the bar's button says Update mod.">

It works on **any** mod, not only the ones chat wrote: one installed from a URL, imported from a
file, or brought across in a Tampermonkey backup, enabled or disabled, page-world or isolated. An
imported script's `==UserScript==` block is kept whole and put back when you save, so its
`@require` libraries, `@grant` lines, `@connect` hosts, `@run-at` and `@version` all survive an edit
the model made without ever seeing them. Only the name, the description and the `@match` lines are
rewritten, because those are the parts the draft owns.

There are three ways in, depending on where you are when you think of it.

**From the mod.** Every row in the Mods tab and in the dashboard has **Edit in chat**. If a chat
already edits that mod, it opens that one — unarchiving it if you had put it away — so you carry on
the conversation that built it rather than starting a new one that has to be told everything again.

**From the chat.** A new chat lists the mods that run on the page you are on as one-tap entries
(*Edit &lt;name&gt;*), and **Edit a mod…** beside the chat switcher opens a picker of everything you
have, page matches first. If the chat you are in has an unsaved draft of its own, picking a mod
opens a *new* chat for it and says so — what you were working on is never quietly replaced.

**From the model.** Each turn tells the model which mods already run on the current URL, enabled and
disabled, with their ids. When you ask for something that belongs with one of them — "also hide the
sidebar", "and the footer too" — it opens that mod and proposes the whole updated script, instead of
writing a second mod that fights the first. When the request is unrelated it makes a new mod, and
when it cannot tell it asks. It will not take over a draft with unsaved changes without saying so
first.

While a chat is editing a mod it says so, under the draft panel and in the chat switcher, and the
dashboard's chat list badges it. **Save as a new mod instead** breaks the link: the next save creates
a separate mod and the original is left installed and running, untouched. And if you save a mod whose
name and match patterns are the same as one you already have, usermods asks whether you meant to
update it or to keep both, rather than leaving two scripts quietly fighting over one page.

## Importing scripts and migrating from Tampermonkey

usermods runs ordinary userscripts, so you can bring in scripts from Greasy Fork, OpenUserJS or your own collection.

**Install from a URL.** Paste a `.user.js` URL into *Install from URL* in the Mods tab and click **Fetch**. You get a preview — name, version, what it matches, which `GM_*` permissions it asks for, the libraries it loads, and the full source — before anything is saved.

**Click a `.user.js` link.** usermods redirects `.user.js` navigations (gist and GitHub raw links included) to its own install page, the way Tampermonkey does, so clicking an install link on Greasy Fork shows the same preview instead of a wall of raw JavaScript. The script's URL travels in the install page's fragment (`install.html#https://…`) and everything after the first `#` is taken verbatim, so a link whose own query string carries another `url=` cannot change which script is previewed. The page shows the exact URL it is about to fetch, and refuses anything that is not `http`/`https`. A GitHub or GitLab *file page* that happens to end in `.user.js` is a web page, not the script, so it is left alone and the [install banner](#the-install-banner) offers the script from it instead.

**Import a file.** *Import file* in the Mods tab takes a `.user.js` file from disk through the same preview.

`@require` libraries and `@resource` files are downloaded at install time and stored with the mod, because registered scripts cannot fetch them later. If one of those downloads fails, the install fails and names the URL. Scripts with a `@downloadURL` get an **Update** button that checks for a newer `@version` now; see [Updates](#updates) — nothing is installed without your review.

<img src="screenshots/05-install.png" width="420" alt="The install page previewing a script fetched from Greasy Fork, with its matches, GM permissions and required library.">

### Attaching images

Paste an image into the composer (a screenshot copied with ⌘⌃⇧4 works), drop one onto the panel, or
use **+ → Attach image**. PNG, JPEG, WebP and GIF are accepted; SVG is refused with a note, because an
SVG is a document rather than a picture and rasterizing one here would mean running it.

Everything happens in the panel before anything leaves it. Each image is decoded, scaled so its
longest edge is at most 1568px — the point past which the vision models downscale anyway — and
re-encoded as JPEG (PNG only when it is small and genuinely uses transparency). Re-encoding is also
what strips EXIF: the pixels are redrawn onto a fresh canvas and no metadata survives, so the GPS
coordinates and device id in a phone screenshot never reach the model. An image still over 1.2 MB
after all that is refused with a note rather than sent; four images fit in one message.

A sent message shows its thumbnails in the bubble — click one for the full-size view, Escape closes
it. Attachments belong to the chat they were composed in: switching chats with a half-written
message and a pending mockup leaves both exactly where you put them.

Attached images go to the provider that chat is using, the same way page content does. The
transcript keeps a small thumbnail so a reopened panel shows it instantly; the full-size copy is
stored once per chat and deleted with the chat. In the history resent to the model, the two most
recent turns keep their images and older ones become `[attached image 1 elided]`, exactly as
screenshots are handled.

### Screenshots, and models that cannot see them

The `screenshot` tool captures the visible part of the tab and hands it to the model as a picture,
so it can check a visual result rather than infer one. Captures go through the same pipeline as an
attachment: brought down to 1568px on the longest edge and re-encoded as JPEG, which on a HiDPI
display is roughly a third of what the raw capture weighs and rather easier to read.

Getting a picture into a `tool` result is a wire-protocol problem, and the answer differs by
backend. The Anthropic API takes an image inside a tool result directly. Chat completions does not —
a `tool` message is text-only — so usermods puts a pointer in the tool output and attaches the image
to the user message immediately after it, which is what the Responses API backends already needed
and what every vision-capable OpenAI-compatible endpoint reads correctly.

That leaves the question the protocol cannot answer: **OpenAI-compatible** is whatever endpoint you
typed in, and plenty of what speaks it has no vision at all. The **Images** setting — one per
OpenAI-compatible provider, in its card in Settings — decides what to do about it:

| | |
|---|---|
| **Auto** (default) | Send images. If the endpoint refuses *specifically because it cannot take a picture*, send that one request again without them, remember this base URL and model, and leave images out from then on. The panel says so once, and the model is told plainly that it will get no pictures here — so it checks results with `get_styles` and `find_elements` instead of taking screenshots that tell it nothing. |
| **Always send** | Send them regardless. A refusal is surfaced as an error rather than worked around, which is what you want if you know the model has vision and something is misconfigured. |
| **Never send** | Do not send them at all, and skip the one refused request it would otherwise take to find out. |

Auto only treats a refusal as a vision problem when the endpoint says so — a bad key, a full context
window or a rejected tool schema all arrive as the same 4xx and none of them mean the model is
blind. The fallback is one immediate re-send, not a retry: a model that will not take pictures will
not take them in four seconds either, so it composes with the ordinary retry policy instead of
competing with it.

### Migrating from Tampermonkey

Chrome extensions cannot read each other's storage, so migration goes through Tampermonkey's own export file:

1. Open the Tampermonkey dashboard (its toolbar icon → **Dashboard**).
2. Go to the **Utilities** tab.
3. Under **File**, click **Export** to save the backup (`.zip` or `.json`).
4. In usermods, open the **Mods** tab, expand **Migrate from Tampermonkey**, and pick that file.

Both export shapes work: the JSON document (an object with a `scripts` array) and the ZIP (one `.user.js` per script plus its `.options.json` and `.storage.json` sidecars, or the older JSON-in-`.txt` entries). Each script comes across with its enabled/disabled state, its `GM_setValue` store and its update URL.

A script already installed is recognised by its `@downloadURL`, or by `@namespace` + `@name` when it has none — not by name and version, so a newer version of a script you already have updates it in place instead of installing a second copy beside it. Updating in place keeps the mod's id, its registration and its existing stored values, with the backup's values merged over the top for the keys the backup carries. The import reports how many scripts came in, how many were updated, and what it could not read.

<img src="screenshots/06-migrate.png" width="420" alt="The Migrate from Tampermonkey card expanded, showing the four export steps.">

The `GM_*` surface an imported script can count on — what is supported, what is a stub, `@connect`,
the page world, and which `@include` forms are dropped — is in [gm-api.md](gm-api.md).

## Updates

Installed scripts that name an `@updateURL` or `@downloadURL` (or were installed from a URL) are
checked for newer versions when the side panel or the dashboard opens and when the browser starts,
**at most once a day per mod**. A check fetches the script's `@updateURL` (usually a small
header-only `.meta.js`), and the full script only if that says there is a newer `@version`. Older
versions are never offered. A check that cannot complete — offline, a 404, or on Safari a site you
have not given usermods access to — only leaves a quiet "update check: could not check" on the row.

**Updates are never installed automatically.** When a newer version exists, the mod's row says
**Update available v1.2.0** and the Mods tab shows a count; nothing about the mod changes. The
button (or **Update**, which checks right away) opens the review screen:

<img src="screenshots/17-update-review.png" width="600" alt="The Review update screen: Tidy v1.0.0 to v1.1.0, What changed in its powers listing a new @connect host and GM_xmlhttpRequest, a Safety review marked review carefully with one high finding, the Install update, Not now, Skip this version buttons, and the code diff.">

- **What changed in its powers**, computed from the two headers: sites added or removed
  (`@match`/`@include`/`@exclude`), new permissions (`GM_xmlhttpRequest`, `unsafeWindow`, `@grant
  none` meaning the page's own world), new `@connect` hosts, new `@require`/`@resource` URLs, and
  `@run-at` or frame changes.
- **Code changes**: the line diff between what you have and what is on offer.
- **Install update** installs exactly the text on the screen, keeping the mod's settings and stored
  values. **Not now** closes it. **Skip this version** hides that version until a newer one appears.
- **Check with the agent first** asks the model you last picked in a chat to review the update for
  malicious or risky changes: data being sent somewhere new, cookies or storage being read, input
  being recorded, remote code, wider site matches, mining, ad injection, safeguards removed. It sends
  **only the installed and the new source and the header changes above** — nothing from any page,
  no chat. The scripts are marked as untrusted text, so a script that tells the model it is safe is
  itself a red flag. The answer is a verdict (*looks safe*, *review carefully*, *do not install*), a
  summary and findings with line numbers. It is advisory: the model can be wrong, and the decision is
  still yours. The review is kept for that version, so asking twice costs once. With no provider
  connected the button is disabled and says why.

Turn checking off with **Check installed mods for updates** in Settings › Preferences. There is no
option to install updates automatically.

## Sharing a mod: Export, a gist, Greasy Fork

Each mod's **Export ▾** (the Mods tab, the phone's "more" sheet, and every row in the dashboard) has
four ways out:

- **Download .user.js** saves the file, named from the mod (`wide-wiki.user.js`). The dashboard's
  bulk **Export zip** is unchanged.
- **Copy to clipboard** copies the whole script, header included.
- **Share as Gist** (later **Update gist**) and **Publish on Greasy Fork** (later **Post new
  version on Greasy Fork**) put the script on those sites *in your own tab, signed in as you*.

usermods never publishes anything itself. It has no GitHub or Greasy Fork token and asks for none.
It opens the site's own page in a new tab, fills the form, and shows a small usermods bubble pointing
at the site's save button. **You press that button**; usermods never does.

<img src="screenshots/15-share-hint.png" width="720" alt="GitHub's new-gist form filled with a userscript, file name wide-wiki.user.js, and a usermods bubble pointing at the ringed Create secret gist button.">

**Before anything opens, the script is checked for things that should not be published**: API keys
(`sk-…`, `xai-…`, AWS, GitHub tokens), JSON Web Tokens, `Bearer` tokens, hard-coded `apiKey = "…"`
values, private addresses (`10.x`, `192.168.x`, `100.64–127.x` where Tailscale lives) and host names
(`.local`, `.internal`, `.ts.net`), and `localhost` ports. If any turn up the panel lists them, masked,
with **Share anyway** and **Cancel**. A secret gist is unlisted, not private: anyone with its link can
read it. Everything on Greasy Fork is public. The check runs locally and sends nothing anywhere.

**A gist.** *Share as Gist* opens <https://gist.github.com/> and fills the file name
(`<mod-name>.user.js`), the description and the file itself. The bubble says which button is which:
**Create secret gist** keeps it unlisted, **Create public gist** also lists it on your profile. Once
the gist is saved, usermods remembers it and points the mod's `@updateURL` and `@downloadURL` at the
gist's raw link *without a revision*, which always serves the newest version:

    https://gist.githubusercontent.com/<you>/<id>/raw/<mod-name>.user.js

That is the **install link** shown on the mod's card with **Copy**. Anyone who opens it gets the
usermods (or Tampermonkey) install page, and their copy updates from the gist.

After that the item reads **Update gist**: it bumps the patch version (`1.0.0` → `1.0.1`), opens the
gist's edit page, replaces that file's content, and points at **Update secret gist** / **Update public
gist**. If you deleted the gist, the page says so and offers **Share as a new gist**.

If you are signed out, the bubble says *Sign in to GitHub, then usermods will fill this in*, and it
does once the editor appears (for up to 30 minutes). If GitHub has changed its page so that usermods
cannot find the editor, the script is put on your clipboard (or behind a **Copy script** button) and
the bubble says *Paste your script here (it is on your clipboard) and name the file
`<mod-name>.user.js`*.

**Greasy Fork.** *Publish on Greasy Fork* opens its *Post a new script* form. Greasy Fork expects
`@name`, `@namespace`, `@version`, `@description`, `@match` or `@include`, and `@license`; if the mod
lacks `@license` the panel asks before adding `@license MIT` (unticked until you tick it), and offers
`@namespace usermods` when there is no namespace. The code box and the additional info are filled, and
the bubble points at **Post script**. After Greasy Fork accepts it, usermods remembers the script, and
the item becomes **Post new version on Greasy Fork**, which opens that script's new-version form with
the bumped version. If the mod also has a gist, the bubble mentions that Greasy Fork can *sync* from
the gist's raw link (your script's Admin tab), so new versions post themselves.

## The install banner

When a page offers a userscript, usermods says so at the top of the page:

- a **gist** with a `.user.js` file,
- a **GitHub file page** (`github.com/…/blob/…/x.user.js`),
- a **plain-text script** that the `.user.js` redirect does not catch (a `?raw` view, a paste site),
- a **Greasy Fork** or **OpenUserJS** script page, only when you already have that script and the
  page has a newer version (their own Install button covers the rest).

<img src="screenshots/16-install-banner.png" width="720" alt="A raw userscript shown as plain text, with a slim usermods bar at the top: usermods can install “Pinterest Dark (Polished)”, an Install button and a close button.">

**Install** opens the same install page as a `.user.js` link: preview, permissions and `@require`
first, nothing saved until you confirm. If the script is already installed (same download URL, or
the same `@name` *and* `@namespace`) the bar says **Installed ✓**, or **Update to v…** when the page
has a newer version; the install page then updates your copy in place rather than adding a second
one. The × hides it for that page, remembered. Your own shared gists, and the tabs a share is
filling, never show it. It never installs anything by itself.

It costs nothing elsewhere: the check reads the page only on those hosts or when the document is
plain text (and then only its first 2 KB), it never runs in frames, and it makes no network request.
On Safari it only runs on sites you have given usermods access to.

## Dashboard

The side panel is scoped to the page you are on — by default to the tab as well: it shows that site's chats and highlights that
site's mods. The dashboard is the other half — everything, everywhere, in a full tab.

![The dashboard, showing the overview strip, chats grouped by host, and a transcript preview](screenshots/07-dashboard.png)

Open it from the **Dashboard** button in the side panel's tab bar, from the toolbar icon's context
menu (**Options**), or from **Details → Extension options** in `chrome://extensions` — it is
registered as the extension's options page, so all three land on the same tab. Opening it twice
focuses the tab you already have rather than stacking up copies.

**Chats.** Every chat across every site, grouped by host with counts, most recently used site
first. The search box filters on title and host immediately, and on the message text inside stored
transcripts as those load — transcripts live in their own storage keys, so they are read lazily,
debounced and capped rather than all at once. Each chat can be renamed inline, archived, deleted,
or opened; clicking one shows its transcript read-only beside the list, so you can re-read an old
conversation without going back to the site. Select several for a bulk archive or delete.

**Reopening a chat.** *Open* puts you back where the chat was: the page the chat was last used on,
with the side panel showing that chat rather than whatever the panel would otherwise have restored.
With the default *on this tab only* scope it goes there in the dashboard's own tab, because that is
the only way to have the panel open on the right tab — `chrome.sidePanel.open` has to be called
inside the click that asked for it, before the destination tab could exist, so usermods opens the
panel on the tab it already has and then navigates that same tab (a tab keeps its id, and its panel,
across a navigation). *Open in new tab* beside it keeps the dashboard where it is and loads the page
in a new tab; open the panel there yourself. Under *on every tab* scope, *Open* behaves as it always
did: a new tab and the window-wide panel.

Chats remember their page from the turn they were last used on; chats recorded before that existed
fall back to the site's front door. Opening an archived chat this way does not unarchive it — as in
the panel, only sending a message does.

**Mods.** Every saved script with its version, match patterns, grants, world, size, when it changed
and where it came from (a download host, *written in chat*, or *imported*). Filter by site or by
enabled state; toggle, export, update or delete one at a time, or select several to enable, disable,
delete, or export together as a zip. Selecting a mod opens its source in an editor beside the list:
saving re-parses the header, so editing an `@name` or a `@match` line updates the mod and
re-registers it, with the same parse warnings the install screen shows. *Install from URL*, *Import
file* and *Migrate from Tampermonkey* are all here too.

**Settings** is the same view the side panel shows, so the dashboard is a complete home: Chats ·
Mods · Settings. The strip across the top counts what you have, shows whether *Allow User Scripts*
is on, and names the providers that are connected. Each chat row shows the model that chat uses, and
the transcript preview marks where it changed.

Anything changed in the side panel shows up here without a reload, and vice versa.

## Where the panel opens

By default the panel belongs to the tab you opened it on. Switch to another tab and it is not
there; come back and it is, still on the same chat. That matches what the panel actually shows —
this site's chats, this site's mods — so it is never sitting over an unrelated tab claiming to be
about it.

*Side panel opens* in **Settings** has the other choice: **On every tab** is Chrome's window-wide
panel, which follows you from tab to tab until you close it, and is how usermods behaved before
this setting existed. The change takes effect on the next click of the toolbar icon — no reload.

The toolbar icon only opens the panel; Chrome gives extensions no way to close one, so closing is
the ✕ in the panel's own header.
