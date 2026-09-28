# How it works

What runs where, what the agent loop does, how drafts and compaction work, where everything is
stored, and the security properties that follow from it. The user-facing side of all this is in
[guide.md](guide.md); contributor setup and the file-by-file map are in
[CONTRIBUTING.md](../CONTRIBUTING.md).

- [How it works](#how-it-works)
- [Development and the test harness](#development-and-the-test-harness)
- [Security notes](#security-notes)

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

## Development and the test harness

For development, `npm run dev` starts WXT with hot reload and opens a Chrome profile with the extension loaded. `npm run typecheck` type-checks, and `npm test` runs the Node test suite, including Safari execution and security coverage (no browser or API key needed).

`npm run screenshots` regenerates the images in the README and [screenshots.md](screenshots.md), and `npm run smoke` runs the same flow headless as an end-to-end check of the chat loop. Both build the extension, load it into Playwright's Chromium, and drive the real side panel against `scripts/mock-llm.mjs` — a local server that plays scripted conversations over the OpenAI wire protocol, so neither needs an API key or a live model. The page-inspection tools run for real against live pages, and the smoke run asserts that the reply streams, that `get_page`, `find_elements` and `get_styles` all succeed, that the proposal card appears with the expected name and match pattern, and that saving it writes a userscript to storage. That reply is written in markdown, so the same run also asserts what reaching the DOM looks like: `<strong>`, nested `<ul>`, `<ol>`, `<pre><code>` with its language label, a `<table>` in its own scroller and a `<blockquote>`, with no literal `**` left anywhere and no heading larger than the panel's own title; that Copy on the code block writes exactly the code the model sent; and that the sanitiser held — no `<img>` element at all (the markdown image became a link), the `javascript:` link stripped of its href, the raw `<img>` tag gone from the source rather than showing as text, and ordinary links carrying `target="_blank"` with `rel="noopener noreferrer"`. A second scripted conversation covers the agent's guardrails: it makes four page reads in a row and then proposes an untested mod, and the smoke reads the mock's recorded requests back from `GET /__requests` to prove the read-budget nudge and the propose-time refusal actually reached the model. A third (`npm run smoke:wait`) drives every `wait_for` condition against a fixture page the mock server serves itself, where content arrives 800ms late, an element is revealed by editing a CSS rule and nothing else, the route changes by `pushState`, and a region mutates for 1.5s and then settles — asserting from the recorded requests that an already-true condition returned in under 100ms, that the style-only reveal was noticed promptly (which only the polling floor can do), that a deliberate timeout carried diagnostics and was not flagged as an error, and that Stop ends a 20-second wait within 500ms leaving no observer behind. A fourth (`npm run smoke:images`) covers attachments end to end: it pastes a generated PNG into the composer through a real `ClipboardEvent` carrying a `File`, drops a 6000×6000 one onto the transcript, checks it was downscaled rather than refused, watches an SVG be turned away with a note, removes one, sends, and then reads the mock's recorded requests to prove that exactly one `image_url` part reached the wire, as JPEG, at 1568×1568, *before* the text of its message and with its caption beside it — then opens the full-size overlay out of the chat's blob store, closes it on Escape and reloads the panel to confirm the thumbnail is still there. A fifth (`npm run smoke:vision`) is the only flow that drives the real `screenshot` tool, and reads the wire twice: against an ordinary mock it asserts the capture arrived as an `image_url` part in the user message *after* the `tool` message that answers the call — an arrangement the mock's validator now enforces the adjacency rules for, because only a real backend would otherwise catch it — and against a mock that answers 400 to any request carrying a picture, it asserts the run still finishes, that the refused request was re-sent immediately without the image, that the panel said why, and that not one later request carried an image. See the comments at the top of `scripts/screenshots.mjs` for how the panel page is driven in an ordinary tab standing in for the real panel — and, in the panel-scope flow, how the real panel is opened and observed instead.

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
The thinking flow (`npm run smoke:thinking`) covers the per-chat Thinking level: the mock records
the reasoning knob every request carried, so the flow proves that a chat left on Default sends no
reasoning field at all, that picking High puts `reasoning_effort: high` on the next turn's wire and
marks the transcript, that Off sends `none` rather than dropping the field, and that titles run at
the model's floor. It then stands up a backend that answers 400 to any request carrying the field —
in OpenAI's own wording, so the classifier has to recognise a real refusal — and asserts the turn
still finishes, that the refused request was re-sent once without the field, that the panel said
why, and that the next turn does not pay for the discovery again. Finally it reloads to check the
level survived, and points the connection at a model with no reasoning knob to check the row
disappears. `npm run smoke:composer` measures the growing message box in a real panel.
Backoff is shortened for the flow through a `chrome.storage.local` key (`debug:retryPolicy`), which
only the extension's own contexts can write.

The share flow (`npm run smoke:share`) and the banner flow (`npm run smoke:banner`) live in
`scripts/lib/share-flows.mjs`. Every request to GitHub, Greasy Fork and the gist raw host is
answered by a Playwright route — reconstructions of the signed-in gist and Greasy Fork forms
(`scripts/lib/share-fixtures.mjs`) and saved copies of real signed-out pages (`test/fixtures/pages`) —
and those hosts are mapped to "not found" in Chrome's resolver, so anything a route misses fails
instead of reaching the real site. A tab the extension opens starts navigating before Playwright
attaches to it, so the flows wrap the worker's `tabs.create` to open blank first; that is test
instrumentation only. The share flow proves the fill, the hint, the recorded gist with its
`@updateURL`/`@downloadURL`, Update gist with a bumped version, the clipboard fallback, the leak
check, a deleted gist, a sign-in wall and both Greasy Fork forms; the banner flow proves the banner
on a gist, a raw text page and a blob page, Install / Installed / Update, a remembered dismissal,
nothing in a frame, and the `.user.js` redirect for a gist raw URL.

The updates flow (`npm run smoke:updates`, `scripts/lib/update-flow.mjs`) has the mock serve a
newer copy of an installed script at `/__updates/tidy.user.js` (and its `.meta.js`) and answer the
safety-review prompt with a fixed verdict. It proves that the open-time check offers the update
without touching the mod, that a second open within a day fetches nothing, that the review screen
names a newly added `@connect` host, that "Check with the agent first" sent the mock exactly a system
and a user message holding the two sources and no page content, that Skip hides the version, and
that only "Install update" installs a later one.

## Security notes

- Page content that the model reads is untrusted. The system prompt tells the model to treat it as data, and every generated script is shown to you before it is saved. Read it.
- Scripts run in an isolated world: they see the DOM but not the page's JavaScript globals. Default `@match` is the current site only.
- Your API keys are stored in extension local storage, and each is sent only to the provider it belongs to. Removing a provider deletes its key.
- Updates are offered, never applied by a check (`lib/updates.ts`, `lib/updatecontroller.ts`): only the review screen's Install update installs, and only the exact text it showed (matched by hash). The optional safety review sends the model the two sources and the header changes, fenced as untrusted text; its verdict is advisory.
- Sharing to a gist or Greasy Fork holds no credential and sends nothing: `lib/sharecontroller.ts` opens the site's page in your tab, `lib/shareclient.ts` fills it, and the site's own button (which you press) submits it. A pre-share scan (`lib/leakscan.ts`) lists likely secrets first. The install banner (`lib/banner.ts`) reads the page it is on and nothing else, and never installs.

Found a vulnerability? Please report it privately through GitHub's **Report a vulnerability** button
rather than opening an issue. [SECURITY.md](../SECURITY.md) has the scope and what to expect.
