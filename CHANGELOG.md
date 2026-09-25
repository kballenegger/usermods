# Changelog

All notable changes to usermods are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Share a mod as a gist or on Greasy Fork, from your own tab

- **Export is a menu now**: Download .user.js, Copy to clipboard, Share as Gist (then Update gist),
  Publish on Greasy Fork (then Post new version on Greasy Fork). In the Mods tab, the phone's "more"
  sheet and the dashboard's rows; the dashboard's bulk Export zip is unchanged.
- **usermods never publishes anything itself.** It opens the site's own editor in a new tab of your
  signed-in browser, fills the form, and points at the site's save button with a small bubble; you
  press it. No OAuth, no token. On GitHub the gist editor is filled through its own editor API from
  the page (Chrome), GitHub's own file-drop handler, or a synthetic paste; if none takes, the script
  goes on the clipboard and the bubble says where to paste it and what to name the file.
- **Once saved, it is remembered**: the gist's always-latest raw link becomes the mod's
  `@updateURL`/`@downloadURL` and its install link (shown with Copy); Update gist bumps the patch
  version and replaces the file on the gist's edit page. A deleted gist offers "Share as a new gist".
  Greasy Fork's script page is remembered too, so the next share is a new version; Greasy Fork's
  header expectations are checked and `@license MIT` is added only if you tick it.
- **A leak check runs before every share**: keys (`sk-`, `xai-`, AWS, GitHub tokens), JWTs, Bearer
  tokens, hard-coded `apiKey = "…"`, private IPs and `.local`/`.internal`/`.ts.net` hosts,
  `localhost` ports. Findings are listed, masked, with Share anyway / Cancel. Local only.

### An install banner on pages that offer a userscript

- A gist with a `.user.js` file, a GitHub file page of one, a plain-text script the `.user.js`
  redirect does not catch, and Greasy Fork / OpenUserJS pages when an update is available get a slim
  dismissible bar: "usermods can install “…”" with Install, or Installed ✓, or Update to v…. Install
  opens the install page (preview first, nothing saved until you confirm). Dismissals are remembered
  per page. No network, top frame only, and on four hosts or a text document only.
- **The install page updates an installed script in place** (matched by download URL, or by `@name`
  and `@namespace`) instead of installing a second copy; its button says Update to v… or Reinstall.
- **Fixed: a GitHub file page ending in `.user.js` was hijacked by the install redirect** and the
  install page tried to preview GitHub's HTML. GitHub and GitLab "blob" pages now load as
  themselves (a second, higher-priority `allow` rule; the Safari watcher asks the same question),
  and the banner offers the script from the page's Raw link.

### The Mac app icon fills its frame on macOS 26

- **The macOS rasters are full-bleed squares now, not a 0.75 tile in a transparent margin.** macOS
  26 (Tahoe) clips every app icon to its own rounded-square container, the way iOS always has, so
  artwork carrying its own margin was simply centred inside the system frame with the Dock's grey
  showing around it. The tile colour goes to every edge, the artwork's pixel-art bevel is dropped on
  macOS because its transparent corners punched holes in the mask (iOS keeps it — its superellipse
  cuts further in), and the mark lands at 75% of the width from the artwork's own margins, with no
  scaling and therefore no small-size exception. `scripts/render-app-icon.mjs` now fails on a single
  transparent pixel in a macOS raster, and on a mark that drifts from that 75%.

### Safari: dismissing the popup no longer interrupts a run

From the owner: on iPhone and iPad the popup *is* the extension, and dismissing it is the normal way
to get back to the page you are changing — but doing it mid-run stalled the run. Safari suspends the
background shortly after the popup goes, and the next time you opened it the run was marked
interrupted and you were shown a **Resume** button for something you never stopped.

- **A keepalive that does not depend on the popup.** While a run is in flight for a tab, the
  background asks that tab's content script to open a named `runtime.connect` port and ping it every
  9 seconds; the port's existence is what holds the background up. This is the only mechanism with
  reported evidence behind it — Chrome's documented `getPlatformInfo`-on-a-timer trick is not
  honoured by Safari, because it is an API call and not an extension event. The sources (Apple
  Developer Forums threads [764594](https://developer.apple.com/forums/thread/764594),
  [758346](https://developer.apple.com/forums/thread/758346) and
  [757926](https://developer.apple.com/forums/thread/757926)) are cited in `lib/keepalive.ts` beside
  the code, with the numbers they report.
  - A tab that **navigates** mid-run keeps its run: the port drops with the old document and the new
    document's content script is asked as soon as it can answer. A port that drops for any other
    reason is reconnected by the page itself, 500 ms doubling to an 8 s ceiling, and never gives up.
  - A page whose **CSP or sandbox** blocks the content script holds no port, and that run falls back
    to the interrupted path exactly as before.
  - A tab **closed** under a run ends it with *"The tab this run was working on was closed, so the
    run stopped."* — there is nothing to resume, since every tool the run has is addressed to that
    tab.
  - **With no run in flight, nothing is open and nothing is pinged**, which is the battery promise
    and is asserted in `test/keepalive.test.ts`. A run that outlives its own limits drops its hold
    after 20 minutes rather than pinning the background awake forever.
  - **Chrome is unchanged**, including a byte-identical `manifest.json`: it keeps its timer, the port
    path is gated on the Safari engine, and no new manifest entry was needed on either target.
- **Automatic resume, on Safari only, as the safety net.** The port is a mitigation and not a
  guarantee — iOS can still kill the background under memory pressure, and nothing survives Safari
  being killed. So when Safari pauses the extension anyway, a run recorded as interrupted with no
  live session behind it now resumes itself **once**, on the next wake, and the transcript says
  **"Resumed after Safari paused the extension."** instead of showing a button. It never resumes a
  run the user **Stopped** (the intent is written to the run record before the abort, so it survives
  the worker that took it), never one that **failed** with an answer from the provider, never one
  that is already running, and never more than once — the count lives on the stored record, because
  the worker that has to respect the bound is not the worker that spent the attempt. A second
  failure gets the ordinary Resume button. Chrome keeps manual Resume.
- **Tested.** The state machine — acquire and release per run, one port per tab, the reconnect
  backoff, the ceiling, "no port without a run" — and every clause of the auto-resume rule are unit
  tested against injected fakes, with no browser. `npm run smoke`'s resume flow gained two sub-flows
  that kill the service worker over CDP with the Safari behaviour switched on, and prove the run
  resumes itself once with the note and no Resume button, continues from the checkpoint rather than
  re-running anything, and is not picked up at all when Stop was pressed first.
- **What only a device can prove**, stated plainly in [docs/safari.md](docs/safari.md): whether iOS
  actually honours an open port. That is a property of WebKit and of the iOS build in front of you,
  the forum reports are evidence rather than a spec, and Apple has marked this area fixed twice while
  developers kept reporting it broken. The manual steps are section 3b of
  [docs/qa-checklist.md](docs/qa-checklist.md).

### Sign-in errors say what the server said

A refused sign-in showed a bare status — "ChatGPT device-code request failed: 403" — while the body
of that 403 said exactly what had happened. The model-listing path has read the body for a while;
every sign-in step now does the same.

- **Every device-code step** — both vendors' usercode and token requests, the ChatGPT code exchange,
  and both token refreshes — reports the step, the status and the server's own message:
  *"ChatGPT sign-in failed (400): client_version is required"*. Every common shape is read: OAuth's
  `error_description`, OpenAI's and xAI's `{error:{message}}`, a bare `message` or `detail`, and
  plain text. An **HTML block page** (Cloudflare, a regional refusal) is reduced to its title
  sentence rather than discarded or poured into the panel, since for a sign-in that title is the most
  useful thing on screen. Capped at 300 characters, with anything shaped like a token, key or
  authorization code redacted before it is shown.
- **A 403 says what it usually means.** The owner hit one from Hong Kong and read it as a broken
  sign-in; it was the vendor's edge refusing the region. A 403 now adds *"A 403 here usually means
  the provider is not serving your region or network rather than a problem with your account. Try a
  VPN or a different network."* — hedged, because the code genuinely cannot tell a regional block
  from a blocked network. It rides on 403 alone, and ChatGPT's device-auth poll, where a 403 means
  "not approved yet", returns before it can ever be reached.
- The existing Safari **host-permission** classification is untouched: a request that never left the
  browser still names the host to allow and where to allow it.

### The side panel and the Mac popup: a one-row composer

From the owner, with a picture of the panel at 420px: "this UI is getting unwieldy. Clean it up,
the mobile compact UI is better, with the model controls hidden behind a drop-down since it's not
something we change often."

- **The composer is one row**, as it is on the phone: **+**, the message box, **Send**. The box
  starts at one line and grows with its text; Enter sends and Shift+Enter breaks the line, as
  before. **+** is a menu of Point at element, Attach image and New chat (a keyboard menu: arrows,
  Home/End, Escape). The one button on the right is Send, then **Queue** while a run is going and
  there is something typed, and **Stop** while there is not; the activity line carries its own
  Stop for the whole run, so typing never puts it out of reach. Reference and image chips still
  appear above the box when there are any. At 520px of composer the send button gains its word.
- **Everything about the model is behind one chip in the chat bar**, after the chat switcher:
  `claude-opus-5 ▾`, with the provider once the bar is 640px wide, and the Thinking level on it
  only when it is not Default (`claude-opus-5 · high`). It opens a dropdown over the transcript
  with the provider groups, the filter and typed-id field, the **Thinking** row under the models,
  and Refresh models and Manage providers…. Same keyboard and ARIA as before; Escape closes from
  anywhere inside it and returns focus to the chip. The chat bar is on screen whenever there is a
  page to act on, not only once a chat exists, so the chip always has a home.
- **The Thinking control lost its help sentence** ("Sets the reasoning effort. Off answers without
  a reasoning pass." and the five like it), everywhere: the dropdown, and the phone's Model sheet.
  The label and the level names are the explanation; the one tooltip on the row says what the
  scale is. What each provider does with it on the wire is in [docs/guide.md](docs/guide.md#how-much-the-model-thinks).
- The notes the composer still needs — a swap that waits for the next turn, a chat with no usable
  model — are one line above the box, only while true.
- **Measured** with `node scripts/screenshots.mjs --composer-height`, over a finished conversation
  with its draft panel and nothing typed, in an 820px panel: the composer went from **243, 205 and
  167px** at 320, 420 and 640px wide to **53px** at all three; everything under the transcript from
  305, 267 and 204px to 115, 115 and 90px; the transcript from 50.5%, 55.1% and 62.8% of the panel
  to 73.7%, 73.7% and 76.7%.
- The phone's compact shell is unchanged apart from the help sentence.

### Fixed, from user reports on the Chrome build

- **A deleted chat could come back.** Reported as "deleting it does nothing. It shows up again if I
  reopen the window later or visit the site?" The chat index was written by nine separate
  read-modify-write cycles over one storage key, none of them serialised. A delete that raced a
  background turn's activity write, or a proposal being noted on the index, was overwritten by a
  snapshot taken before the delete — putting the chat back, pointing at per-chat keys the delete had
  already removed. Separately, the panel's debounced transcript save and the background's
  detached-run writer could recreate a deleted chat's transcript after the fact. Every index writer
  now goes through one per-key queue, a delete wins over writes that were already in flight for that
  chat, and the panel drops its pending writes for a chat it is deleting rather than flushing them.
  Chat deletion, single and bulk, is the same as before from the outside; it now sticks.
- **The context budget field fought you while you typed it.** Reported as "You have a minimum default
  but when I'm editing, it enforces it so it's a bit tricky for me to change the context window
  limit." Settings applied the 10,000-token floor on every keystroke, so typing `50000` began with
  `5`, which became `10000` under the cursor. The floor is unchanged and now applies once, when you
  leave the field or press Enter. Escape abandons what you typed; an empty field asks for the
  default back; a number typed and then left by closing the panel is still saved. The help text
  names both the floor and the default.
- **A model with a small context window no longer ends the run.** Part of "it breaks in long
  sessions". The context budget is one number for every provider and defaults to 120,000 tokens,
  while compaction first runs at 70% of it — so a model with a 32k window was refused by its own
  provider long before anything shrank the conversation, and the turn died. usermods now recognises
  that refusal (across the phrasings OpenAI, Azure, Anthropic, llama.cpp, Ollama, vLLM, TGI and
  Gemini-compatible endpoints send), compacts the conversation, sends it once more, says so in the
  chat, and remembers a budget that fits for that connection and model so the next turn starts from
  it. Token rate limits and reply-length errors are deliberately not treated this way.
- **Running out of extension storage is no longer silent.** The other part of "it breaks in long
  sessions". Chrome caps extension storage at 10 MB, and one full-size attached image costs about
  1.5 MB of it — so a handful of images across a profile is the whole budget. Every save was
  fire-and-forget, so a chat that could no longer be written simply stopped being written while the
  conversation carried on on screen. A refused save now says so in the chat, and a warning appears
  once at 80% full, while there is still room to act. Attached images whose messages are no longer
  in the transcript are now actually deleted when the chat is opened — the cleanup existed but had
  never been wired to anything, so every such image stayed for the life of the chat.

No new permissions: the Chrome manifest is byte-for-byte unchanged.

### The model's replies are rendered as markdown

- **Replies are formatted instead of showing their punctuation.** Reported as "also need to render
  markdown better", with a screenshot of a reply reading `**bold**` with the asterisks still in it.
  Models write markdown whether or not they are asked to, and the transcript was showing it verbatim
  — so a snippet arrived as a wall of unindented prose and a table as a row of pipes. Assistant
  prose now renders paragraphs, bold, italic, strikethrough, inline code, fenced code blocks,
  ordered and nested lists, headings, blockquotes, GFM tables, links, horizontal rules and hard line
  breaks. The dashboard's stored-transcript preview renders the same way, so a chat reads the same
  live and afterwards. **Your own messages stay plain** — typing `*` still shows an asterisk — as do
  the model-written chat titles and tool summaries.
- **Fenced blocks name their language and have a Copy button.** The model usually shows a snippet
  before it proposes it, and copying it meant selecting text inside a transcript that was still
  growing. Code scrolls rather than wraps, so its indentation survives, and both it and a wide table
  scroll inside their own frame rather than moving the rest of the conversation.
- **Nothing in a reply is louder than the interface around it.** Headings are capped below the
  panel's own title size, bold uses the interface's one bold weight, and the pattern introduces no
  new colour: code sits on the inset well in the mono face, tables are drawn with the existing
  border tones, and both themes pass the contrast gate unchanged.
- **Formatting no longer flickers while a reply streams in.** Text arrives a few characters at a
  time, so a reply passes through moments with a half-typed `**` or an unclosed code fence. Those
  are completed before rendering while the row is still being written, so a snippet is a code block
  from its first character instead of appearing as a paragraph and then jumping into place.
- **A reply cannot make the panel fetch or run anything.** The text is written by a model, from
  whatever it read on the page, so it is treated as untrusted: embedded HTML is removed before
  parsing (code blocks and `` `<div>` `` spans excepted — that is the model naming an element),
  links are limited to `http`, `https` and `mailto` and open in a new tab, a `javascript:` or
  `data:` link keeps its text but stops being a link at all, and a markdown image is shown as a link
  rather than loaded — an image URL the model chose and the panel fetches is a tracking pixel.

### Thinking: how hard the model reasons, per chat

- **A Thinking level next to the model**, mapped onto each provider's own reasoning knob. The levels
  are Default, Off, Low, Medium, High and Max, and only the ones the chosen model accepts are shown
  — a model with no reasoning setting shows no row at all. It is per chat, like the model:
  remembered across reloads, a new chat starts on the last level picked, changing it applies from
  the next turn, and the transcript marks the spot (*thinking: high*). The dashboard's chat list and
  transcript preview show it beside the model.
- **Default sends nothing.** A chat nobody has touched makes byte-for-byte the request it made
  before, on every provider.
- **One scale over five wire formats**, each verified against current provider documentation:
  Claude's `output_config.effort` (a top-level sibling of `thinking`, not a field inside it) on
  models that take adaptive thinking, and `thinking.type: "enabled"` with `budget_tokens` on the
  older ones that reject an effort parameter; `reasoning.effort` on the Responses API for ChatGPT
  and SuperGrok; `reasoning_effort` on OpenAI-compatible chat/completions; and Qwen 3's
  `chat_template_kwargs: {enable_thinking}`. What a model cannot do is never offered: SuperGrok and
  the always-thinking Claude models have no Off, Grok's `-fast` and non-reasoning variants and
  ordinary chat models have no row.
- **Changing the level does not disturb Claude's prompt cache breakpoint.** The thinking fields are
  top-level siblings of `system`, so the cached system block and its `cache_control` marker are
  byte-identical at every level — asserted in the unit tests.
- **Titles and compaction summaries always run at the lowest level the model allows**, whatever the
  chat is set to: short mechanical calls the user did not ask for should not be billed at Max.
- **For servers nothing can guess**, each OpenAI-compatible provider gains a **Reasoning field**
  setting (Auto, `reasoning_effort`, `chat_template_kwargs: enable_thinking`, None) and a validated
  **Custom request fields** JSON box merged into every request. A server that answers 400 to the
  reasoning field has that one request re-sent without it, is remembered for that endpoint and
  model, and the panel says so — the same pattern as the Images fallback.

### Safari on iPhone and iPad

- **A content-first chat view on iPhone.** From a report on a real phone that the chat could not be
  seen for everything around it. The popup now keeps a slim top bar, the conversation and a one-row
  message box on screen, and puts the rest one tap away in bottom sheets: the chat's title opens
  this site's chats with New chat, Rename, Archive, Edit a mod… and Open dashboard; the model name
  beside it opens the model picker; **+** beside the message box holds Point at element, Attach
  image, Model and New chat; the menu button holds Chat, Mods, Settings, the dashboard and the
  theme. There is no bottom navigation any more. With a long chat on a 390x844 screen the
  conversation went from 300px to 693px, and from 32px to 349px with the keyboard up.
- The draft panel and the "Editing" line are one line above the message box, only while a draft
  exists (`Wider comments · v2 · editing`, with Save or Update on it). Tapping it opens the full
  draft: versions, diff, Try, Export, rename, roll back, Save as a new mod instead.
- The button beside the message box is Send, then Queue while a run is going and there is something
  typed, and Stop when there is not.
- Runs of three or more tool calls fold into one "N steps" line, which still shows a running step
  and counts failures. Proposal cards are shorter. Status notes can be dismissed.
- On the Mods view, a mod's Run once, Export, Update and Delete are behind a "more" button; the
  switch and Edit in chat stay on the card.
- **iPad: the popup opened as a tiny panel that could not be resized.** Safari on iPad sizes the
  popover from the page, as on a Mac, and the page had no size of its own there. It now opens at
  440 wide and 600 to 720 tall depending on the iPad, and fits itself to Split View and Slide Over.
- The Chrome side panel, the dashboard and the Mac popover are unchanged.

### Safari: subscription sign-in

- **ChatGPT and SuperGrok subscription sign-in are back in the Safari build.** They had been switched
  off for every Safari build rather than only for a storefront one. `npm run build:safari:store` is
  the variant without them, matching `npm run build:store` for Chrome.
- A sign-in in progress survives Safari: the code and its expiry are kept in storage, so reopening
  the popup (on iPhone, opening the vendor's page dismisses it) shows the same code still waiting
  for approval instead of a fresh sign-in button. The card has **Open … page**, **Copy code** and
  **Cancel**, and says that opening the page closes the panel.
- When Safari has not been allowed on the vendor's website, the sign-in says so, names the host and
  gives the path to the setting on each platform, instead of "Failed to fetch".
- On iPhone and iPad the card is laid out for a thumb: a large, selectable code, the primary action
  full width with the other two beneath it, and an error that wraps inside the card.
- The Mac build checks that the extension inside the finished app is the build that was staged.

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
- **Edit any installed mod in chat.** Every mod row — in the Mods tab and in the dashboard — has
  **Edit in chat**, which opens that mod as the chat's draft: the installed script is v1, **Update
  mod** writes changes back over the same mod (same id, same on/off state, same `GM_setValue`
  store), and the chat says which mod it is editing, in the draft panel, the chat switcher and the
  dashboard's chat list. **Save as a new mod instead** breaks the link and leaves the original
  installed and untouched.
  - It works on mods from anywhere: written in chat, installed from a URL, imported from a file, or
    migrated from a Tampermonkey backup, enabled or disabled, page-world or isolated. An imported
    script's `==UserScript==` block is kept whole and re-attached on save, so `@require`, `@grant`,
    `@connect`, `@run-at`, `@version` and the rest survive an edit the model made without seeing
    them; only the name, description and `@match` lines are rewritten.
  - Three ways in besides the mod row: a new chat lists the mods that run on the page as one-tap
    entries, **Edit a mod…** beside the chat switcher opens a picker of everything installed, and
    the model is told each turn which mods already run on the current URL and can adopt one with a
    new `open_mod` tool rather than writing a second mod that does the same job. Picking a mod never
    discards a chat's unsaved draft — it opens a new chat instead and says so.
- Saving a mod whose name and match patterns match one already installed asks whether to update that
  one or keep both, instead of silently leaving two scripts fighting over the same page.
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
- The "reconnected" note no longer overstates what was lost. Since the background keeps a run's
  transcript whenever no panel is attached, the only thing that can still go missing is a few rows
  on screen — streamed text, or a tool row's result — from the instant a panel page goes away. The
  note now appears only when a stored transcript shows that (a row still claiming to be in progress
  in a chat that is neither running nor interrupted), closes those rows, and says what is intact:
  the conversation the model sees, the draft and your saved mods. It is never shown for a run that
  is still going, which the old check got wrong for a chat started after the panel opened.
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

- A Playwright harness driving the real extension against a mock LLM: eighteen browser flows
  (`npm run smoke`) covering the chat loop, chats, per-chat isolation, history compaction, the
  dashboard, panel scope, themes, the top bar, `wait_for`, images, vision, the draft artifact,
  editing an installed mod, resume, the growing message box, and providers and model switching.
  The mock serves several "providers" on one port and records the endpoint and model of every
  request, so the models flow proves from the wire which model each turn went to. The vision flow
  is the only one that drives the real `screenshot` tool, and reads the
  wire both ways: that a capture arrives as an image part in the right message, and that a backend
  refusing images is detected once, worked around, explained, and not asked twice. The mock's
  request validator now enforces the tool-message adjacency rule as well, which is what makes the
  first of those assertions worth anything.
- A unit suite on the Node test runner (`npm test`) over the header parser, the GM API, providers,
  build flags and the agent's pure logic.
- Every screenshot in the README, [docs/screenshots.md](docs/screenshots.md) and the store listing is regenerated by script from the real
  extension, not mocked up by hand.

[0.1.0]: https://github.com/kballenegger/usermods/releases/tag/v0.1.0
