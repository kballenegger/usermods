# Changelog

All notable changes to usermods are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-19

First public release, and the first submission to the Chrome Web Store.

### Chat and the agent loop

- A side-panel chat where you describe the change you want in plain language, and the model writes
  a userscript for the page you are on.
- An agent loop with real tools: it reads a pruned snapshot of the DOM, queries elements by
  selector, reads computed styles, takes a screenshot of the visible tab, runs a draft script once
  to check the result, and waits for the page when the page is still settling.
- Proposals arrive as a card with the finished script, its `@match` patterns, and **Try now** /
  **Save & enable**. Nothing is stored until you save it.
- Point at an element on the page and an `@reference` drops into the composer, so "make this
  wider" means something specific.
- Queue a message mid-run and it is delivered between tool calls; **Stop** ends a run cleanly.
- Attach or paste images into the conversation.
- The message box grows with what you type or paste, up to about ten lines (or 40% of the panel on
  a short window), then scrolls inside; it goes back to its resting height when you send.
- A per-chat draft mod with versions, a diff between them, rollback, and update-in-place, so a mod
  is refined over several turns instead of re-proposed from scratch.
- History compaction against a context budget you set: old page snapshots and tool output are
  trimmed first, then the earlier part of the conversation is summarised.
- A live activity line with stall detection, so a long run is never a silent one.
- A lost connection costs a pause, not the run. A model request that fails for a reason that will
  pass — no network, a stream that drops mid-reply, a 408/425/429/5xx, an overloaded provider — is
  retried up to five times with backoff (about 1s, 2s, 4s, 8s, 16s, honouring `Retry-After` up to a
  minute), and the activity line says so: `connection lost · retrying in 4s · attempt 2 of 5`. Only
  the request is retried; a tool never runs twice. While the machine is offline the run waits for
  it to come back instead of spending attempts. **Stop** ends a wait immediately.
- A long outage costs one click, never a re-run. When retries run out (or the error is not one
  retrying can fix, such as a bad key), everything the run completed — every reply, tool call and
  tool result — is kept, and the error carries a **Resume** button. Resume continues from the last
  completed step: your message is not sent again and the page is not re-inspected.
- Runs survive the side panel and the service worker. The conversation is saved after every
  completed step. Closing the panel mid-run no longer loses the rows it produced meanwhile, and a
  panel reopened mid-run shows the run in progress. If Chrome stops the service worker, the browser
  quits or the extension reloads mid-run, the chat says **This run was interrupted.** and offers
  the same Resume. Nothing resumes on its own.
- Chats are stored per site, several per site, named by the model after the first reply (you can
  rename, and your rename sticks), and archived rather than deleted.

### Mods, Tampermonkey compatibility, and import

- Mods are plain userscripts with a standard `==UserScript==` header — nothing proprietary, and
  exportable as `.user.js` at any time.
- The Tampermonkey-compatible surface: the `GM_*` and `GM.*` API, `@require` libraries,
  `@resource` files, `@connect` host restrictions, `@run-at`, and page-world scripts.
- Install from a URL or a file. Clicking a `.user.js` link anywhere is redirected to an install
  preview that shows what the script matches, what it is granted, and what it loads, before
  anything is saved.
- Import a whole Tampermonkey backup in one step, with each script's on/off state and its stored
  values.
- Saved mods are registered with `chrome.userScripts` so they run on their matching pages; the
  Mods view splits them by what matches the current site.

### Dashboard

- A full-tab dashboard — also the extension's options page — that is a home for every chat and
  every mod: search, bulk enable/disable, transcript previews, and an editor that follows the mod
  you are looking at.

### Chats, drafts and images

- Four keys of per-chat state (transcript, draft mod, attachments, and the run's own record) kept
  isolated per chat, so two conversations can never mix.

### Providers

- Bring your own model: Anthropic, OpenAI, xAI and OpenRouter with your own API key; Ollama, LM
  Studio, vLLM or `mlx_lm` running locally; or any endpoint that speaks the Anthropic Messages or
  OpenAI chat-completions protocol.
- **Connect several providers, and pick the model in the chat.** Settings → Providers is a list:
  add, rename, edit and remove connections, more than one of a kind, each with its own key or
  sign-in, Images setting, **Fetch models** and status line. The model is chosen from a dropdown
  under the message box that lists every connected provider's models (grouped, filterable, with
  **Refresh models** and **Manage providers…**, and a field that takes a model id for endpoints
  that cannot list theirs). The choice is per chat, survives reloads, and a new chat starts on the
  last model you picked. A profile from a build with a single provider is migrated into the list
  automatically, key and model included.
- **Swap models mid-conversation.** The next turn goes to the new model with the whole
  conversation converted for its protocol — tool calls, tool results, images and compaction
  summaries — and the transcript marks where the model changed. Another model's private reasoning
  is never replayed to a different model. A swap made while a run is in flight applies from the
  next turn, and the panel says so. Titles, compaction summaries and Resume all use the chat's
  model. If a chat's provider is removed or signed out, the chat says so and waits for you to pick
  another; it never falls back to a different provider on its own.
- **ChatGPT model list after sign-in.** Listing models on the ChatGPT backend answered 400 straight
  after a successful sign-in, because that backend requires a `client_version` query parameter.
  usermods now asks the way the open-source Codex CLI does, reads the catalog's slugs in its own
  order and leaves out hidden models. Any failed listing now shows the server's own message rather
  than a bare status, and a subscription provider whose listing fails offers a short built-in
  list, marked as such, so the picker is never empty.
- **Screenshots reach a vision model on every backend.** Chat completions cannot carry an image
  inside a tool result, so usermods puts a pointer in the tool output and attaches the picture to
  the user message immediately after it — the arrangement the Responses API backends already
  needed, and one every vision-capable OpenAI-compatible endpoint reads correctly. Previously the
  image was replaced by "[image omitted: this backend does not accept images in tool results]" on
  that adapter whatever the model could do, so a vision model behind a custom OpenAI endpoint was
  told its own screenshots were unavailable and fell back to guessing.
- An **Images** setting for OpenAI-compatible endpoints, because that preset is pointed at
  whatever you typed in and plenty of it has no vision. *Auto* (the default) sends images and, if
  the endpoint refuses because it cannot take a picture, sends that one request again without
  them, remembers the base URL and model, and leaves images out from then on — the panel says so
  once, and the model is told plainly so it checks results with `get_styles` and `find_elements`
  rather than taking screenshots that tell it nothing. *Always send* surfaces the refusal instead
  of working around it; *Never send* skips the one request it would otherwise take to find out.
  The detection is conservative — a bad key, a full context window or a rejected tool schema all
  arrive as the same 4xx and none of them mean the model is blind — and the fallback is a single
  immediate re-send rather than a retry, so it composes with the backoff policy instead of
  competing with it. User attachments follow the same rule, and the panel says when one was not
  sent.
- Screenshots are downscaled before they are sent: a capture comes back at the display's device
  pixel ratio, and is now brought to 1568px on its longest edge and re-encoded as JPEG, the same
  policy attachments follow. On a HiDPI laptop viewport that is about a third of the bytes, and
  more legible rather than less — the resize does the work the old quality setting was doing.
- ChatGPT and SuperGrok **subscription sign-in** (device-code OAuth) ships in the GitHub build
  only. The Chrome Web Store build omits it — see `lib/buildflags.ts` — and a subscription
  provider saved by the GitHub build is kept but marked unavailable there, and left out of the
  model picker.
- A first-run data notice that explains what is sent, where it goes, and what stays on the device,
  before the first message leaves.

### Design

- The BBS Underground brand: a pixel-art `u` mark rendered at every icon size from the owner's
  source artwork, with a build-time check that no output pixel is a colour the source does not
  contain.
- A banner-based design system applied to every surface, in first-class light and dark themes,
  with colour contrast asserted as a build gate rather than eyeballed.
- A living style guide page (`styleguide.html`) as the specimen the design docs are written
  against.
- A compact side-panel top bar that stays legible at the widths a side panel is actually dragged
  to (320–640 px).
- The side panel opens per tab by default, with a setting to make it per window instead.

### Testing harness

- A Playwright harness driving the real extension against a mock LLM: seventeen browser flows
  (`npm run smoke`) covering the chat loop, chats, per-chat isolation, history compaction, the
  dashboard, panel scope, themes, the top bar, `wait_for`, images, vision, the draft artifact,
  resume, the growing message box, and providers and model switching. The mock serves several
  "providers" on one port and records the endpoint and model of every request, so the models flow
  proves from the wire which model each turn went to. The vision flow is the only one that drives the real `screenshot` tool, and reads the
  wire both ways: that a capture arrives as an image part in the right message, and that a backend
  refusing images is detected once, worked around, explained, and not asked twice. The mock's
  request validator now enforces the tool-message adjacency rule as well, which is what makes the
  first of those assertions worth anything.
- A unit suite on the Node test runner (`npm test`) over the header parser, the GM API, providers,
  build flags and the agent's pure logic.
- Every screenshot in the README and the store listing is regenerated by script from the real
  extension, not mocked up by hand.

[0.1.0]: https://github.com/kballenegger/usermods/releases/tag/v0.1.0
