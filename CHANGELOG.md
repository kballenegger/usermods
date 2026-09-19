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
- ChatGPT and SuperGrok **subscription sign-in** (device-code OAuth) ships in the GitHub build
  only. The Chrome Web Store build omits it — see `lib/buildflags.ts` — and a profile saved with a
  subscription provider falls back cleanly when opened in a store build.
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

- A Playwright harness driving the real extension against a mock LLM: thirteen browser flows
  (`npm run smoke`) covering the chat loop, chats, per-chat isolation, history compaction, the
  dashboard, panel scope, themes, the top bar, `wait_for`, images and the draft artifact.
- A unit suite on the Node test runner (`npm test`) over the header parser, the GM API, providers,
  build flags and the agent's pure logic.
- Every screenshot in the README and the store listing is regenerated by script from the real
  extension, not mocked up by hand.

[0.1.0]: https://github.com/kballenegger/usermods/releases/tag/v0.1.0
