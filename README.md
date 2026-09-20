<p align="center"><img src="docs/banner.png" alt="usermods. Your web. Your rules. Vibe-code userscripts in place." width="100%"></p>

# usermods

**Vibe-code userscripts in place.** An open-source browser extension that lets you customize any website by chatting with the LLM of your choice.

Open the side panel on any page, describe what you want changed, and usermods inspects the page, writes a userscript, tests it live, and hands it to you with *Try* and *Save* buttons. Saved mods run automatically on every matching page load. Export them as standard `.user.js` files, install ones from Greasy Fork, or [migrate your whole Tampermonkey library in one file](#migrating-from-tampermonkey).

Userscripts, userstyles, usermods.

<p align="center"><img src="docs/screenshots/hero-github.png" alt="usermods in the Chrome side panel next to a GitHub repository page, mid-conversation: a proposed mod that collapses the file list is saved and enabled, and the user is asking for a follow-up change." width="100%"></p>

## Why

- **Any backend.** Anthropic's API, OpenAI, OpenRouter, or anything OpenAI-compatible: Ollama, LM Studio, vLLM, mlx_lm. Your key, your machine, no account, no hosted service.
- **Several at once, and switch mid-conversation.** Connect as many providers as you use. The model is picked in the chat itself, from a dropdown under the message box that lists every connected provider's models, and you can change it at any point: the next turn goes to the new model with the whole conversation, tool calls included. [Details](#choosing-the-model-in-the-chat).
- **Use the subscription you already pay for.** Sign in with ChatGPT (Plus, Pro, Team) or SuperGrok / X Premium+ straight from Settings. No API key, no local proxy, no per-token bill. [Details](#using-a-subscription-instead-of-an-api-key).
- **The model actually sees the page.** It has tools to read a pruned DOM, list elements, read computed styles, take screenshots, and run scripts to test its work before proposing anything. Screenshots reach any vision model, whichever protocol its backend speaks; a text-only endpoint is detected once and told to work structurally instead. [Details](#screenshots-and-models-that-cannot-see-them).
- **Show it what you mean.** Paste or drop a screenshot or a mockup into the composer, or pick one with *Attach image*. Images are shrunk and re-encoded in the panel before they go anywhere, up to four per message. [Details](#attaching-images).
- **One-off tasks too.** "Scroll to the bottom, open every carousel, and give me download links for all the photos" runs as a script, no mod required.
- **Portable.** Mods are plain userscripts with a `==UserScript==` header. Nothing proprietary.
- **MIT.**

## Status

Early. The core loop works end to end: chat, page inspection, live testing, propose, save, run on load, edit an installed mod in chat, import and export. Outside userscripts install from a URL, a `.user.js` link or a file, with the `GM_*` API and `@require`/`@resource` support they expect, and a Tampermonkey backup imports in one step. See [Roadmap](#roadmap).

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/02-chat-refs.png" alt="The composer holding an @img.mw-file-element chip produced by the element picker.">
      <sub><b>Point at an element.</b> Clicking one on the page drops an <code>@reference</code> into your message, so you can say "this" and mean it.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/06-migrate.png" alt="The Migrate from Tampermonkey card expanded, showing the four export steps.">
      <sub><b>Migrating.</b> One Tampermonkey backup file brings the whole library across, on/off state and stored values included.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/03-mods.png" alt="The Mods view listing three saved mods, split into the ones matching this site and the rest.">
      <sub><b>Mods.</b> Saved scripts, split by whether they match the page you are on. Toggle, run, export or delete each one.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/04-settings.png" alt="Settings showing three connected providers, one opened to its name, base URL, API key and Fetch models, and the Add provider presets below.">
      <sub><b>Settings.</b> Every provider you have connected, each with its own key or sign-in and its own model list, and presets for adding another.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/05-install.png" alt="The install page previewing a script fetched from Greasy Fork, with its matches, GM permissions and required library.">
      <sub><b>Installing an outside script.</b> A <code>.user.js</code> link shows what it matches, what it is granted and what it loads, before anything is saved.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/12-model-picker.png" alt="The model picker open under the message box: a filter field, then the models of two connected providers, Anthropic and Ollama, grouped under their names, with Refresh models and Manage providers at the bottom.">
      <sub><b>Pick the model in the chat.</b> Every connected provider's models, under the message box. Change it mid-conversation and the next turn goes to the new one.</sub>
    </td>
  </tr>
</table>

### Design

The interface is built on the banner, at the banner's hues rather than its saturation: a deep navy
page and panels on the electric blue's own hue, the blue itself for buttons, links and the active
tab, lime reserved for anything **alive**, pink for the hero card's edge and element chips, cyan for
focus. Anything you actually read — the transcript, code, the editor, settings help — sits on a solid
panel in a text face at a comfortable size, because the system's first principle is **calm, branded,
legible**.

> **Note.** This branch is **option B**, one of two design options open for comparison; neither is
> merged. Option A applies the same identity boldly — the electric blue as the page itself, bright
> 2px borders, hard offset shadows and pixel type throughout. The two are behaviour-identical.
> [§2 of the design doc](docs/design.md#2-what-is-different-from-option-a-concretely) is a
> side-by-side.

**[docs/design.md](docs/design.md)** is the full style guide: the palette with hexes and OKLCH values
for both themes, the contrast table, typography, every component with its states and do/don'ts,
theming and the accessibility commitments. It embeds a living specimen rendered with the real
stylesheets, so it shows the system rather than describing it.

### Light and dark

The panel follows your OS by default, and the ◐ in the tab bar cycles Dark → Light → System from
anywhere. Day is its own design pass, not night inverted: the identity colours drop to the tones that
can carry text on white, the page is a cool white tinted on the same hue as night's navy, and every
glow turns off — there is no neon in daylight. Both themes meet WCAG AA and hold long-form reading
pairings to 7:1, which `test/contrast.test.ts` enforces against the token file.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/01-chat-proposal-light.png" alt="The proposal conversation in the day theme: white panels on a cool blue-white page, a blue active tab and the hero card edged in magenta.">
      <sub><b>Chat, day.</b></sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/01-chat-proposal.png" alt="The same proposal conversation in the night theme: navy panels on a deeper navy page, a blue active tab and the hero card edged in magenta.">
      <sub><b>Chat, night.</b></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/03-mods-light.png" alt="The Mods view in light mode.">
      <sub><b>Mods, light.</b></sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/03-mods.png" alt="The Mods view in dark mode.">
      <sub><b>Mods, dark.</b></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/04-settings-light.png" alt="Settings in light mode.">
      <sub><b>Settings, light.</b></sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/04-settings.png" alt="Settings in dark mode.">
      <sub><b>Settings, dark.</b></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/07-dashboard-light.png" alt="The dashboard in light mode: the overview strip, chats grouped by host, and a transcript preview open beside them.">
      <sub><b>Dashboard, light.</b> Every chat and every mod in a full tab — see <a href="#dashboard">Dashboard</a> below.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/07-dashboard.png" alt="The same dashboard in dark mode.">
      <sub><b>Dashboard, dark.</b></sub>
    </td>
  </tr>
</table>

## Install (from source)

Requires Node 22+ and Chrome 135+. For Safari on iOS, see [Safari and iOS](#safari-and-ios).

```sh
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `.output/chrome-mv3`.
2. Click **Details** on usermods and turn on **Allow User Scripts**. Chrome requires this toggle for any extension that runs user scripts, including Tampermonkey.
3. Click the usermods icon to open the side panel **on that tab**. Go to **Settings**, click a preset under **Add provider**, and paste a key (or a local server URL). It saves as you type. Back in **Chat**, the model is the dropdown under the message box.

### Safari and iOS

usermods also runs in Safari on iOS: built, installed and watched running saved mods in Mobile
Safari on the iPhone 15 simulator (iOS 17.5). No physical iPhone or iPad has run it yet. The
execution layer there is different, because Safari has no `chrome.userScripts`, and the UI is a
toolbar popup built for a thumb rather than a side panel. Building it needs a full Xcode:

```sh
npm install
node scripts/safari-xcode.mjs doctor      # what is installed, and what that allows
node scripts/safari-xcode.mjs simulator   # build, boot a simulator, install, launch
```

Then turn the extension on in **Settings > Apps > Safari > Extensions > usermods** and allow it on
the sites you want. [docs/safari.md](docs/safari.md) has the device build, the isolation guarantees,
the limitations (page-world mods and site CSP, the ignored install redirect rule, API-key providers
only, what `localhost` means on a phone) and a row-by-row account of what was seen running on iOS
and what was not.

### Where the panel opens

By default the panel belongs to the tab you opened it on. Switch to another tab and it is not
there; come back and it is, still on the same chat. That matches what the panel actually shows —
this site's chats, this site's mods — so it is never sitting over an unrelated tab claiming to be
about it.

*Side panel opens* in **Settings** has the other choice: **On every tab** is Chrome's window-wide
panel, which follows you from tab to tab until you close it, and is how usermods behaved before
this setting existed. The change takes effect on the next click of the toolbar icon — no reload.

The toolbar icon only opens the panel; Chrome gives extensions no way to close one, so closing is
the ✕ in the panel's own header.

For development, `npm run dev` starts WXT with hot reload and opens a Chrome profile with the extension loaded. `npm run typecheck` type-checks, and `npm test` runs the Node test suite, including Safari execution and security coverage (no browser or API key needed).

`npm run screenshots` regenerates the images above, and `npm run smoke` runs the same flow headless as an end-to-end check of the chat loop. Both build the extension, load it into Playwright's Chromium, and drive the real side panel against `scripts/mock-llm.mjs` — a local server that plays scripted conversations over the OpenAI wire protocol, so neither needs an API key or a live model. The page-inspection tools run for real against live pages, and the smoke run asserts that the reply streams, that `get_page`, `find_elements` and `get_styles` all succeed, that the proposal card appears with the expected name and match pattern, and that saving it writes a userscript to storage. A second scripted conversation covers the agent's guardrails: it makes four page reads in a row and then proposes an untested mod, and the smoke reads the mock's recorded requests back from `GET /__requests` to prove the read-budget nudge and the propose-time refusal actually reached the model. A third (`npm run smoke:wait`) drives every `wait_for` condition against a fixture page the mock server serves itself, where content arrives 800ms late, an element is revealed by editing a CSS rule and nothing else, the route changes by `pushState`, and a region mutates for 1.5s and then settles — asserting from the recorded requests that an already-true condition returned in under 100ms, that the style-only reveal was noticed promptly (which only the polling floor can do), that a deliberate timeout carried diagnostics and was not flagged as an error, and that Stop ends a 20-second wait within 500ms leaving no observer behind. A fourth (`npm run smoke:images`) covers attachments end to end: it pastes a generated PNG into the composer through a real `ClipboardEvent` carrying a `File`, drops a 6000×6000 one onto the transcript, checks it was downscaled rather than refused, watches an SVG be turned away with a note, removes one, sends, and then reads the mock's recorded requests to prove that exactly one `image_url` part reached the wire, as JPEG, at 1568×1568, *before* the text of its message and with its caption beside it — then opens the full-size overlay out of the chat's blob store, closes it on Escape and reloads the panel to confirm the thumbnail is still there. A fifth (`npm run smoke:vision`) is the only flow that drives the real `screenshot` tool, and reads the wire twice: against an ordinary mock it asserts the capture arrived as an `image_url` part in the user message *after* the `tool` message that answers the call — an arrangement the mock's validator now enforces the adjacency rules for, because only a real backend would otherwise catch it — and against a mock that answers 400 to any request carrying a picture, it asserts the run still finishes, that the refused request was re-sent immediately without the image, that the panel said why, and that not one later request carried an image. See the comments at the top of `scripts/screenshots.mjs` for how the panel page is driven in an ordinary tab standing in for the real panel — and, in the panel-scope flow, how the real panel is opened and observed instead.

`npm run smoke` runs four flows: the chat loop above, the chats flow (`npm run smoke:chats` — the
panel restoring the last chat, archiving, unarchiving on send), the dashboard flow
(`npm run smoke:dashboard` — host grouping and counts, search narrowing on titles, hosts and
message text, the transcript preview, inline rename, archive, the "open this chat on its page"
handoff, toggling a mod through to storage, editing a mod's source, and bulk actions) and the
panel-scope flow (`npm run smoke:panelscope`). That last one drives the *real* side panel: a
Playwright click is a trusted user gesture, which is all `chrome.sidePanel.open` asks for, so
clicking *Open* genuinely opens a panel. Playwright never lists the panel as a page, so the flow
observes it through the extension's own APIs — `chrome.runtime.getContexts()` reports a
`SIDE_PANEL` context, and `chrome.sidePanel.getOptions()` says which tab it is attached to. It
asserts that under the default scope the window-level panel is disabled, that the clicked tab gets
tab-specific options while a second tab in the same window still reports the disabled default, that
those options survive the tab navigating to the chat's page, and that flipping the setting to *on
every tab* and back reconfigures Chrome both ways.

The resume flow (`npm run smoke:resume`) takes the network away for real. The mock backend accepts
a fault plan at `POST /__faults` — drop the connection mid-stream, answer with a status and a
`Retry-After`, or refuse connections until `DELETE /__faults` — and the flow uses it four ways: a
stream that drops once is retried without anyone doing anything, and the reply is not duplicated;
an outage that outlasts the retries ends in an error with **Resume**, the progress rows survive a
panel reload, and one click finishes the run; the service worker is stopped mid-run over CDP and
the chat says it was interrupted; and the panel is closed mid-run and reopened while the run is
still going. "Never a re-run" is asserted from `GET /__requests`: the prompt is in the conversation
exactly once, the resumed request carries the earlier tool results, and no tool call is made twice.

The models flow (`npm run smoke:models`) is about providers and the in-chat model picker. The mock
answers on any path prefix and records the endpoint and model of every request, so one port serves
several "providers" that can be told apart on the wire. The flow seeds a profile in the old
single-provider shape and checks it was migrated into one connection (key, model and Images setting
included, once); adds two more providers through Settings; drives the picker from the keyboard alone;
sends turn 1 to one model and turn 2 to a model on the other endpoint, and asserts from
`GET /__requests` which endpoint and model each request used, that the first turn's tool call and
result were carried over, and that the mock's validator found nothing wrong with any request;
reloads; swaps during a run and watches the running turn finish on the old model while the queued
message uses the new one; types a model id for a provider that cannot list; removes the chat's
provider and checks nothing is sent; checks the layout at 320px; and lists models from a mock of the
ChatGPT Codex backend, which answers 400 without `client_version` exactly as the real one does.
Every other flow still seeds the old settings shape, so each of them exercises the migration too.
`npm run smoke:composer` measures the growing message box in a real panel.
Backoff is shortened for the flow through a `chrome.storage.local` key (`debug:retryPolicy`), which
only the extension's own contexts can write.

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
- **If a chat's provider is removed or signed out**, the chat says so under the message box and
  waits for you to pick another model. It never quietly sends your page to a different provider.
- Titles and compaction summaries use the chat's model too. The context budget is one setting for
  every provider, so set it for the smallest context window you use.

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

**Not in the Chrome Web Store build.** Subscription sign-in ships only in the GitHub build — the one you get from [Install (from source)](#install-from-source) above. `npm run build:store` and `npm run zip:store` produce the Web Store variant, which sets a compile-time flag that removes the two subscription presets, their provider options and the sign-in card, and tree-shakes the OAuth module out of the bundle entirely, so that build contacts no vendor auth endpoint. These logins rely on endpoints neither vendor documents or licenses for third parties, which does not fit a listing that has to declare exactly what it talks to. If you install the Web Store build over a profile that was signed in, Settings falls back to the default provider and tells you why; the GitHub build keeps every feature, this one included.

## Editing a mod you already have

A mod is rarely finished the first time. **Edit in chat** opens any installed mod as the draft of a
conversation: the script you have is v1, the model is told it is editing something already installed
rather than writing something new, and **Update mod** writes your changes back over the same mod —
same id, same on/off state, same `GM_setValue` store, no second copy running beside the first.

<img src="docs/screenshots/11-editing.png" width="420" alt="A chat whose draft is an installed mod. Under the draft bar, a line reads Editing Kingfisher Notes, with Save as a new mod instead beside it; the bar's button says Update mod.">

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

**Click a `.user.js` link.** usermods redirects `.user.js` navigations to its own install page, the way Tampermonkey does, so clicking an install link on Greasy Fork shows the same preview instead of a wall of raw JavaScript. The script's URL travels in the install page's fragment (`install.html#https://…`) and everything after the first `#` is taken verbatim, so a link whose own query string carries another `url=` cannot change which script is previewed. The page shows the exact URL it is about to fetch, and refuses anything that is not `http`/`https`.

**Import a file.** *Import file* in the Mods tab takes a `.user.js` file from disk through the same preview.

`@require` libraries and `@resource` files are downloaded at install time and stored with the mod, because registered scripts cannot fetch them later. If one of those downloads fails, the install fails and names the URL. Scripts with a `@downloadURL` get an **Update** button that refetches and compares `@version`.

### Attaching images

Paste an image into the composer (a screenshot copied with ⌘⌃⇧4 works), drop one onto the panel, or
use **Attach image**. PNG, JPEG, WebP and GIF are accepted; SVG is refused with a note, because an
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

### GM API compatibility

| Function | Status |
|---|---|
| `GM_info` / `GM.info` | Supported |
| `GM_addStyle`, `GM_addElement` | Supported |
| `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues` (and `GM.*`) | Supported. Reads come from a snapshot taken when the script was registered; writes persist immediately and are pushed live to the script's other open tabs. |
| `GM_getResourceText`, `GM_getResourceURL` | Supported, from `@resource` files fetched at install time |
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | Supported, cross-origin, via the background worker, subject to `@connect`. `responseType` `arraybuffer`, `blob`, `json`, `document` and text all work, with `responseXML` for `document`. `onload`, `onerror`, `onloadend` and `abort()` work; streaming and upload progress events do not. |
| `GM_openInTab` / `GM.openInTab` | Supported, with Tampermonkey's focus rules: `GM_openInTab(url)` opens in the foreground, `GM_openInTab(url, true)` and the object form without `active: true` open in the background. The returned handle is a stub: `close()` does nothing. |
| `GM_setClipboard`, `GM_log` | Supported |
| `GM_registerMenuCommand`, `GM_unregisterMenuCommand` | **Stub.** Commands are recorded but there is no menu UI to invoke them. |
| `GM_notification` / `GM.notification` | **Stub.** Logs to the console instead of showing a desktop notification. |
| `GM_getTab`, `GM_saveTab`, `GM_getTabs` | **Stub.** Return empty objects. |
| `GM_addValueChangeListener`, `GM_removeValueChangeListener` | Supported. Fire for this script's own writes and for writes from its other open tabs, with `(key, oldValue, newValue, remote)`. In the page world (`@grant none`) only local writes fire. |
| `GM_download`, `GM_cookie`, `GM_webRequest` | Not implemented |

#### `@connect`

`GM_xmlhttpRequest` is cross-origin, so a script may only reach the hosts its header declares. A request is allowed when its host equals or is a subdomain of a `@connect` entry, when the script declared `@connect *`, or when it declared `@connect self` and the host is one the script's own `@match`/`@include` lines cover (a `*://*.example.com/*` pattern covers `example.com` and its subdomains; a script matching every site gains nothing from `self`). Anything else is refused with an error naming the host and the `// @connect <host>` line that would permit it. The install preview lists the `@connect` entries next to the `GM_*` permissions, so you can see what a script intends to talk to before it is saved.

Scripts and their `@require` libraries are evaluated in their own function scopes, not in one shared strict-mode closure, so sloppy-mode libraries and scripts behave as they do under Tampermonkey. A script gets strict mode only from its own `'use strict'` directive.

`@grant none` and `unsafeWindow` scripts run in the page's **MAIN** world, where they share globals with the page — which is what those scripts want. The trade-off is that extension messaging is unavailable there, so `GM_setValue` writes from a MAIN-world script update the in-page copy but **cannot be persisted**. Mod cards and the install preview mark those scripts with a *page world* badge. Everything else runs in Chrome's isolated `USER_SCRIPT` world.

Regex-style `@include` lines (`/^https?:\/\/…$/`) are not supported; Chrome matches on patterns and globs only. The install preview warns when it drops one.

## Dashboard

The side panel is scoped to the page you are on — by default to the tab as well: it shows that site's chats and highlights that
site's mods. The dashboard is the other half — everything, everywhere, in a full tab.

![The dashboard, showing the overview strip, chats grouped by host, and a transcript preview](docs/screenshots/07-dashboard.png)

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

## How it works

```
side panel (React)  ──rpc──▶  background service worker  ──▶  LLM provider (streaming, tool calls)
        │                             │
        │                             ├──▶ content script: DOM snapshot, element picker, selectors, styles
        │                             ├──▶ chrome.userScripts.execute: run a draft once, capture result + console
        │                             └──▶ chrome.userScripts.register: saved mods run on matching pages
        └── Try / Save / Enable
```

- **Provider adapters** live in `lib/providers/`. Anthropic uses the official SDK; the OpenAI-compatible adapter speaks `chat/completions` with function calling over raw fetch. Adding a provider means implementing one `chat()` method.
- **The agent loop** (`lib/agent/`) is provider-neutral. Tools: `get_page`, `find_elements`, `get_styles`, `run_script`, `wait_for`, `screenshot`, `propose_mod`.
  - A lost connection does not cost the run. The model request — and only the request, never a tool, because tools have side effects on the page — is wrapped in a retry (`lib/agent/retry.ts`): the adapters throw a structured `ProviderError` carrying the status and any `Retry-After`, a pure classifier retries network failures, streams that end before their terminal event, 408/425/429/500/502/503/504/529 and "overloaded", and never a 400/401/403/404/422, a rejection or Stop. Backoff is 1s, 2s, 4s, 8s, 16s with jitter; `Retry-After` is a floor, capped at a minute; while `navigator.onLine` is false the loop waits for `online` instead of spending attempts. The Anthropic SDK's own `maxRetries` is set to 0 so the two policies cannot multiply. Text a failed attempt had already streamed is taken back off the transcript, so the retry is not read twice.
  - A failed run is resumed, not re-run. The loop returns `{ messages, failure? }`, and `messages` is always a history every adapter accepts, holding everything the run completed. It is also checkpointed to storage after every completed step, and a run record (`lib/runstate.ts`) is written before a run does anything, so a service worker that starts up and finds a run recorded as in flight with no session behind it marks it interrupted. Either way the chat offers **Resume**, which re-enters the loop with no new user turn: the model gets the same conversation again and carries on. Nothing resumes without a click. While a run is in flight the worker keeps itself alive with the pattern Chrome's migration guide gives for long-running work (a trivial extension API call every 20s); what that cannot prevent lands on the interrupted path.
  - `wait_for` is how the agent handles a page that is still working. Pages are asynchronous — content lazy-loads after a scroll, a click's result arrives 800ms later, a SPA changes route without navigating, a modal animates in — and without a way to wait the model polls with `run_script`, burns its step budget and gets nudged for over-reading, or proceeds too early and reports failure. One call takes exactly one condition: a selector (with `attached` / `visible` / `hidden` / `detached`, an optional `count`, an optional text filter), page text appearing or disappearing, a URL matching a substring or `/regex/`, a load state, the DOM going quiet for `quiet_ms`, or a plain `ms` delay as a documented last resort. DOM conditions are watched in the content script by a `MutationObserver` with a polling floor under it — a page that reveals an element by editing a CSS rule mutates nothing at all, and the observer is structurally blind to that — while URL and load conditions are watched in the background, because the navigation being waited for destroys the content script. A condition that is already true returns in about a millisecond, and **a timeout is not an error**: it comes back as a plain statement with the diagnostics that tell the two cases apart (`0 elements match .result; closest: 12 element(s) match li` versus `document.readyState=complete; 14 mutation batches observed in the last 5s`), so the model can tell "never going to happen" from "still loading". Waiting counts as a step but is neither a page read nor an act, so it cannot trip the read budget or launder a read streak; a separate guard nudges the model after more than three waits in a row or a minute of cumulative waiting in one turn. Stop ends a wait immediately and leaves no observer, listener or timer behind.
  - `run_script` also takes an optional `then_wait` with that same condition shape, so "click it, then wait for the result" is one step instead of two — and a script that navigates the page composes sensibly with a `url` or `load` condition, where the navigation is the expected outcome rather than a lost result.
  - `run_script` really does return the value of the last expression. The code is injected as an async function body, where only an explicit `return` would yield a value, so the background parses it with acorn and rewrites a trailing expression statement into a `return` (`lib/runscript.ts`) — `1 + 1` reports `2`, and code that does not parse is refused with a line and column instead of being injected broken. A script that only changes the page reports `Completed. No return value. DOM: 14 removed, 0 added, 2 attributes changed.` from a `MutationObserver` the wrapper runs around it, so "it did nothing" and "it worked and returned nothing" are no longer the same message. A lost result is named for what it was: a navigation mid-run, an injection that was refused, a thrown error (its stack trimmed to your code's frames, with the line numbers you wrote) or a real 20-second timeout.
  - `find_elements` labels how durable each selector is — `[stable: id]`, `[stable: data-attr]`, `[fragile: generated class]`, `[fragile: positional]` — and the prompt spends the model's second look only on the fragile ones.
  - `propose_mod` refuses a proposal that has not been tested with `run_script` since the last one, that does not parse, that uses `eval`, `new Function`, `document.write` or an inline handler attribute, or whose `@match` covers every site when you did not ask for that. Each refusal is a tool error the model recovers from in the same turn. `untested_reason` overrides only the first check, and the proposal card tells you it was never run.
  - The turn is capped at 30 model round-trips. Five from the end the model is told to wrap up; if it still runs out, the panel says `stopped after 30 steps · send a message to continue` rather than simply going quiet. A counter also watches page reads: four in a row with nothing run or proposed and the model is told to act.
- **Drafts.** Each chat has one draft mod — its *artifact* — pinned above the composer, so "what is the script right now?" is a glance rather than a scroll back through four proposal cards. Every accepted proposal becomes the next **version** of that one draft, with a line-based **diff** against the version before it and a **roll back** that appends the old code as a new version rather than truncating the history, so nothing is lost and a rollback is itself undoable. The model is told what the draft is: the full current code rides along with every message you send, marked as your context and never mixed with page content, so "make the button blue instead" is an edit to the script that exists rather than a fresh one written from memory — and after you roll back, the next request is answered against the version you rolled back to. Collapsed the panel is one line (name, version, size, and Try / Save / Export); expanded it gives you the code, the version strip, the diff and an inline rename. **Save** creates the mod and remembers which one it made, so every later save reads *Update mod* and rewrites that same mod in place — a chat cannot leave three copies of its own script running on the page, which is what matching proposals by name used to do whenever the model retyped the name or you renamed the mod in the dashboard. If the linked mod was deleted, Save makes a new one and says so. Drafts show up in the dashboard too: a chat row badges `draft · 3 versions`, its preview leads with the current code and its version strip, and a saved mod says which chat wrote it with a link straight back into that conversation.
- **Context compaction** (`lib/agent/compact.ts`) keeps a long chat inside the model's context window. A page snapshot can be 60,000 characters and the history used to resend every one of them forever. Before each model call usermods estimates the size of the conversation and, once it passes 70% of the **context budget**, does the cheap thing first: it replaces the *content* of old bulky tool results — page snapshots, element listings, style dumps, screenshots, script logs — with a one-line stub the model can act on (`[elided · get_page result · 48,102 chars · call get_page again if you need it]`), largest and oldest first. The most recent couple of turns, the latest result of each tool, and every `propose_mod` call are never touched, so the mod you are working on and the model's fresh view of the page both survive. If that is still not enough, one extra tool-free call to the same model folds the older half of the chat into a single summary — your goals, the decisions and the rejected approaches, every selector found and whether it held up, the full text of the current proposal — and the three most recent turns stay verbatim. Cuts land only at turn boundaries, so a tool call is never separated from its result. If that summary call fails, the oldest turns are simply dropped rather than failing your turn. Either way the panel shows a muted line (*earlier tool output trimmed · 148k → 61k tokens*) and **your transcript is never rewritten** — only the history sent to the model shrinks. The budget is *Context budget* in Settings, 120,000 tokens by default; lower is cheaper and faster, higher keeps more of the chat in front of the model. Each compaction invalidates the provider's prompt cache from the oldest message it touched, which is why it runs in batches at a threshold rather than trimming a little every turn.
- **Mods** are stored in `chrome.storage.local` as full userscript text. The header is parsed for name, description, `@match`/`@include`/`@exclude`, `@grant`, `@require`, `@resource`, `@run-at` and `@noframes`. Enabled mods are registered with `chrome.userScripts`, each wrapped in a closure that provides the `GM_*` and `GM.*` API, in the world and at the run-at its header asks for.
- **Chats** are per site and live in `chrome.storage.local`, so they survive the panel closing, the service worker sleeping and a browser restart. Opening the panel on a site brings back its last chat, transcript and all, without a click; that keeps happening until you start a new one or **archive** it. Archiving is the switcher's main "done with this" action and needs no confirmation, because it is reversible: archived chats move to an *Archived* group at the bottom of the switcher, where you can reopen one (sending in it unarchives it), put it back, or delete it for good. Only deleting asks. Chats name themselves: once the first turn finishes, usermods makes one small extra call to the same model — no tools, a few hundred characters of the exchange — and asks for a three-to-six-word title, refreshing it once more when the chat reaches its fourth turn. That call happens after your turn is done and is never allowed to slow it down or fail it; if it errors, the truncated first message stays. **Rename** in the switcher gives a chat your own name, and nothing overwrites that afterwards. Turn the whole thing off with *Name chats automatically* in Settings. Runs are isolated per chat and several can be in flight at once on different tabs: a chat keeps streaming into its own transcript while you read another one, and Stop only stops the chat you are looking at. The index is capped at 200 chats per profile, oldest dropped, with archived chats evicted before live ones, and screenshots are stripped from stored history.
- **Attached images** (`lib/images.ts`, `entrypoints/sidepanel/images.ts`) are processed entirely in the panel: `createImageBitmap` + `OffscreenCanvas` (with a `<canvas>` fallback) decode, downscale to 1568px and re-encode, which is also what strips EXIF. A turn's images become `image` content parts placed *before* its text, because that is the order all three provider adapters expect, each with a one-line caption (`[attached image 1: 1200x800 png, mock.png]`) so the model can refer to them. A chat's full-size attachments live under a fourth storage key, `chat:<id>:blobs`, keyed by content hash so the same picture is stored once and removed with the chat; the transcript keeps only a 320px thumbnail, which is what a reloaded panel renders and what the dashboard's preview shows. Compaction counts an image at its flat cost and elides old ones in tier 1.

## Security notes

- Page content that the model reads is untrusted. The system prompt tells the model to treat it as data, and every generated script is shown to you before it is saved. Read it.
- Scripts run in an isolated world: they see the DOM but not the page's JavaScript globals. Default `@match` is the current site only.
- Your API keys are stored in extension local storage, and each is sent only to the provider it belongs to. Removing a provider deletes its key.

Found a vulnerability? Please report it privately through GitHub's **Report a vulnerability** button
rather than opening an issue. [SECURITY.md](SECURITY.md) has the scope and what to expect.

## Privacy

usermods has no server, no account and no telemetry. The author receives nothing.

To change a page, the model has to see it, so when you send a message usermods sends — **directly
from your browser to the provider you picked for that chat, and nowhere else** — your message, the page's
address and title, a pruned copy of its HTML, details of elements it looks up or you point at, and a
screenshot of the visible tab when the model asks for one. If the page is your mailbox or your bank,
that content goes too; close the panel on pages you would rather not share. Point usermods at a
local model and nothing leaves the machine at all.

Your API key, subscription tokens, saved mods, their `GM_setValue` stores and your chat history all
live in extension local storage on your device. Keys and tokens are sent only to the endpoint they
authenticate.

The panel says all of this in the side panel before your first message, and the notice is always
available again from Settings → *Review data notice*. The full policy is in
[PRIVACY.md](PRIVACY.md); the Chrome Web Store submission material is in
[docs/store/](docs/store/).

## Roadmap

- Agent mode with proper click, type and scroll tools plus screenshot-driven verification, for tasks the DOM-script approach handles poorly.
- Mod sharing: export is there; a gallery is not.
- CSS-only mods via a `@usermods-style` header, so pure restyles need no JavaScript.
- Firefox, once its side panel story is settled.
- Safari on macOS. The iOS build is here; the desktop popup and its notarization are not.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the npm
scripts, where everything lives, how to add a provider, and the one hard rule: every fix lands with a
regression test. The [Code of Conduct](CODE_OF_CONDUCT.md) sets out how this project is run and the
one line it draws.

## Author

Made by [Kenneth Ballenegger](https://github.com/kballenegger).

## License

MIT © Kenneth Ballenegger
