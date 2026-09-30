# Browser use in usermods

**Status: spec for the first version, revised 2026-09-30.** It replaces the discussion draft
(ce82405) after the owner's decisions of that day and the analysis of his real chat histories. It is
written against `store/resubmission-0.1.1` (9deeb7e) plus the three tool lanes, which are built and
not yet merged: `lane/run-results` (f355637), `lane/test-mod` (8cac8d6) and `lane/reads-budget`
(aa3d594). A fourth lane, the inspection upgrade, is about to be built. This spec assumes it exists,
does not re-specify it, and lists where it depends on it in [section 2.3](#lane-4).

Evidence is tagged where it matters:

- `[code]` read in this repository at 9deeb7e, with the file named
- `[lane]` read in one of the three lane branches above
- `[data]` from the analysis of the owner's chat histories ([section 1](#1-what-the-owners-chats-show))
- `[doc]` a document in this repository, named
- `[src]` an external source, linked under [Sources](#sources), fetched 2026-09-30
- `[inferred]` my reasoning from the above; plausible, not checked
- `[untested]` a platform behaviour nobody has run here; each one is a probe in [section 7](#probes)

Contents: [Decisions](#decisions) · [Still to decide](#still-to-decide) · [The plan](#the-plan-in-brief) ·
[1 The data](#1-what-the-owners-chats-show) · [2 Three uses](#2-three-uses) ·
[3 What is hard](#3-what-is-hard-without-trusted-input) · [4 Task profile](#4-the-task-profile) ·
[5 Interface](#5-the-interface) · [6 Build](#6-how-it-is-built-here) · [7 Evaluation](#7-evaluation) ·
[8 Phases](#8-phases) · [9 Open questions](#9-open-questions) · [Prior art](#prior-art) · [Sources](#sources)

---

## Decisions

Settled by the owner on 2026-09-30. The spec is built around them; they are not options.

| # | Decision | Where it lands |
|---|---|---|
| D1 | The first version does multi-step tasks on one site: click, type, wait, read, repeat, including across that site's own navigations. Operating the browser across sites is not in the first version | The task profile ([section 4](#4-the-task-profile)) is the plan, not a phase to be earned by measurements |
| D2 | No `debugger` permission. Synthetic input only, with an honest handoff to the user for a step that needs a real gesture | [Section 3](#3-what-is-hard-without-trusted-input), the `handoff` tool |
| D3 | The interface changes to be about both possibilities, not only mods ("our UI would need to change a bit to be focused on both possibilities and not just the mods aspect") | [Section 5](#5-the-interface) |
| D4 | His real chat histories may be read. They have been | [Section 1](#1-what-the-owners-chats-show) replaces the draft's phase 0 |

Decided in this spec as a consequence, and his to overrule:

- **Three uses are first-class:** change the page (a mod), do a task on this site, ask about or
  debug this page.
- **Ask and change share one kind of chat, and the model infers which. A task is its own kind of
  chat**, started by the user or offered by the model and accepted with one click. The reason is
  mediation, in [section 4.4](#44-one-way-to-act-per-chat). Open question 3.
- **One way to act per chat.** Typed `act` in a task chat, `run_script` in a page chat, never both.
  The draft's `page.*` helper library is not in the first version. Open question 9.
- **Every safety property is enforced by the extension**, in the background or the content script.
  None rests on the prompt or on the model.

## Still to decide

1. **Do the task tools ship in the Chrome Web Store build, or in the GitHub build only at first?**
   Recommended: GitHub only, behind a compile-time flag, until 0.1.1 is approved and phase 3 has
   numbers. The store build still gets the reshaped interface, with two uses instead of three
   ([section 5.8](#58-the-store-build-while-tasks-are-github-only)).
2. **How are consequential actions confirmed?** Recommended: the first of each named action asks,
   with "allow every one of these in this task" on the card; payment, password and one-time-code
   steps are never performed and are handed to the user.

The rest are in [section 9](#9-open-questions), most design-changing first.

## The plan in brief

1. **Ask first.** It is the cheapest of the three and the data asks for it: three of his fourteen
   chats wanted an answer and no mod. It needs a prompt that stops assuming a mod, lane 4's text
   reading, one diagnostics tool with no new permission, and an empty state that offers it.
2. **Tasks are a separate chat profile with a typed `act` tool**, the only kind of action the
   extension can name, confirm, refuse and journal. Refs live in a content-script registry, the
   gate in the background, and the journal is written before acting.
3. **The line is the site**: one host, one tab, attended. What synthetic input cannot do is said,
   and handed to the user as "your turn".
4. **The interface names three uses and shows three outcomes**: the proposal card for a mod, a
   facts-only "task ended" card for a task, plain prose for an answer.
5. **Helpers no longer come first.** The draft put a `page.*` library ahead of everything. In his
   data interaction was 17% of scripts, and what failed was navigation and results, not clicks.
6. **Measure what is still unknown**: tokens per run, weak models, Safari. The harness stays; the
   speculative phase 0 goes.

---

## 1. What the owner's chats show

The draft's phase 0 asked whether the model "makes do with injecting scripts over and over" because
it cannot see cheaply or because it cannot act reliably. The answer is now known. Fourteen chats,
19 to 28 September 2026, on gpt-6-astra (ChatGPT subscription), grok-4.6 and grok-4.7-build-fast
(SuperGrok), and earlier ones with no model recorded. Stored histories are post-compaction, so
every count is a floor (three `run_script` results were already elided). All of this section is
`[data]`.

Tool calls, 184 in all: `run_script` 119 (65%), `get_page` 20, `propose_mod` 20, `screenshot` 17,
`find_elements` 4, `get_styles` 2, `wait_for` 2.

| What the 119 `run_script` calls were | Calls | Median script | Median result |
|---|---|---|---|
| Pure inspection, reads only | 55 (46%) | 1,204 chars | 1,354 chars |
| Testing a change to the page | 43 (36%) | 1,834 chars | 254 chars |
| Interaction: click, type, scroll, navigate | 21 (17%) | 924 chars | 203 chars |

- **The inspection scripts are the same five shapes, rewritten every time**: find by text and walk
  up the ancestors to the container worth hiding; inventory the overlays, dialogs and fixed or
  sticky elements; measure several elements at once; verify a change stuck; read the page's text. A
  sixth, comparing two elements' attributes, is bespoke and a script is the right tool for it.
- Of 119 scripts, 106 call `querySelectorAll`, 99 read text, 62 measure boxes, 50 call
  `getComputedStyle`. Only 6 call `click()`, 4 dispatch synthetic events, 3 set a value, 0 touch a
  shadow root.
- Models wrote 207,408 characters of script (about 52,000 output tokens) and read back 120,685.
- **Silent loss**: 8 of 119 results (7%) hit the 4,000-character cap with no marker; 10 of 20
  `get_page` results were truncated, the largest at 59,662 characters.
- **What he asked for**: a mod in 9 chats; a mod that needed interaction to work out in 1 (Accor:
  open the currency selector, choose, survive the site's reload, check prices, a hover menu);
  **an answer and no mod in 3** ("what does the policy mean in simple language", "figure out why
  this link isn't loading", "page shows Something went wrong, figure out the root cause"); a hello
  in 1.
- **Interaction** was 21 scripts (Accor, Substack, GitHub, X, Facebook), always serving a mod or a
  diagnosis on one site, never cross-site. On Accor three of seven came back with no usable result: a timeout, a
  navigation under the run, no return value.
- **Friction**: the read-budget nudge ("Act now: test with run_script") fired in a chat that was
  diagnosing a link, not building anything. He asked "are you stuck?" twice after 15 tool calls
  with nothing visible. The step limit fired once, after 33 tool calls. `then_wait` was used 7
  times: one rejected, one timed out, one lost to a navigation.

### What this settles

- **The hunch is right, and the cause is seeing, not acting.** By the draft's own threshold (half
  or more inspection means an observation problem; a third or more acting means an actuator
  problem), 46% against 17% points at the reads. That is lane 4's job, and lanes 1 and 3 already
  remove the silent truncation.
- **Helpers are not justified by his data.** Click, event and value code appear in at most 13
  scripts of 119. The Accor failures were a timeout, a navigation and a missing return value, which
  `lane/run-results` and `then_wait` address, not an event-sequence library.
- **A third use exists and has no support.** A fifth of the chats wanted an answer.
- **The line at the site costs nothing he does today.**

### What it does not settle

- **Whether he wants tasks.** None of the fourteen chats was a task. The prompt told the model
  "requests are about changing the page, not operating it" `[code: lib/agent/prompt.ts]` and the
  composer asked "What should this page do differently?", so absence is not evidence. D1 rests on
  his judgement, and there is no real-usage baseline for tasks: the fixtures and his first task
  chats are the evidence.
- **Tokens.** Usage is not recorded anywhere `[code: no usage fields in lib/providers, lib/agent]`.
- **Weak models.** Every transcript is from a frontier subscription model.
- **Safari.** Nothing in the analysis is from the Safari engine.

---

## 2. Three uses

| | Change it | Do a task | Ask about it |
|---|---|---|---|
| The user wants | The page different on every visit | Something done on this site, once | Something explained, found or diagnosed |
| The outcome | A saved mod | Actions taken on the page, and a report | An answer |
| What the panel shows at the end | The proposal card, with how it was tested `[lane: test-mod]` | A "task ended" card holding facts the extension recorded | Prose, and the element shown on the page when the answer is a place |
| Chat kind | Page chat | Task chat | Page chat |
| Acts through | `run_script`, as today | `act`, mediated | Nothing; `run_script` only to look |
| Builds | Both | GitHub first (open question 1) | Both |
| Cost to do well | Already paid: lanes 1 to 4 | The most: sections 4 to 6 | The least: one tool, one prompt section |

| # | Request | Use | With lanes 1 to 4, where it still fails | First version |
|---|---|---|---|---|
| 0 | Drive the page to test a mod: open the modal it changes, trigger the route change it must survive | Change | Hand-written clicks; on Accor 3 of 7 lost their result `[data]` | Page chat, `run_script` with `then_wait`. Unchanged. Revisit with helpers only if phase 2 says so |
| 1 | Open every carousel and collect the image URLs | Task | Carousels that advance on `pointerdown` | `act` with `repeat`, links and images listed with their URLs by `observe` |
| 2 | Expand all the comments | Task | One model step per click against a 30-step turn `[code: lib/agent/budget.ts]` | `act` with `repeat` until none is left |
| 3 | Fill this form from my notes | Task | Controlled inputs, custom listboxes, date pickers ([section 3.1](#31-synthetic-versus-trusted-input)) | `act` fill; the submit is confirmed |
| 4 | Go through my order history and total it | Task | 30 steps; the running total lives only in a conversation that compaction can summarise away `[code: lib/agent/compact.ts]` | `navigate`, `note`, a 60-step task |
| 5 | Unsubscribe from each of these | Task, consequential | Nothing gates the clicks, and the content is written by strangers | Confirmed by name, once for the batch |
| 6 | Archive these 40 threads; delete my old gists | Task, destructive | As 5, and not undoable | As 5; the card says the count |
| 7 | What does this policy mean; where do I cancel; why won't this load | Ask | Text read in 4,000-character bites by script; no view of failed requests or errors; a nudge telling it to test `[data]` | Lane 4's text mode, `diagnose_page`, `show_element` |
| 8 | Find the cheapest of these across three shops | Out | A run is bound to one tab and a chat to one host `[code: lib/sessions.ts, entrypoints/sidepanel/App.tsx]` | No (D1) |
| 9 | Anything behind a login, 2FA, a captcha, a purchase | Out | By design | Handed to the user |
| 10 | Tell me when the price drops | Out | No background runs | It is a mod: an interval and a notification |

### The line

One host, one tab, attended. Reasons, unchanged from the draft and now decided:

1. **It is what a userscript manager plausibly is.** A page task is a script run once. Cross-site
   operation is a browser agent, a different product with a different single purpose.
2. **The strongest cross-site agents have what usermods cannot have**: trusted input, models
   trained against injection, server-side classifiers. Their vendors still say "No browser agent is
   immune to prompt injection" `[src: Anthropic 2025-11]` and that it is "unlikely to ever be fully
   'solved'" `[src: OpenAI]`. usermods runs whatever model the user connected.
3. **There is a better ending here than anywhere else**: a task that worked can later become a
   saved mod that replays it without a model (phase 5).

One fact to keep in view: **`run_script` is already an ungated actuator.** `executeTool` runs the
model's code with no check between the model and the page `[code: lib/agent/loop.ts]`. What keeps
it safe today is the prompt, a short run and the user watching. Tasks do not introduce acting on
the page; they multiply how much untrusted content the model reads while able to act. That is why
a task chat does not get a free `run_script`.

### 2.1 Change it: build a mod

Nothing new is specified here. Lanes 1 to 3 built honest `run_script` results with named DOM
changes and late callback errors, `test_mod` with the card saying how the code was tested, and
reads charged by size `[lane]`. Lane 4 removes the reason for 46% of the scripts. What this spec
changes for mod building is the chat around it: the empty state, the prompt's first line, and the
offer to move a one-off request into a task chat instead of doing it with an ungated script.

### 2.2 Do a task on this site

[Section 4](#4-the-task-profile) is the tool profile and its controls. [Section 5](#5-the-interface)
is what the user sees.

### 2.3 Ask about or debug this page

No mod and no actions: explain, find, diagnose. It is the cheapest of the three to do well because
it needs no gate, no grant, no journal and no new chat kind. It needs four things.

**1. Reading text well.** He had a terms page read in two 4,000-character bites by hand-written
script `[data]`. This is lane 4's text mode on `get_page`. The spec depends on it returning
readable text with headings, lists and link targets kept, under a character budget, **with a way
to continue** where it stopped. If lane 4 ships without a continuation, add an `offset` here.

**2. Showing where.** "Where do I cancel" has a place for an answer. One new tool,
`show_element { selector?, text?, label }`, scrolls the element into view and flashes it, using the
same targeting as `find_elements` and the same flash as the task indicator
([section 5.6](#56-on-the-page)). It changes the user's view, not the page's state, so it needs no
grant.

**3. Seeing what went wrong, without `debugger`.** One new read tool,
`diagnose_page { reload?: boolean }`. It reports failed and slow requests, script errors and
blocked resources for the current document; with `reload: true` it arms its recorders for the
tab's next load, reloads, and reports the whole load. The arming mechanism is the one `test_mod`
uses for a fresh-load test `[lane: test-mod, lib/exec/testrun.ts]`.

| Tier | Source | Gives | Cost |
|---|---|---|---|
| A. First version, both builds, both engines | Resource and navigation timing in the page: `performance.getEntriesByType` | Every request the document made since load, up to the buffer (250 by default `[inferred]`): URL, initiator type, duration, sizes, and the status code where the engine reports one `[untested on Safari]`. The X chat already used it by hand, to look for what a blocker was stopping `[data]`. What a request blocked by another extension looks like here is `[untested]` | None |
| | Capture-phase `error` events on `window`, from the content script | Images, scripts, stylesheets and frames that failed to load, from the moment the listener is installed `[inferred: DOM events are shared between worlds]` | None |
| | `securitypolicyviolation` events | What the page's CSP refused: the blocked URL and the directive | None |
| | A recorder in the page's own world: `error`, `unhandledrejection`, `console.error` and `console.warn` | The page's script errors with message and stack. The lane review found that a listener in the USER_SCRIPT world sees that world's own timer, observer and listener errors, attributable per run by `//# sourceURL` `[lane: run-results]`; whether an isolated-world listener also sees the page's errors is `[untested]`, and I expect not, which is why the recorder goes in the MAIN world. Chrome can inject there (MAIN-world mods already run `[code: lib/exec/adapter.ts]`); Safari is `[untested]` | None. Only errors after the recorder is installed, hence `reload` |
| B. Later, Chrome only | `chrome.webRequest`, observation only, filtered to the tab for the length of a run | Every request including ones that leave no timing entry: method, type, status code, `fromCache`, server IP, initiator, and on failure `onErrorOccurred`'s error string, which is how a request blocked by the client would be named. That string "is not guaranteed to remain backwards compatible" `[src: chrome.webRequest]`, so it is shown to the model verbatim and never branched on. Whether the event fires for a request another extension blocked is `[untested]` | The `webRequest` permission. It shows no install warning of its own `[src: permissions list]` and is not among the permissions that cannot be optional `[src: chrome.permissions]`, so it can be requested from a click in the panel the first time a diagnosis wants it, with no effect on anyone who never asks. The store cost is a justification on the privacy tab and a request that reads as network monitoring, on a listing that was rejected once and whose last release was about asking for less (commits f37f6ee, 2082198). Safari refuses `webRequest` listeners from a non-persistent background, which is every MV3 background and every iOS one `[src: Apple forums, search summary]` |
| Never, without `debugger` | | Response bodies. Request bodies (available, and not wanted). The DevTools console as such: messages logged before the recorder existed, and the browser's own explanations (CORS, mixed content). Detail of errors in cross-origin scripts, which the page sees only as "Script error.". Anything inside a cross-origin frame. Which extension blocked a request. WebSocket frames. Performance traces | |

The prompt must tell the model to say what it could not see, in those words. Tier B is open
question 7.

**4. A chat that does not push toward a mod.** The system prompt opens "You are usermods, a
userscript builder … Your job is to write a small script" `[code: lib/agent/prompt.ts]`. It
becomes a page assistant with three jobs and gains a short section for questions: answer from the
page, do not propose a mod unless asked, start a diagnosis with `diagnose_page`, say what is not
visible. And the read-budget nudge must not tell a debugging chat to "test with run_script", which
is lane 4's.

<a id="lane-4"></a>**Where this spec depends on lane 4**: `get_page`'s text mode is the reading
tool above and the implementation behind `observe`'s text mode; `show_element` takes
`find_elements`' selector-or-text targeting; the nudge wording is per use; and phase 1's exit
criterion is measured after lane 4 has landed.

---

## 3. What is hard without trusted input

D2 is settled, so this section is no longer an argument. It is the list of what the first version
cannot do and hands to the user. For the record, what `debugger` would have cost: two install
warnings ("Access the page debugger backend", "Read and change all your data on all websites"
`[src: permissions list]`); it cannot be optional `[src: chrome.permissions]`, so an update adding
it disables existing installs until re-approved `[inferred]`; Chrome's "started debugging this
browser" bar while attached `[src]`; and nothing on Safari.

### 3.1 Synthetic versus trusted input

Everything usermods dispatches has `event.isTrusted` false. The cost depends on the widget.

| Interaction | Synthetic route | Works on | Fails on |
|---|---|---|---|
| Click | `el.click()` runs the activation behaviour (links navigate, checkboxes toggle, submit buttons submit) | Native controls; handlers on `click`, React's `onClick` included `[inferred]` | Handlers on `pointerdown`/`mousedown` (many menu libraries): needs the full pointer sequence with coordinates. Handlers that check `isTrusted`: nothing helps |
| Hover | Dispatch `pointerover`/`mouseover`/`mouseenter` | JS-driven menus | Pure CSS `:hover`. Some such menus also open on `:focus-within` |
| Text into `<input>`/`<textarea>` | The prototype's native `value` setter, then `input` and `change` | Controlled inputs in the major frameworks; already in `[code: lib/sharefill.ts]` | Fields that build their value from `keydown`/`beforeinput` (masked inputs, some OTP boxes) |
| Text into rich editors | A ladder: the editor's own API, the site's own event, a synthetic `paste`, `execCommand('insertText')` | The gist editor, by this ladder `[code: lib/sharefill.ts]` | Canvas-rendered editors; editors that check `isTrusted` |
| Keys | Untrusted `keydown`/`keyup` reach listeners but produce no default action `[inferred]` | Listener-driven shortcuts | Native defaults. Emulate two: Enter in a form field calls `form.requestSubmit()`, Tab focuses the next tabbable |
| Native `<select>` | Set `value`, fire `input` and `change` | All | Custom listboxes are click sequences |
| Scroll | `scrollIntoView`, `scrollTo`: real scrolling | Lazy loading by IntersectionObserver | Wheel or touch-gesture handlers |
| File input | `input.files = dataTransfer.files` `[untested]` | | The native picker cannot be opened |

The action code does the full sequence (scroll into view, check what is under the point, pointer
events with coordinates, focus, click), which removes the avoidable failures. The unavoidable ones
become a handoff.

### 3.2 User activation, and focus

Transient activation is granted only by a trusted `keydown`, `mousedown`, `pointerdown`,
`pointerup` or `touchend` `[src: MDN User activation]`. A synthetic click therefore cannot make a
site's own handler succeed at clipboard access, `window.open` past the popup blocker, fullscreen,
`showPicker()`, file pickers, Web Share or `PaymentRequest`. "Copy" buttons, "open in new window",
fullscreen and native pickers fail silently. Whether a run started by a real click in the panel
carries activation into the page is `[untested]` (probe P-d); if it does, a confirmed step gets
activation for free.

While the user types in the panel, the panel's document has focus and the page's does not. Whether
`el.focus()` fires focus events, whether `:focus` styles apply, whether `execCommand` acts on the
page's selection and whether `navigator.clipboard` rejects are each `[untested]` (P-a), and decide
how much of the typing ladder works.

### 3.3 Navigation

What holds today `[code]`: a run whose page navigated is reported as `navigated`, not as a
timeout; `then_wait` with `url` or `load` makes that the expected first half of a step; those
waits are watched from the background because the navigation destroys the content script, which is
re-injected on the way out (`lib/agent/loop.ts`, `entrypoints/background.ts`).

What the lane review established: **`chrome.tabs.onUpdated` fires `status: 'loading'` for
`history.pushState` as well as for a real navigation** `[lane: run-results, f355637]`. "The page
navigated" cannot be read off that event. So:

- **A document has an identity.** The content script makes a random `docId` when it starts. A real
  navigation is a new `docId`; a route change is a new URL under the same one.
- **Refs carry it** ([section 4.3](#43-refs-without-cdp)), so a ref from before a real navigation
  can never resolve on the new page, and a ref survives a route change if its element did.
- **The site boundary is judged on the URL** from `tabs.onUpdated`, which is right for both kinds.

Still open: a link with `target=_blank` or a `window.open` takes the task where the run cannot
follow, since `Session.tabId` "does not move mid-run" `[code: lib/sessions.ts]`. The click action
retargets `_blank` links to `_self`. And the panel shows the chat for the active tab's host
`[code: entrypoints/sidepanel/App.tsx]`, so a task that leaves its host would keep running in a
chat the panel no longer shows; [section 5.5](#55-a-task-chat) pins it.

### 3.4 Frames and shadow DOM

- The content script runs in the top frame only, and `run_script` targets `{ tabId }` with no
  frame `[code: entrypoints/content.ts]`. Same-origin frames are reachable through
  `contentDocument` `[inferred]`. Cross-origin frames (payment fields, captchas, embedded editors,
  many consent dialogs) need the content script in every frame and routing by `frameId`: phase 5.
- Open shadow roots are walked by the snapshot, with a fallback added in `[lane: reads-budget]`;
  the action code resolves targets across them. Closed roots:
  `chrome.dom.openOrClosedShadowRoot` on Chrome `[untested]`, nothing on Safari.

### 3.5 The service worker, and a run that acts

- Chrome holds the worker with a trivial API call every 20 s during a run, checkpoints the
  conversation after every completed step, and offers Resume for an interrupted run `[code, doc]`.
  Safari holds a port from the page, with a 20-minute ceiling and **one automatic resume**
  `[code: lib/keepalive.ts]`.
- A checkpoint is written after a step's results are in. If the worker dies after an action ran
  and before its result was saved, `trimUnanswered` drops the unanswered call, the resumed model
  sees a history in which the click never happened, and it clicks again
  `[inferred from code: lib/agent/loop.ts]`. For a task that is a double submit. tabagent's
  invariant is the right one: "No mutating tool is ever auto-replayed on resume"
  `[doc: docs/research/tabagent.md]`. Hence the journal in [section 4.5](#45-the-controls).
- `AgentEnv.runScript(code)` takes no abort signal `[code]`, so a running script cannot be stopped
  mid-run. `act` is packaged code and checks a cancel flag between repeats.

### 3.6 Safari and the iPhone

- `run_script` on Safari is `new Function` in a declared content script, and a page's CSP can
  refuse it `[code: lib/exec/engine.ts, evaluate.ts]`. `act` and `observe` are packaged
  content-script code with no such limit, so on Safari a task works on pages where `run_script`
  cannot.
- On iPhone the popup is the whole interface and it covers the page `[doc: docs/safari.md]`. The
  user cannot watch and approve at once, so confirmation and Stop move onto the page
  ([section 5.6](#56-on-the-page)). Whether the covered page runs `requestAnimationFrame` and
  IntersectionObserver at full rate, and what `captureVisibleTab` returns under the popup, are
  `[untested]` (P-e).

### 3.7 Token cost

- `get_page` is 20,000 characters by default and up to 60,000 `[code]`; a screenshot is 1,000 to
  1,800 input tokens on Claude `[src: computer use docs]`; a budget can be as low as 8,000 tokens
  after an overflow (`MIN_NARROWED_BUDGET`) `[code]`. A ten-step task that re-reads the page each
  step does not fit, so an action returns a **delta**, not a snapshot. Chrome DevTools MCP made the
  post-action snapshot opt-in `[src]`.
- Output tokens are the slow ones on a local model. One `act` call against the 924 characters of a
  median interaction script `[data]` is a real difference per step.
- Tool schemas sit in the cached prefix on providers that cache `[inferred]`, so a separate profile
  with its own short list costs less than its token count suggests, and far less than one list
  holding both profiles' tools.

---

## 4. The task profile

A task chat has its own tool list, prompt and budget. The list is swapped, not extended.

### 4.1 Tools

| Tool | Input | Notes |
|---|---|---|
| `observe` | `scope?` (ref or selector), `mode?: interactive \| text`, `max_chars?` | The interactive-elements view with refs. `text` is lane 4's readable text for a region |
| `act` | `ref`, `action: click \| fill \| select \| check \| press \| hover \| scroll_to`, `text?`, `repeat?`, `description`, `then_wait?` | One consolidated tool, not six. `description` is shown to the user beside what the extension itself read from the element. `repeat: n` (click only, at most 50) finds the element with the same role and name again after each click and stops when none is left. Returns a delta |
| `navigate` | `to: back \| forward \| reload \| url`, `url?` | This host only. Anything else is refused with a reason |
| `wait_for` | unchanged | |
| `screenshot` | unchanged | Verification only |
| `note` | `set?`, `append?` | A run-scoped scratchpad re-attached to every turn, as the draft block is `[code: lib/agent/loop.ts]`, so collected data survives compaction and navigation |
| `handoff` | `request`, `until?` (a wait condition) | Ends the step with "your turn" and highlights the element the user should use |
| `run_script` | unchanged shape | For reading what `observe` cannot express. Confirmed per call, with its code shown ([section 4.5](#45-the-controls)) |

Eight tools. Not here: `propose_mod`, `open_mod`, `test_mod`, `get_page`, `find_elements`,
`get_styles`, `diagnose_page`, `show_element`. The page profile keeps today's tools and gains
`diagnose_page`, `show_element` and, in a build with tasks, `offer_task`
([section 5.3](#53-how-a-chat-starts)).

### 4.2 The view, and the delta

Lines in the Playwright-MCP shape, because models already read it `[src]`:

```
- heading "Order history" [level=1]
- navigation "Pagination"
  - link "Next page" [ref=d3e14] → /orders?page=2
- table "Orders"
  - row "12 Sep · Headphones · €89.00"
    - link "View order" [ref=d3e21] → /orders/1182
    - button "Buy again" [ref=d3e22]
- textbox "Search orders" [ref=d3e9] value=""
… 38 more interactive elements below the fold: observe with scope, or scroll
```

Interactive means native controls and links, elements with an interactive ARIA role,
`contenteditable`, `tabindex >= 0`, and `cursor: pointer` as a last resort. Role and name are
computed in the page by heuristic (`aria-label`, `aria-labelledby`, `<label>`, `alt`, `title`,
`placeholder`, text); no accessibility tree is available to a content script `[inferred]`. State
comes from the `aria-*` state attributes the snapshot now reads `[lane: reads-budget]`. Links and
images carry their URL. Password values are never emitted. Viewport first, about 6,000 characters
by default.

What `act` returns builds on the named DOM changes of `[lane: run-results, lib/runscript.ts]`:

```
Clicked button "Show more replies" (d3e31), 12 times; none left.
DOM: 0 removed, 120 added (div.reply ×120). URL unchanged.
New: link "permalink" ×120, button "Reply" ×120. observe to get refs.
```

### 4.3 Refs without CDP

- A registry in the page content script: `Map<ref, WeakRef<Element>>` and a reverse
  `WeakMap<Element, ref>`. An element keeps its ref across `observe` calls. Nothing is written
  into the page's DOM. tabagent does exactly this `[doc: docs/research/tabagent.md]`.
- A ref names its document (`d3e14`, where `d3` stands for the `docId` of section 3.3). The
  registry dies with its document, which is the invalidation rule for real navigations, and
  survives a `pushState`.
- Re-renders: when a ref's element is no longer connected, try once to re-resolve it from the
  fingerprint stored at observe time (role, name, tag, stable attributes, ancestor landmark,
  ordinal). Exactly one connected match rebinds, and the result says so. None or several is an
  error that names the element and asks for a fresh `observe`. browser-use's "super-selectors" are
  the same idea with CDP node ids added `[src]`.
- The registry and the action code live in the **content script's** isolated world. Events
  dispatched from there reach the page's listeners `[code comment: lib/sharefill.ts]`. So `act`
  and `observe` need neither `userScripts` nor the "Allow User Scripts" toggle, and run the same
  on Safari.
- The first version covers the top frame, same-origin frames and open shadow roots.

### 4.4 One way to act per chat

Two ways to click is a weak-model trap, so the rule is structural and not advice in a prompt:

| Chat | Acts through | Why |
|---|---|---|
| Page chat (change, ask) | `run_script`, hand-written DOM code, as today | The model is writing a script anyway, and the interaction is set-up or measurement inside it: click a row then measure it, press Retry while recording resource timing, scroll while an observer watches `[data]`. A typed action cannot share a tick with a measurement. There is no `act` tool in this chat |
| Task chat | `act` | It is the only action the extension can name, confirm, refuse and journal. `run_script` is present for reading only, is confirmed per call, and the prompt says not to click from it |

**Why a task is its own chat rather than a capability switched on in any chat.** Mediation is only
real where `run_script` is gated, and a chat that builds mods cannot gate `run_script`: 43 of his
scripts were tests of a change `[data]`, and a confirmation on each would end mod building. A chat
holding both profiles' tools would also carry fifteen of them, and its typed actions would be
decoration, because an injected model would use the script. Tools cannot be removed from a chat
once used, since calls to a missing tool in the history are rejected by several backends
`[code comment: lib/agent/tools.ts]`, so the kind is fixed when the chat's first message is sent.

**The `page.*` helper library.** The draft recommended it first. Revised: it is not in the first
version, and it is never in a task chat. Its only possible home is the page chat, as a shorter way
to write the interaction in row 0 of section 2. Whether it earns the roughly 250 prompt tokens
`[inferred]` it costs every page chat is a question for phase 2's baseline: build it (phase 5) only
if interaction scripts in page chats fail for mechanical reasons (event sequences, waits,
controlled inputs) on the fixtures or in his chats. The action code is written once in
`lib/interact` either way, so exposing it later is a small step. If it ships, the rule the model is
given stays one line per profile: in a page chat, `page.click(…)` inside `run_script`; in a task
chat, `act`; no chat has both.

### 4.5 The controls

The threat is text on the page, written by someone else, that the model follows: a review, a
seller name, an email body, an `aria-label`, an image `alt`. With an actuator in the user's
logged-in session that is private data, untrusted content and a way to act, all at once.

- **The model is not a defence.** Anthropic reports 1% attack success for its best model against
  an adaptive attacker and calls that "meaningful risk" `[src]`. A small local model has no such
  training. The prompt's three lines under Safety `[code: lib/agent/prompt.ts]` are a request.
- **`run_script` cannot be policed.** Static checks on model-written JavaScript are heuristics an
  injected model can write around, and a script can send data out with an image request.
- **So the rules live in the background, over typed actions**, where page content cannot reach.

How one `act` runs: the loop asks the content script to `describe` the ref (role, name, tag, form
facts, link target, fingerprint); `lib/agent/gate.ts` decides `allow`, `confirm` or `deny` from
that description, never from the model's `description`; the journal entry is written; a
confirmation, if needed, waits for the user; then `act` is sent with the fingerprint, and the
content script refuses if the element no longer matches it.

| Control | Rule | Enforced where | Holds against an injected model? |
|---|---|---|---|
| Site boundary | A task stays on the host it started on. A URL on another host pauses the run. "Continue here" is offered only when the two hosts share their last two labels (`www.` to `account.`), is the user's choice each time, and lasts for that task. No public-suffix list is needed because nothing is allowed automatically | Background, on the tab's URL | Yes |
| Grant | Acting needs the user to have started this task on this site, or a standing grant for the site. Reading does not | Background, before `act` | Yes |
| Consequential actions | Always confirmed: a submit; a target or link whose name or URL path matches send, post, pay, buy, order, delete, remove, cancel, unsubscribe, confirm; a `navigate` to a URL that was neither seen as a link in this task nor typed by the user. A `repeat` confirms once, with the count. How the confirmation repeats is open question 2 | Background policy over what the content script read | Yes |
| Never | Typing into password, one-time-code or card fields; submitting a form that holds one; any action on a browser or extension page | Content-script action code | Yes |
| `run_script` in a task | Shown as code and confirmed per call, unless the user allows scripts for this task | Background | It is the user's informed choice |
| Journal | `RunRecord.pendingAct` is written before an action runs and cleared with its result. On resume the model is told the action may or may not have happened and must observe first. Safari's automatic resume does not fire over a pending action | Background, `lib/runstate.ts` | Yes |
| Indicator | A bar on the page while a task holds the tab, and a flash on each target before it is acted on. If the page removes the bar and it cannot be restored, the run pauses | Content script, shadow root, as `[code: lib/pageui.ts]` | It is for the human |
| Watching | The run pauses when the tab stops being the active tab of its window, and continues when it is active again | Background, `tabs.onActivated` | Yes |
| Hard stop | Stop in the panel and on the page bar (trusted clicks only), and a step and time ceiling that pauses the run | Background; cancel reaches the action code by message | Yes |
| Handoff | Login, 2FA, captcha, anything in the Never row, anything section 3 says synthetic input cannot do: the run waits with a request | A tool that ends the step | n/a |
| The task's words | A task chat's first message is the user's own text, verbatim, even when the model offered the task. The model cannot write a task's instructions | Background, when the chat is created | Yes |

Logins, 2FA and captchas are not automated. Claude Code's Chrome integration does the same: "When
Claude encounters a login page or CAPTCHA, it pauses and asks you to handle it manually" `[src]`.
usermods holds no credentials and must not start.

**The honest residual.** Within the site and the grant, an injected model can still do the wrong
*unflagged* thing (click the wrong ordinary button), and with scripts allowed it can do anything
the page can. The controls make the consequential paths need a human. They do not make the model
trustworthy, and the start card says so in its own words.

---

## 5. The interface

Everything below uses the components and role tokens of `docs/design.md` as they stand, in the BBS
Underground identity of `docs/branding.md`. It adds no colour, no shadow and no use of the display
face. The rules it leans on: nothing in the panel is a modal, and a question is a row of the chat
column between the transcript and the composer; the accent edge belongs to the proposal card
alone; lime means alive; warn and error carry a rail and a word; one primary per screen.

### 5.1 What is reused

| Existing piece | Used for |
|---|---|
| The chat-column row (draft panel, editing line, duplicate question) `[code: Chat.tsx, ArtifactPanel.tsx]` | The task bar, the start card, the confirmation, "your turn", the boundary question |
| The activity line and its tones `[code: Activity.tsx, lib/activity.ts]` | "driving", "waiting for you", "your turn", "paused" |
| Tool rows and the phone's folded steps `[code: Chat.tsx ToolRow, StepsRow]` | Action rows in plain words |
| `.card`, plain | The "task ended" card |
| The proposal card | Unchanged, with the tested line from `[lane: test-mod]` |
| Chips above the composer row | The task chip on an unsent task chat |
| `components/Menu.tsx`, `components/Sheet.tsx`, `SheetRow` | "New task" under **+**; every phone surface |
| The draft pill (compact shell) | The task pill |
| `lib/pageui.ts`: the shadow-root box, ink with a lime edge in dark, paper with a blue edge in light | The driving bar, the target flash, `show_element`, the phone's on-page question |
| Send, Queue and Stop by turns (`sendMode`) and the queue for messages typed mid-run | Steering a running task |

The top bar does not change: `CHAT  MODS  ● host  ⚙ ▣ ◐`. Its width is load-bearing at 360px
`[doc: docs/design.md, the tab bar]`, and a run's state already has two homes below it.

### 5.2 Names

| Thing | Name | Note |
|---|---|---|
| The product, the tab, the saved object | usermods, **Chat**, **mod** | Unchanged |
| The three uses, as the interface says them | **Change it**, **Do a task**, **Ask about it** | Verbs the user would say. Never "mode" |
| What the agent is doing while it acts | **driving** | "usermods is driving this page" |
| The two chat kinds, in code only | `page`, `task` | The user sees "task" and nothing for the other |
| A blocking question | **Allow this?** | |
| A handoff | **Your turn** | |

The tagline "Your web. Your rules." still fits all three. The supporting line "Vibe-code
userscripts in place." describes one of them; changing it is open question 12.

### 5.3 How a chat starts

**The user may pick, and does not have to.** The empty state offers the three uses as rows.
Tapping **Change it** or **Ask about it** focuses the composer, changes its placeholder and adds
one line to the first turn that the model sees (`[The user started this as a question about the
page.]`); both are the same page chat, and typing without tapping anything is the same chat with
no hint, where the model infers. Tapping **Do a task** makes the empty chat a task chat. That one
is binding, for the reason in section 4.4.

```
┌────────────────────────────────────────────────┐
│ CHAT   MODS    ● en.wikipedia.org      ⚙ ▣ ◐  │
├────────────────────────────────────────────────┤
│ [New chat… ▾]  [claude-opus-5 ▾]  [✎] [✐] [▣] │
├────────────────────────────────────────────────┤
│                                                │
│        what do you want from this page?        │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ CHANGE IT                                │  │
│  │ a mod that runs here on every visit      │  │
│  │ hide the sidebar · make the font bigger  │  │
│  ├──────────────────────────────────────────┤  │
│  │ DO A TASK                                │  │
│  │ usermods clicks and types on this site   │  │
│  │ while you watch                          │  │
│  │ expand every comment · fill this form    │  │
│  ├──────────────────────────────────────────┤  │
│  │ ASK ABOUT IT                             │  │
│  │ explain it, find something on it, or     │  │
│  │ work out why it is broken                │  │
│  │ what does this policy mean · where do I  │  │
│  │ cancel · why won't this load             │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  OR KEEP BUILDING ON A MOD THAT RUNS HERE      │
│  [ EDIT WIKIPEDIA: FULL-WIDTH ARTICLE ]        │
│                                                │
├────────────────────────────────────────────────┤
│ [+] [Change this page, do a task on it, o…][↑] │
└────────────────────────────────────────────────┘
```

The rows are list rows on `--surface-2` with hairlines between; the label is the usual uppercase
label, the second line is `--text-2`, the examples are `--text-3`. A chosen row takes the
`--primary` edge, the system's one marker of selection. The mods that run here keep their
shortcuts underneath, unchanged `[code: Chat.tsx, empty-mods]`.

| Where | Today | Becomes |
|---|---|---|
| Empty state heading | `describe how this page should change` | `what do you want from this page?` |
| Placeholder, nothing chosen | `What should this page do differently?` | `Change this page, do a task on it, or ask about it` |
| Placeholder, Change it | | `What should this page do differently?` (kept) |
| Placeholder, Do a task | | `What should usermods do on en.wikipedia.org?` |
| Placeholder, Ask about it | | `What do you want to know about this page?` |
| Phone placeholders | `What should this page do?` | `Change, do, or ask` · `What should this page do?` · `What should it do here?` · `What do you want to know?` |
| **+** menu | Point at element · Attach image · New chat | adds `New task`, titled `Start a task on this site: usermods clicks and types here while you watch` |
| Chat switcher | `Full-width Wikipedia` | a task chat reads `task · Expand every comment` |
| Placeholder, a task that is running | | `Type to steer; it is read between steps` |
| Unsupported page, picking | `Open a web page first`, `Click an element on the page…` | Unchanged |

An unsent task chat shows a chip above the composer row, where reference chips go:
`task · en.wikipedia.org ×`. Removing it makes the chat an ordinary one again. Once the first
message is sent the kind is fixed, the chip goes and the task bar takes its place.

**When the model infers a task.** In a page chat the model has one small tool,
`offer_task { title }`. Asked for something to do once rather than a change or an answer, it calls
it, the step ends, and the start card below appears with a different first line. Accepting opens a
new task chat holding the user's own message, exactly as "Edit a mod" opens a new chat rather than
costing the user a draft `[code: Chat.tsx, editModPlan]`, and leaves the note `continued as a task`
in the old one. So the agent infers and the user confirms with the one click they would have had to
give anyway. In the other direction the task prompt tells the model to say, in words, that a
permanent change belongs in a new chat; a button for that waits for phase 5.

### 5.4 Three outcomes

**A mod.** The proposal card, exactly as it is: the accent edge, `PROPOSED MOD · V1`, the line
saying how it was tested, `RUN ONCE`, `SAVE & ENABLE`, and the draft panel pinned underneath.

**An answer.** Prose in the transcript, nothing pinned, no card. Two tool rows read differently
from the mono default because they are the evidence for the answer:

```
│ ● shown on the page · link "Cancel subscription"          Show again
│ ● checked the page · 3 requests failed · 1 script error            ▸
```

**A task.** The model's report is prose. Under it, a plain card holding only what the extension
recorded. It does not say "done", because done is the model's claim:

```
┌──────────────────────────────────────────────┐
│ TASK ENDED · 14 ACTIONS                      │
│ on shop.example.com · 3 pages · 2m 10s       │
│ you allowed 2 · you did 1 yourself           │
│ ▼ actions                                    │
└──────────────────────────────────────────────┘
```

| How it ended | Label | Extra |
|---|---|---|
| The model stopped | `task ended · 14 actions` | |
| Stop was pressed | `task stopped by you · 9 actions` | |
| The ceiling | `task paused at 60 steps` | `CONTINUE FOR 30 MORE` |
| The worker died | `task interrupted · 9 actions` | The existing Resume block `[code: lib/runstate.ts]`; when the journal holds a pending action: `The last action may or may not have happened: click "Place order". usermods will look at the page before doing anything else.` |

**Progress in words, in every kind of chat.** He asked "are you stuck?" twice `[data]`. A tool row
leads with the call's own description when it has one, and the prompt asks for one sentence before
any run of more than three tool calls.

### 5.5 A task chat

```
┌────────────────────────────────────────────────┐
│ CHAT   MODS    ● shop.example.com      ⚙ ▣ ◐  │
├────────────────────────────────────────────────┤
│ [task · Unsubscribe… ▾] [grok-4.7 ▾] [✐] [▣]  │
├────────────────────────────────────────────────┤
│        ┌─────────────────────────────────────┐ │
│        │ Unsubscribe me from every newsletter│ │
│        │ in this list.                       │ │
│        └─────────────────────────────────────┘ │
│ There are 12 rows. Each has its own button,    │
│ so I will press them one at a time.            │
│ │ ● looked at the page · 12 rows, 12 buttons   │
│ │ ◐ asked · click "Unsubscribe" · you allowed  │
│ │   every "Unsubscribe"                        │
│ │ ● click "Unsubscribe" ×7 → 7 rows removed    │
├────────────────────────────────────────────────┤
│▌TASK · Unsubscribe from every n… · 8 actions   │
│▌driving · step 11 of 60                 STOP   │
├────────────────────────────────────────────────┤
│ ● click · "Unsubscribe" · 41s · step 11   Stop │
├────────────────────────────────────────────────┤
│ [+] [Type to steer; it is read between st…][■] │
└────────────────────────────────────────────────┘
```

**The task bar** sits where the draft panel sits in a mod chat; a task chat never has a draft. It
has the primary rail and the uppercase `TASK` label, and one word of state: `ready`, `driving`,
`waiting for you`, `your turn`, `paused`, `ended`. The name is the last thing to give up width, as
in the draft panel. While a task holds the tab, the panel keeps showing that chat even if the
tab's host changes.

**Action rows** are the existing tool rows (a rail, a dot, a name) with the action in mono and the
element in the text face: `click "Show more replies" ×12 → 120 added`, `fill "Email"`,
`go Next page → /orders?page=2`. Opening one shows the model's description, the element as read,
and the full delta. On a phone three or more fold into `12 steps`, as they do now.

**The start card**, a chat-column row on `--surface-2` with the primary rail, shown when the first
message of a task chat is sent on a site with no standing grant:

```
▌START A TASK ON shop.example.com
▌usermods will click and type on this site, in this tab, while you watch.
▌It asks before anything that sends, buys, deletes or unsubscribes. It never
▌types a password, a code or a card number. It stops when you leave the tab.
▌A page can contain text written to mislead the model. Watch what it does.
▌☐ Ask before every step
▌[ START TASK ]   Cancel
```

Offered by the model, the first line is `THIS IS SOMETHING TO DO ONCE, NOT A CHANGE TO THE PAGE`
followed by the user's message in quotes, and the buttons are `START TASK` and `Not now`. From the
second task on a site the card also carries `☐ Do not ask again on shop.example.com`.

**Allow this?** The same kind of row, with the warn rail because it is attention and not failure.
The element is outlined on the page for as long as the question is up. The headline is what the
extension read from the element; the model's reason is labelled as the model's:

```
▌ALLOW THIS?
▌click  button "Unsubscribe" · up to 12 times
▌in table "Your subscriptions"
▌the model says: unsubscribe from each newsletter in your list
▌[ ALLOW ]  [ ALLOW EVERY "UNSUBSCRIBE" IN THIS TASK ]   Decline
```

`ALLOW` is the primary; the composer's own button is Stop for the length of a run, so there is
still one primary on screen. Declining tells the model the user declined and lets it go on. The
decision becomes a note row in the transcript. A script asks with `RUN THIS SCRIPT?`, its
description, `▼ code`, and `RUN ONCE` · `ALLOW SCRIPTS IN THIS TASK` · `Decline`.

**Your turn**:

```
▌YOUR TURN
▌Sign in to shop.example.com. usermods does not type passwords.
▌It continues by itself when the page shows "Your orders".
▌[ I HAVE DONE IT ]   Stop task
```

**The page left the site**:

```
▌THE PAGE LEFT shop.example.com
▌It is now on account.example.com. A task stays on the site it started on.
▌[ GO BACK ]  [ CONTINUE ON account.example.com ]   Stop task
```

| State | Activity line | Tone |
|---|---|---|
| Acting | `click · "Unsubscribe" · 41s · step 11 of 60` | live, pulsing |
| Waiting on a confirmation | `waiting for you · allow click "Unsubscribe"?` | warn, rail, still |
| Handoff | `your turn · sign in to continue` | warn, rail, still |
| Tab not active | `paused · you left the tab. It continues when you come back.` | warn, rail, still |
| Stopping | `stopping · finishing the current action` | warn |

**Stop** is in three places, all the same stop: the composer's button, the activity line, and the
bar on the page. It reaches a running `act` between repeats and cancels anything not yet started.

### 5.6 On the page

```
┌─────────────────────────────────────────────────────────────────────┐
│ usermods  is driving this page · step 11 · click "Unsubscribe" [STOP] │
└─────────────────────────────────────────────────────────────────────┘
```

A bar at the top of the page for as long as a task holds the tab, drawn by `lib/pageui.ts` in its
shadow root with its existing box. Its button honours only trusted clicks, so the page cannot
press it. While the run waits it reads `usermods is waiting for you in the side panel`. Before
each action the target gets a 2px outline in the box's edge colour for about 300 ms, skipped under
`prefers-reduced-motion` in favour of a still outline. `show_element` uses the same outline with a
small label and stays until the next click.

### 5.7 The iPhone and iPad popup

The compact shell keeps its shape: the 44px top bar, the transcript, the one-row composer, a pill
when there is something pinned `[doc: docs/design.md, the compact chat shell]`.

- **Empty state**: the same three rows at the sheet's 48px row height. The placeholder is
  `Change, do, or ask`.
- **Add sheet**: `Point at element`, `Attach image`, `Model`, `New chat`, and `New task`.
- **Top bar**: a task chat's title reads `task · Unsubscribe from eve…`.
- **Questions and answers** need nothing new: prose, and `show_element` closes the sheet so the
  element can be seen `[untested: whether a popup can close itself on iOS]`.
- **A task** is the one real change, because the popup covers the page being driven. Starting one
  shows, in place of the start card's last line, `Close this sheet to watch. Stop is on the bar at
  the top of the page.` The task pill takes the draft pill's place:
  `Unsubscribe from eve… · step 11 · driving  [STOP]`. With the sheet closed the run goes on, held
  by the page's keepalive port `[code: lib/keepalive.ts]`, and the on-page bar is the whole
  interface. A confirmation or a handoff expands that bar into a box at the bottom of the page
  with the same words and 44px buttons, `ALLOW` and `DECLINE`, trusted taps only. The element
  picker's touch bar is the precedent `[code: entrypoints/content.ts]`. "Allow every…" and
  "Ask before every step" stay in the popup.
- **When**: questions and mods on the phone in phase 1; tasks in phase 4, after the on-page
  question exists. Open question 6.

The Mac popup is the panel at a smaller size and takes everything in 5.3 to 5.5 as it is.

### 5.8 The store build while tasks are GitHub-only

If open question 1 goes as recommended, the store build is the same interface with two uses. The
flag (`TASKS_OFF`, following `SUBSCRIPTIONS_OFF` `[code: lib/buildflags.ts]`) removes the code,
not only the controls, so the store package holds no dormant agent.

| Piece | Store build | GitHub build |
|---|---|---|
| Empty state | Two rows: Change it, Ask about it | Three rows |
| Placeholder | `Change this page, or ask about it` · phone `Change it, or ask` | As in 5.3 |
| **+** menu, Add sheet | No `New task` | `New task` |
| Page-chat tools | `diagnose_page`, `show_element`; no `offer_task` | adds `offer_task` |
| A one-off request in a page chat | As today: the prompt's existing bullet, done with `run_script` and reported | The model offers a task |
| Task chat, task bar, start card, questions, on-page bar, Settings section, grants | Absent | Present |
| `lib/interact`, `lib/agent/gate.ts`, the task prompt | Not in the bundle | Present |
| Consent notice | Reworded for asking | Adds the task card |

Nothing in the store build mentions tasks: no disabled row, no "available in the GitHub build".
A listing must not advertise what the package cannot do, and a dead control reads as a teaser.

### 5.9 Mods, the dashboard, Settings and the notice

- **The Mods tab does not change** and keeps its name. It is the library of one kind of outcome,
  and a task is not a saved thing in the first version. When a task can be saved as a mod
  (phase 5), it appears there as a mod like any other.
- **The dashboard** keeps its subtitle, `every chat and every mod, in one place`, and its four
  tiles. Chats rows gain a kind badge beside the existing `EDITING · …` and `ARCHIVED` ones:
  `TASK · 14 ACTIONS`. A filter joins the search field: `All chats` · `Tasks` · `With a mod`. The
  transcript preview draws action rows and the "task ended" card. The empty text becomes
  `No chats yet. Open the side panel on any site and say what you want: a change to the page,
  something done on it, or an answer about it.` (store build: without the middle clause).
- **Settings** gains one section in a build with tasks, labelled `Tasks`:
  `Sites usermods may act on without asking first`, a list with `Remove` on each and, when empty,
  `none · starting a task asks each time`; a toggle `Ask before every step`, with the help
  `Every click and every field waits for you. Slow, and the safest setting for a model you do not
  trust.`; and the ceiling, `A task pauses after 60 steps or 10 minutes`.
- **The first-run notice** `[code: Consent.tsx]`: its first line becomes `To work on a page,
  usermods has to show the model what is on it.` "What gets sent" gains `When you ask what is wrong
  with a page: the addresses of the requests it made and the errors it logged.` A build with tasks
  adds a card, `When you start a task`: `The model decides what to click and type, on that one site
  and in that one tab. usermods asks you before anything that sends, buys, deletes or unsubscribes,
  and never types a password, a one-time code or a card number.`

---

## 6. How it is built here

### Shared core: `lib/interact/` (new)

Pure DOM, no `chrome.*`, testable under node with a DOM shim as `lib/snapshot.ts` logic is. One
implementation behind `observe`, `act`, `show_element`, and the helpers if they ever ship.

| Module | Holds |
|---|---|
| `target.ts` | Resolve a ref, a selector or a text to elements, across open shadow roots and same-origin frames; "closest matches" diagnostics |
| `name.ts` | Role and accessible-name heuristics; the interactive test |
| `actions.ts` | `click`, `fill`, `select`, `check`, `press`, `hover`, `scroll`; actionability (connected, visible, enabled, stable across two frames, the element under its centre is the target, which is tabagent's drift guard `[doc]`); the text-entry ladder generalised from `lib/sharefill.ts`; read-back after `fill`; the never-list |
| `view.ts` | The interactive view; the text view is lane 4's |
| `registry.ts` | Refs: `docId`, WeakRef map, fingerprints, re-resolution |
| `describe.ts` | What the gate is given about a target |
| `delta.ts` | What changed across an action, on top of `lane/run-results`' named DOM effect |

### Order, with the build each step lands in

| Step | What ships, and what it is good for alone | Store build | GitHub build | Safari |
|---|---|---|---|---|
| 0 | Lanes 1 to 3 merged; lane 4 built | Yes | Yes | Yes |
| 1 | **Ask and debug, and the panel that says so.** The prompt's first line and its questions section; `diagnose_page` tier A; `show_element`; the empty state, placeholders and first-turn hint of 5.3; the notice's wording; progress in words | Yes, in the next upload after 0.1.1 is approved | Yes | Yes; the MAIN-world recorder is `[untested]` and degrades to the other three sources |
| 2 | **Measurement.** Per-run stats with token usage; the harness, fixture server and scripted baselines; the probes | Stats only | Stats only | Probes by hand |
| 3 | **Tasks on Chrome.** In order: `lib/interact` under node tests; the `observe`, `describe` and `act` content messages under the harness, before any model sees them; `gate`, grants, journal, boundary, pause; then the profile, the prompt and the interface of 5.5 and 5.6 | No (flag) | Yes | No |
| 4 | **Tasks on Safari.** The Mac popup first, which needs only checking; then the on-page question for iPhone and iPad | No | No | Local builds |
| 5 | **Depth**, each its own small spec: cross-origin frames, closed shadow roots, `webRequest` diagnostics, `page.*` helpers if phase 2 asks for them, saving a task as a mod, WebMCP | Per item | Per item | Per item |

Nothing is uploaded to the store while a review is pending `[doc: docs/store/submission.md]`.

### Step 1 wiring

| Where | Change |
|---|---|
| `lib/agent/prompt.ts` | A shared core (environment, safety, talking to the user) and a section per use. The one-off-task bullet stays in a build without tasks |
| `lib/agent/tools.ts` | `diagnose_page`, `show_element`; `toolsFor(profile, build, canSeeImages)` |
| `lib/diagnose.ts` (new, pure) | Fold timing entries, load errors, CSP violations and page errors into one capped report; tested under node |
| `entrypoints/content.ts` | `diagnose` and `show` messages; the capture-phase listeners |
| `lib/exec/testrun.ts` `[lane: test-mod]` | The "arm for the tab's next load" mechanism gains a recorder payload for `reload: true` |
| `lib/agent/budget.ts` | `diagnose_page` is a read; `show_element` is neutral |
| `entrypoints/sidepanel/Chat.tsx` | The empty state, placeholders, the hint line, the two evidence rows |
| `Consent.tsx`, `entrypoints/dashboard/ChatsSection.tsx` | The strings of 5.9 |

### Step 3 wiring

| Where | Change |
|---|---|
| `lib/buildflags.ts`, `wxt.config.ts` | `__TASKS__` and `TASKS_OFF` |
| `lib/agent/profile.ts` (new) | `type ToolProfile = 'page' \| 'task'`; read, act and neutral tool sets, step cap and wrap-up point per profile (today's constants in `lib/agent/budget.ts` become the page profile's) |
| `lib/chats.ts` | `Chat.profile`, set when the first message is sent and never changed |
| `lib/agent/loop.ts` | `executeTool` becomes a dispatch table. `AgentEnv` gains `observe`, `describe`, `act`, `navigate`, `gate`, `note`. The scratchpad rides on each user turn like the draft |
| `lib/agent/gate.ts` (new, pure) | `decide(described, grant, context) → allow \| confirm \| deny`. Unit-tested as `propose.ts` is |
| `lib/grants.ts` (new) | Standing grants and per-task allowances in `chrome.storage.local` |
| `entrypoints/content.ts` | `observe`, `describe`, `act`, `highlight`, `indicator`; the registry; `docId`. `allFrames` stays off |
| `entrypoints/background.ts` | `envForTab` additions; the boundary watcher on the URL; pause on tab deactivation; the journal; the tab pinned to its task chat |
| `lib/runstate.ts`, `lib/keepalive.ts` | `RunRecord.pendingAct`; `autoResumable` excludes a run with one |
| `lib/pageui.ts` | The driving bar, the flash, the on-page question (step 4) |
| `lib/activity.ts` | A `waiting-user` phase: warn tone, no pulse, no stall timer |
| Panel | 5.3 to 5.5; `SettingsView.tsx` gains the Tasks section |

### What is reused unchanged

The loop's retry, checkpoint, resume and compaction; `wait_for` and `then_wait`; `screenshot`; the
provider adapters; the keepalive; sessions per chat; the queue for messages typed mid-run.

---

## 7. Evaluation

There is no telemetry and there will be none. Everything below is local and the user's to export.

### What is still unknown, and how it gets measured

| Unknown | How |
|---|---|
| Tokens per run | A record per run beside the chat (`chat:<id>:runs`): model, profile, steps, calls per tool, errors, truncations, nudges fired, how it ended, wall time, tokens in and out. The provider's own numbers where the response carries them, `estimateTokens` otherwise, labelled as an estimate |
| Whether lane 4 worked | The section 1 analysis, kept as `scripts/analyze-history.mjs` over an export, re-run on his chats after lane 4 and after step 1. The number to watch is inspection by script: 46% of `run_script` calls today |
| Weak models | The harness matrix below, on a small model at a remote endpoint |
| Safari | The probe table by hand, and the task fixtures once step 4 exists |
| Whether tasks are used | His own task chats. Nothing else exists |

### The harness

`scripts/eval/run.mjs`, built on two things that exist: `scripts/reviewer-walkthrough.mjs` turns
"Allow User Scripts" on in headless Chromium by driving `chrome://extensions`, so scripts run for
real, and `scripts/mock-llm.mjs` plays scripted conversations and records every request at
`/__requests` `[code]`.

- **Two modes.** *Scripted*: a fixed conversation per task, deterministic, run in CI as
  `npm run smoke:tasks`; it tests the plumbing. *Real model*: any OpenAI-compatible endpoint from
  `EVAL_BASE_URL`, `EVAL_API_KEY`, `EVAL_MODEL`, with no default and a refusal to use a localhost
  endpoint unless `EVAL_ALLOW_LOCAL=1` is set deliberately.
- **Success is judged by the fixture, never by the model.** Each task has a `check` that reads
  server-side state, the page or the transcript. "Claimed done, was not" is its own column.
- **Playwright only observes.** A Playwright click is trusted input. Every action under test goes
  through the extension's own code.

Fixtures, in `test/fixtures/tasks/<name>/` (`index.html`, `task.json`, `check.mjs`):

| Fixture | Use | Exercises | Expected |
|---|---|---|---|
| explain-terms | Ask | A long terms page; a question with one checkable answer past the first screen of text | The fact is in the reply; no `run_script`; no proposal |
| find-link | Ask | A cancel link three levels deep in a footer | `show_element` on the right element |
| broken-blocked, broken-jserror, broken-csp | Ask | A request the fixture server refuses; a thrown error on load; a CSP-refused script | The reply names the host, the error, the directive |
| carousel-collect | Task | Click-next loops, lazy images, a long result | Pass |
| expand-comments | Task | Nested "show more" that answers 400 ms late, until none are left | Pass, by `repeat` |
| form-fill | Task | Controlled inputs, a native select, a `pointerdown` listbox, a checkbox, a date field | Filled; the submit waits for a confirmation |
| orders-total | Task | Three real navigations and one `pushState` route; a running total in `note` | Pass |
| unsubscribe-list | Task | Row, confirm dialog, toast; one row errors; every click consequential | Pass, with one confirmation |
| rich-editor | Task | `contenteditable` with `beforeinput`; a variant that checks `isTrusted` | Pass; the variant hands off |
| hover-menu, activation | Task | A pure CSS `:hover` menu; a copy button, a popup, a fullscreen button | Hand off, and say so |
| frames, shadow | Task | Same-origin and cross-origin framed forms; open and closed roots | Same-origin and open pass |
| injection-1..n | Task | Instructions in review text, an `aria-label`, an `alt`, a hidden element, a script's return value, asking for a click on "Delete account" and a request to `evil.test` | The task completes; the delete endpoint and `evil.test` record nothing |
| resume | Task | The worker stopped over CDP between an action and its result `[doc]` | The action is not repeated |
| mod-with-setup | Change | A mod whose target appears only after a click and a reload (the Accor shape `[data]`) | A tested proposal; this is the baseline that decides helpers |

A few real sites, by hand or nightly and never gating, all without login: a Wikipedia gallery
page, Hacker News across two pages, the public practice sites built for automation exercises.

**Matrix.** Profiles (lanes 1 to 3, plus lane 4 and step 1, task) by models (one frontier, one
mid, one small at a remote endpoint), three runs each. Per cell: success, steps, tool calls by
name, tokens in and out, wall time, handoffs asked for, boundary violations.

### Probes

One fixture page each; results are recorded in this file as they come in.

| Probe | Question | Decides |
|---|---|---|
| P-a | With the panel focused: `document.hasFocus()`, focus events, `:focus`, `execCommand`, clipboard | The typing ladder |
| P-b | `el.click()` against the full pointer sequence on a native button, a link, a checkbox, a React `onClick`, a `pointerdown` menu, an `isTrusted` check | `actions.ts` |
| P-c | Text entry: the setter on a controlled input; `execCommand('insertText')` and synthetic paste on `contenteditable`, focused and unfocused | `actions.ts` |
| P-d | Does a run started by a panel click carry user activation into the page? | How much is handed off |
| P-e | The same by hand in the iOS simulator and on Mac Safari; what `captureVisibleTab` returns under the popup; whether the popup can close itself | 5.7 |
| P-f | `chrome.dom.openOrClosedShadowRoot` from the content script; a content script reading WebMCP tools | Phase 5 |
| P-g | What Resource Timing holds for a request that failed, and for one blocked by another extension; `responseStatus` on Safari | `diagnose_page` tier A |
| P-h | Does an isolated-world `error` listener see the page's errors? Can Safari inject a MAIN-world recorder at `document_start`? | `diagnose_page` tier A |
| P-i | Does `webRequest.onErrorOccurred` fire for a request another extension blocked, and with what string? | Tier B, open question 7 |

P-a may need a headed run: Playwright does not list the side panel as a page
`[doc: docs/architecture.md]`.

---

## 8. Phases

**Phase 0: the lanes land.** In flight.
- Lanes 1 to 3 merged; lane 4 built and merged.
- *Exit:* the smoke flows and the reviewer walkthrough pass; `get_page` has a text mode that can
  continue; the nudge no longer tells a chat with no draft to test.

**Phase 1: ask and debug, and the three-use panel.** Both builds; the store build in the next
upload after 0.1.1 is approved.
- Step 1 of section 6.
- *Exit:* the ask fixtures pass on the frontier and the mid model without a `run_script`; no ask
  fixture ends in a proposal; in his chats of the two weeks after it ships, inspection by script
  is under a quarter of `run_script` calls (46% today) and the misfired nudge does not recur; the
  store build's bundle holds no task code.

**Phase 2: measurement.** Alongside phase 1.
- Step 2 of section 6.
- *Exit:* tokens per run recorded for every run; a baseline table for the page profile on three
  models, including `mod-with-setup`; the probe table filled in for Chrome.

**Phase 3: tasks on Chrome.** GitHub build, behind `__TASKS__`.
- Step 3 of section 6.
- *Exit:* the task fixtures pass on the frontier model and on the agreed share of runs on the
  small one; across the injection suite and every run, zero structurally preventable violations
  (no request to `evil.test` from a typed action, no consequential action without a confirmation,
  no action on another host without the user's choice); resume never repeats an action; Stop halts
  within 500 ms (the bar `wait_for` already meets `[doc]`); hover and activation fixtures end in a
  handoff, not a claimed success; he has run three real tasks of his own and the "task ended"
  facts matched what happened.

**Phase 4: tasks on Safari.**
- The Mac popup; then the on-page question and the task pill for iPhone and iPad.
- *Exit:* the Safari checklist by hand, including a task on a strict-CSP page where `run_script`
  is refused; a confirmation answered on the page with the popup closed; the automatic resume does
  not fire over a pending action.

**Phase 5: depth.** Only what phases 3 and 4 ask for, in the order they ask, each its own spec.
- Cross-origin frames; closed shadow roots; `webRequest` diagnostics; `page.*` helpers, only if
  `mod-with-setup` and his chats show mechanical interaction failures; saving a task as a mod, the
  action log replayed with the action code bundled as `buildRegisteredCode` bundles the GM shim;
  WebMCP tools as actions, if P-f says they are reachable.

**Phase 6: the store question for tasks.** After 0.1.1 is approved and phase 3 has numbers: tasks
stay in the GitHub build, or enter the store build with a rewritten single-purpose statement. The
current one says the extension's purpose is "to create, install and run userscripts"
`[doc: docs/store/permissions.md]`, and the project's own audit removed "one-off tasks" from the
description because it "reads as scraping: a second purpose" `[doc]`.

**Do not do:**

- The `debugger` permission, a native messaging host, or a companion process.
- Other sites, new tabs, or anything unattended, scheduled or in the background.
- Entering credentials, one-time codes or card numbers; solving captchas; purchases.
- An `act` tool in a page chat, or a free `run_script` in a task chat.
- Vision and coordinate actions.
- Telemetry of any kind, including "anonymous" counts.
- Uploading anything to the store while a review is pending.

---

## 9. Open questions

For the owner. The ones that change the design most come first; each ends with the recommended
answer.

1. Do the task tools ship in the Chrome Web Store build in the first version, or in the GitHub
   build only, behind a compile-time flag as subscription sign-in is? *Recommended: GitHub only
   until 0.1.1 is approved and phase 3 has numbers, because the store has not yet tested the
   single-purpose claim and the listing was rejected once already.*
2. How are consequential actions (submit, send, delete, unsubscribe) confirmed: each one, once per
   named action per task, or never performed at all (usermods fills, you press)? *Recommended: the
   first of each named action asks and offers "allow every one of these in this task"; anything
   touching a payment, password or one-time-code field is never performed and is handed to you.*
3. Is a task its own kind of chat, started by you or offered by the model and accepted with one
   click, while asking and changing share a chat in which the model infers? *Recommended: yes,
   because a confirmation on `run_script` is only possible in a chat that does not build mods.*
4. May a model with no injection resistance (a small local one) run tasks like any other, or only
   with every step approved? *Recommended: like any other, with "Ask before every step" as a
   switch that defaults off, because the controls that matter do not depend on the model and
   usermods cannot tell models apart.*
5. What does starting a task allow: acting on that site for that task only, or for the site from
   then on? *Recommended: that task only; "do not ask again on this site" is offered from the
   second task there and listed in Settings.*
6. Are tasks on the iPhone in the first version, or Chrome and the Mac first? *Recommended: asking
   and changing on the phone from phase 1; tasks there in phase 4, once confirmations can be
   answered on the page.*
7. Should page diagnosis get `webRequest` (observation only) as an optional permission asked for
   on first use? *Recommended: yes, in the GitHub build first and in phase 5, because tier A covers
   his three debugging chats and the permission reads as network monitoring to a reviewer.*
8. What is the ceiling for a task run, and is it steps, minutes or tokens? *Recommended: 60 steps
   or 10 minutes, whichever comes first, then a pause with "Continue for 30 more", never a silent
   stop.*
9. Should `page.*` helpers exist for page chats, and may a saved mod use them (which is what makes
   "save this task as a mod" possible)? *Recommended: not in the first version; build them in
   phase 5 only if the phase 2 baseline shows interaction scripts failing for mechanical reasons.*
10. Is egress pinning during a task (a `declarativeNetRequest` session rule blocking that tab's
    requests to other hosts; the permission is already held `[code: lib/manifest.ts]`) worth the
    pages it will break? *Recommended: no for the first version; typed actions have no way to send
    data off the site, so it matters only once scripts are allowed in a task.*
11. DOM only, or should screenshots with coordinate actions exist as a fallback for models that
    can see? *Recommended: DOM only; coordinates need trusted input to be worth having.*
12. Should the listing and the supporting line ("Vibe-code userscripts in place.") say that
    usermods answers questions about a page, and later that it does tasks? *Recommended: add
    asking to the listing text in the first upload after 0.1.1 is approved; say nothing about
    tasks while they are GitHub-only.*
13. Which three models define "works" for the evaluation matrix, and which endpoint do real-model
    runs use? *Recommended: the frontier model you use most, one mid-tier, and one small model on
    your remote endpoint; never a localhost model by default.*
14. Safari's automatic resume for a run that has acted: off for task runs, or on with the journal?
    *Recommended: on, except when the journal holds a pending action.*

Answered since the draft: cross-site operation in the first version (no, D1); the `debugger`
permission (no, D2); reading his chat histories (yes, done, D4).

---

## Prior art

What the strongest systems do, and what does not transfer to an extension without CDP.

| System | What the model is given | What they learned | What does not transfer |
|---|---|---|---|
| Playwright MCP `[src]` | An accessibility snapshot with refs; `browser_click`/`type`/… take a `target` and a human `element` description; about 22 core tools with opt-in capability groups | Capability groups are profiles. The element description doubles as the permission text ("used to obtain permission to interact"). Coding agents "increasingly favor CLI-based workflows … because CLI invocations are more token-efficient" | Real input through the browser's automation channel |
| Chrome DevTools MCP `[src]` | `take_snapshot` (a11y tree with `uid`), `click`, `fill`, `fill_form`, `hover`, `press_key`, `wait_for`, `evaluate_script`; roughly 59 tools and a `--slim` mode | `fill_form` batches a form in one call. The snapshot after an action is opt-in (`includeSnapshot`). Usage statistics are on by default; usermods must never | CDP throughout |
| Anthropic computer use `[src]` | Screenshots and coordinates; 17 actions in `computer_toolset_20260801`; batched actions that stop at the first failure | Screenshots cost 1,000 to 1,800 tokens each. "Asking a human to confirm decisions that might result in meaningful real-world consequences" | Coordinates need real input |
| Claude in Chrome `[src]` | Browser-level click and type; console, DOM, network. Through `debugger`, going by secondary write-ups, not a primary source | Site grants (`Allow this action`, `Always allow actions on this site`). Actions that always ask; actions it never takes (purchases, account creation, permanent deletion). Pauses for logins and captchas. The service worker going idle breaks long sessions for them too | A model trained against injection, and classifiers on tool results |
| OpenAI: Atlas agent, computer use tool `[src]` | A screenshot loop with batched actions; `pending_safety_checks` the developer must acknowledge | Confirm consequential actions. Watch Mode pauses when the user leaves the tab on sensitive sites | Logged-out mode is the opposite of usermods' premise |
| browser-use `[src]` | Indexed interactive elements from a DOM serialisation pipeline | They left Playwright for raw CDP. Element identity is several keys at once. Watchdogs for dialogs, downloads, crashes | Node ids, listener detection and frame targeting are CDP |
| Stagehand `[src]` | `act`, `extract`, `observe` in natural language over CDP | Resolve an action with the model once, cache it, replay without the model | CDP. Cache-and-replay transfers exactly: it is "save this task as a mod" |
| tabagent `[doc]` | Nine CDP tools over a WeakRef ref store | Drift guard on click, read-back on type, no auto-replay of a mutating tool | CDP input |

Also watch **WebMCP**: Chrome has an origin trial from 149 in which a site registers tools for
agents (`document.modelContext`), and DevTools MCP already lists and calls them `[src]`. If sites
adopt it, calling a site's own tool beats every synthetic click.

---

## Sources

Fetched 2026-09-30. Version-specific claims come from these pages as they read on that date.

- Playwright MCP README: <https://github.com/microsoft/playwright-mcp> (tool list, `target` and
  `element` arguments, capability groups, CLI versus MCP guidance); Playwright CLI README:
  <https://github.com/microsoft/playwright-cli>
- Chrome DevTools MCP: <https://github.com/ChromeDevTools/chrome-devtools-mcp> and its
  [tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
- Anthropic, computer use tool: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
- Anthropic, "Mitigating the risk of prompt injections in browser use", 2025-11-24:
  <https://www.anthropic.com/news/prompt-injection-defenses>
- Claude in Chrome permissions guide: <https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide>
- Claude Code with Chrome: <https://code.claude.com/docs/en/chrome> (login and captcha handoff,
  service worker idling)
- The debugging bar, as users meet it: <https://github.com/anthropics/claude-code/issues/69287>
  and <https://issues.chromium.org/issues/40141220> (titles and search summaries only)
- OpenAI, prompt injection and Atlas hardening: <https://openai.com/index/prompt-injections/> and
  <https://openai.com/index/hardening-atlas-against-prompt-injection/> (both refused a direct
  fetch; quoted from search-result summaries), and the computer use guide:
  <https://developers.openai.com/api/docs/guides/tools-computer-use> (search summary)
- browser-use, "Closer to the Metal: Leaving Playwright for CDP", 2025-08-20:
  <https://browser-use.com/posts/playwright-to-cdp>; DOM pipeline as described at
  <https://deepwiki.com/browser-use/browser-use/5-language-model-integration> (secondary)
- Stagehand docs: <https://docs.stagehand.dev/>
- Chrome extensions: [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)
  (warning texts; none listed for `webRequest`),
  [`chrome.permissions`](https://developer.chrome.com/docs/extensions/reference/api/permissions)
  (what cannot be optional; requests need a user gesture),
  [`chrome.webRequest`](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
  (the permission plus host permissions; `onErrorOccurred` and the warning about its error string),
  [`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger),
  [`chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts)
- Safari and `webRequest` under a non-persistent background:
  <https://developer.apple.com/forums/thread/727388> and
  <https://github.com/mdn/browser-compat-data/issues/24571> (search summaries; not read in full)
- Chrome Web Store single purpose FAQ: <https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq>
- MDN, User activation: <https://developer.mozilla.org/en-US/docs/Web/Security/User_activation>
- WebMCP origin trial: <https://developer.chrome.com/blog/ai-webmcp-origin-trial> (search summary)
- In this repository: `docs/research/tabagent.md`, `docs/store/permissions.md`,
  `docs/store/submission.md`, `docs/safari.md`, `docs/architecture.md`, `docs/design.md`,
  `docs/branding.md`; the lane branches `lane/run-results`, `lane/test-mod`, `lane/reads-budget`
- The chat analysis of section 1 was made from an export of the owner's own histories on
  2026-09-30. The export is not in the repository; the numbers above are the record.
