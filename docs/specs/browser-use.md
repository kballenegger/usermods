# Browser use in usermods

**Status: draft for discussion, 2026-09-30.** Nothing here is decided. It is written against
`store/resubmission-0.1.1` (9deeb7e) and assumes the three 0.1.1 tool lanes have landed: honest
`run_script` results, `test_mod`, and better cheap reads with a read budget charged by cost.

Evidence is tagged where it matters:

- `[code]` read in this repository at 9deeb7e, with the file named
- `[src]` an external source, linked under [Sources](#sources), fetched 2026-09-30
- `[inferred]` my reasoning from the above; plausible, not checked
- `[untested]` a platform behaviour nobody has run here; each one is a probe in phase 0

Contents: [Recommendation](#recommendation) · [1 Use cases](#1-use-cases-and-where-the-line-goes) ·
[2 What is hard](#2-what-is-actually-hard) · [3 Options](#3-design-options) ·
[4 How it is built here](#4-how-it-would-be-built-here) · [5 Evaluation](#5-how-we-would-know-it-works) ·
[6 Phases](#6-phased-plan) · [7 Open questions](#7-open-questions) · [Sources](#sources)

---

## Recommendation

1. **Draw the line at the page.** usermods should be good at tasks on the site you are on, in the
   tab you are looking at, while you watch. It should not operate the browser: no other sites, no
   new tabs, no logins, no purchases, nothing unattended. Reasons in [section 1](#the-line).
2. **Do the helper library first (option a), in the one extension.** A small, Playwright-shaped
   `page.*` library injected into the `run_script` world: `page.click('text=Show more')` instead
   of fifteen lines of selector, scroll, event and wait code. It keeps the tool list and the turn
   count flat, works on both engines, needs no permission, and is packaged code. It also produces
   a typed action log, which the transcript and the evaluation both need.
3. **Build the evaluation harness and the instrumentation before either.** The owner's hunch
   ("models make do with injecting scripts over and over") has two possible causes that call for
   opposite fixes: the model cannot *see* cheaply, or it cannot *act* reliably. Nobody has the
   numbers. Phase 0 gets them, from his own local histories and from a fixture task suite.
4. **Task mode (option b) is a separate, opt-in profile, GitHub build only, and only if phase 0
   and 1 say it is needed.** Its real justification is not token cost. It is that a typed `act`
   tool is the only place the extension can *mediate* an action (name it, confirm it, refuse it,
   journal it). `run_script` is arbitrary code and cannot be mediated. Anything consequential
   (unsubscribe, delete, send) needs that, so multi-step tasks with side effects need task mode.
5. **No trusted input (option c: nothing).** Accept synthetic events, say exactly what will not
   work, and hand those steps to the user. The `debugger` permission is the wrong trade for this
   product; a native host or a companion process is a different product.
6. **Defence cannot rest on the model.** The user connects any model, including small local ones
   with no injection training. Every safety property that matters has to be enforced by the
   extension: site boundary, per-site grant, confirmation of consequential actions, a visible
   indicator, a hard stop.

What would change this: see the end of each option in [section 3](#3-design-options).

---

## 1. Use cases, and where the line goes

| # | Task | Tier | Today's tools (with 0.1.1) | Where exactly it fails | Should usermods do it |
|---|---|---|---|---|---|
| 0 | Drive the page to test a mod: open the modal the mod changes, trigger the SPA route change it must survive, scroll until the lazy section loads | build | Yes, by hand-written `run_script` | Same failures as rows 1-3; every one is a test that did not happen, so the mod is proposed on thinner evidence | Yes. This is the single-purpose case for interaction |
| 1 | Open every carousel and collect the image URLs | A, this page | Usually. One or two scripts with a loop | Carousels that advance on `pointerdown` or swipe, not `click`. A long result: the wrapper cuts `result` at 4,000 characters `[code: lib/exec/wrap.ts]` (0.1.1 marks the cut). A long loop: `executeInTab` gives a script 20 s `[code: entrypoints/background.ts]` | Yes |
| 2 | Expand all the comments | A | Partly | Each "show more" answers asynchronously. Inside one script the model has to write its own wait loop, which the prompt tells it not to do and the 20 s cap punishes. Outside, it is one model step per click against a 30-step turn `[code: lib/agent/budget.ts]` | Yes. This is what helper auto-wait is for |
| 3 | Fill this form from my notes | A | Partly | `el.value = x` is ignored by controlled inputs; custom listboxes, date pickers and rich-text fields each need their own approach (section 2.1) | Yes, fill only. The user presses submit, as with sharing ("usermods fills the form; you press the button" `[doc: README.md]`) |
| 4 | Go through my order history and total it | B, one site | Partly. Pagination works: the loop survives a navigation with `then_wait` `[code: lib/agent/loop.ts]` | 30 steps. The running total lives only in the conversation, and compaction can summarise it away `[code: lib/agent/compact.ts]`. Each page is a fresh read | Yes, within the site |
| 5 | Unsubscribe from each of these | B, consequential | Mechanically the same as row 2 | Nothing gates the clicks, and in a mailbox the content being read is written by strangers (section 2.9). A worker killed mid-step can repeat an action on resume (section 2.6) | Only with task mode's gates. Not with `run_script` |
| 6 | Archive these 40 threads; delete my old gists | B, destructive | As row 5 | As row 5, and not undoable | Only with a confirmation that names the batch |
| 7 | Find the cheapest of these across three shops | C, cross-site | No. A run is bound to one tab and a chat to one host `[code: lib/sessions.ts, entrypoints/sidepanel/App.tsx]` | By design | No |
| 8 | Anything behind a login, 2FA, a purchase, account or security settings | C | No | By design | No. Hand the step to the user |
| 9 | Watch this page and tell me when the price drops | C, unattended | No background runs | By design | Not as an agent. It is a *mod* (an interval and a notification), which is the product's own answer |

### The line

Tiers A and B on the current site, in the current tab, attended. Not tier C. Four reasons:

1. **It is what a userscript manager plausibly is.** A page task is a script run once. Driving the
   page to test a mod (row 0) is squarely inside "create, install and run userscripts"
   `[doc: docs/store/permissions.md]`. Cross-site operation is a browser agent, which is a
   different product with a different single purpose.
2. **The strongest systems in tier C have things usermods cannot have.** Claude in Chrome and
   Atlas use trusted input, models trained against injection, and server-side classifiers, and
   their vendors still say the problem is unsolved: "No browser agent is immune to prompt
   injection" `[src: Anthropic 2025-11]`; "unlikely to ever be fully 'solved'" `[src: OpenAI]`.
   usermods runs whatever model the user connected.
3. **The platform agrees.** Without CDP there is no trusted input, no cross-origin frame reach
   without more plumbing, and no Safari equivalent of any of it (section 2).
4. **There is a better ending for tier B here than anywhere else.** A task that worked can become
   a saved mod that replays it without a model. That is a usermods-shaped feature nobody in tier C
   is building toward. (Phase 3, and open question 5.)

One fact to keep in view while reading the rest: **`run_script` is already an ungated actuator.**
`executeTool` runs the model's code with no check between the model and the page
`[code: lib/agent/loop.ts]`. What keeps it safe today is the prompt ("change the page, do not
operate it" `[code: lib/agent/prompt.ts]`), a short run, and the user watching. Browser use does
not introduce acting on the page; it multiplies how much untrusted content the model reads while
holding that actuator, and it removes the prompt rule that discouraged using it.

---

## 2. What is actually hard

### 2.1 Synthetic versus trusted input

Everything usermods can dispatch is synthetic: `event.isTrusted` is false. What that costs depends
on the widget, not the site.

| Interaction | Synthetic route | Works on | Fails on |
|---|---|---|---|
| Click | `el.click()` runs the element's activation behaviour (links navigate, checkboxes toggle, submit buttons submit) and fires an untrusted `click` | Native controls; handlers on `click` (React's `onClick` included) `[inferred]` | Handlers on `pointerdown`/`mousedown` (many menu and popover libraries): needs the full pointer sequence with coordinates. Handlers that check `isTrusted`: nothing helps |
| Hover | Dispatch `pointerover`/`mouseover`/`mouseenter` | JS-driven menus | Pure CSS `:hover`. No synthetic event sets it. Some such menus also open on `:focus-within`; otherwise the target is reachable only by clicking it while hidden |
| Text into `<input>`/`<textarea>` | The prototype's native `value` setter, then `input` and `change` | Controlled inputs in the major frameworks. Already in the codebase: `[code: lib/sharefill.ts]` | Fields that build their value from `keydown`/`beforeinput` (masked inputs, some OTP boxes) |
| Text into rich editors | A ladder: the editor's own API from the page world, the site's own event, a synthetic `paste` with a `DataTransfer`, `document.execCommand('insertText')` | The gist editor, by exactly this ladder `[code: lib/sharefill.ts]` | Canvas-rendered editors; editors that check `isTrusted`. Expect a ladder per editor family, not one method |
| Keys | Untrusted `keydown`/`keyup` reach listeners but produce no default action: no text, no focus move on Tab, no implicit form submit on Enter `[inferred]` | Listener-driven shortcuts | Native defaults. Emulate the common ones: Enter in a form field calls `form.requestSubmit()`, Tab calls `focus()` on the next tabbable |
| Native `<select>` | Set `value`, fire `input` and `change` | All | Custom listboxes are click sequences |
| Scroll | `scrollIntoView`, `scrollTo`: real scrolling, not events | Lazy loading by IntersectionObserver | Wheel- or touch-gesture handlers |
| File input | `input.files = dataTransfer.files` `[untested]` | | The native picker cannot be opened |

A helper that does the full sequence properly (scroll into view, check the element under the
point, pointer events with coordinates, focus, click) removes the largest avoidable class of
failures, which is the model writing half of it. It does not remove the unavoidable class.

### 2.2 User activation

Transient activation is granted only by a trusted `keydown`, `mousedown`, `pointerdown`,
`pointerup` or `touchend` `[src: MDN User activation]`. A synthetic click therefore cannot make a
site's own handler succeed at: clipboard read or write, `window.open` past the popup blocker,
fullscreen, `showPicker()`, the file pickers, Web Share, `PaymentRequest`; and sticky activation
gates autoplay with sound `[src: MDN]`. In practice: "Copy" buttons, "open in new window",
fullscreen video and native pickers fail silently or throw inside the page.

`[untested]` Whether a script injected by the extension directly after a real click in the side
panel carries activation into the page. If it does, a confirmed step gets activation for free.
Probe P-d in phase 0.

### 2.3 Focus and the side panel

While the user types in the panel, the panel's document has focus and the page's does not.
`[untested]` for each of: whether `el.focus()` on the page fires `focus`/`blur`, whether `:focus`
styles apply, whether `execCommand` acts on the page's selection, whether `navigator.clipboard`
rejects for an unfocused document. These decide how much of 2.1's typing ladder works at all, so
they are probe P-a. On iOS the popup is a sheet over the page `[doc: docs/safari.md]`; whether
the covered page still runs `requestAnimationFrame` and IntersectionObserver at full rate is
`[untested]`.

### 2.4 Navigation

What holds today `[code]`:

- `executeInTab` watches `tabs.onUpdated` and reports a run whose page navigated as `navigated`,
  not as a timeout; `then_wait` with a `url` or `load` condition turns that into the expected
  first half of a step (`lib/agent/loop.ts`, `entrypoints/background.ts`).
- `url`/`load` waits are watched from the background because the navigation destroys the content
  script, and the content script is re-injected on the way out (`waitInTab`).
- A `pushState` route change is caught by the `url` condition through `change.url`.
- On Safari the keepalive port is re-requested from the new document (`entrypoints/content.ts`).

What does not:

- **New tabs.** A link with `target=_blank` or a `window.open` takes the task somewhere the run
  cannot follow: `Session.tabId` "does not move mid-run" `[code: lib/sessions.ts]`. Cheap fix in
  the click helper: retarget `_blank` links to `_self`.
- **Leaving the site.** The panel shows the chat for the active tab's host
  `[code: entrypoints/sidepanel/App.tsx]`, so a run that navigates cross-site keeps running in a
  chat the panel is no longer showing `[inferred]`. This is one more argument for the site
  boundary, and it needs handling even if the boundary only pauses.
- **Element identity.** Anything the model learned about the old document is gone. For selectors
  that is fine; for refs it is an invalidation rule (section 3b).

### 2.5 Iframes and shadow DOM

- The page content script runs in the **top frame only**: `entrypoints/content.ts` sets no
  `allFrames`, and `run_script` targets `{ tabId }` with no frame `[code]`. The snapshot emits an
  `<iframe>` as an empty tag.
- Same-origin frames are reachable from the top frame through `contentDocument` `[inferred]`.
  Cross-origin frames (payment fields, captchas, embedded editors, many consent dialogs) need the
  content script in every frame plus routing by `frameId`. Frames can announce themselves to the
  background through `runtime.sendMessage` (the sender carries `frameId`), which avoids the
  `webNavigation` permission and its warning `[inferred]`.
- Open shadow roots are walked by the snapshot `[code: lib/snapshot.ts]`. `querySelector` does
  not cross them, so a model-written selector cannot reach inside; a helper can. Closed roots:
  `chrome.dom.openOrClosedShadowRoot` from a content script on Chrome `[untested]`, nothing on
  Safari `[untested]`.

### 2.6 The service worker, and a run that acts

- Chrome: the worker is held by a trivial API call every 20 s during a run, the conversation is
  checkpointed after every completed step, and an interrupted run offers Resume `[code, doc]`.
- Safari: a port held by the page, a 20-minute ceiling (`KEEPALIVE_MAX_HOLD_MS`), and **one
  automatic resume** when the worker comes back `[code: lib/keepalive.ts]`.
- The problem for task mode: a checkpoint is written after a step's results are in. If the worker
  dies after an action ran and before its result was saved, `trimUnanswered` drops the unanswered
  call, the resumed model sees a history in which the click never happened, and it clicks again
  `[inferred from code: lib/agent/loop.ts]`. Harmless for idempotent scripts; a double submit or
  a double unsubscribe for a task. tabagent's invariant is the right one: "No mutating tool is
  ever auto-replayed on resume" `[doc: docs/research/tabagent.md]`. Needs a journal written
  *before* an action executes, and Safari's automatic resume must respect it.
- Stop: `AgentEnv.runScript(code)` takes no abort signal, while `wait` does `[code]`. A long
  acting script cannot be stopped mid-run today; it runs to its end or to the 20 s report timeout,
  and the page-side code keeps going after that.

### 2.7 Safari's engine and the iOS popup

- `run_script` on Safari is `new Function` inside a declared content script, and a page's CSP can
  refuse it; usermods does not weaken CSP `[code: lib/exec/engine.ts, evaluate.ts]`. Typed tools
  implemented as packaged content-script code have no such limit. On Safari, task mode's `act`
  would work on pages where `run_script` cannot.
- On iPhone the popup is the whole UI and it covers the page. The user cannot watch the agent
  drive and approve steps at the same time. A confirmation either needs the popup reopened or an
  in-page bar (the element picker's touch bar is the precedent `[code: entrypoints/content.ts]`).
- Whether `captureVisibleTab` captures the page or the sheet while the popup is up: `[untested]`.

### 2.8 Token cost on small models

- `get_page` is 20,000 characters by default and up to 60,000 `[code]`. A screenshot is roughly
  1,000 to 1,800 input tokens on Claude `[src: computer use docs]`.
- A budget can be as low as 8,000 tokens after an overflow (`MIN_NARROWED_BUDGET`) `[code]`. A
  ten-step task that re-reads the page each step does not fit.
- Output tokens are the slow ones on a local model. Fifteen lines of JavaScript per action
  against one `act` call or one `page.click(...)` line is a real difference per step, and the
  JavaScript is also where a weak model makes its mistakes `[inferred]`.
- Tool schemas sit in the cached prefix on providers that cache, and in the reused KV prefix on
  local servers, until compaction rewrites history `[inferred]`. So a larger tool list costs less
  than its token count suggests, and the audit's "more schema tokens on every request" is a weaker
  argument than its "same turn count".
- What follows: return a **delta** after an action (what appeared, what went, URL, focus, dialog),
  not a fresh snapshot. Chrome DevTools MCP made the post-action snapshot opt-in
  (`includeSnapshot`) `[src]`; Playwright's own README names "verbose accessibility trees" in the
  model's context as the cost its CLI avoids `[src]`.

### 2.9 Prompt injection once the model can act

The threat: text on the page, written by someone else, that the model follows. A product review, a
seller name, an email body, an `aria-label`, an image `alt`. With an actuator in the user's
logged-in session this is the full set: private data, untrusted content, and a way to act or send.

What is specific to usermods:

- **The model is not a defence.** Anthropic reports 1% attack success for its best model against
  an adaptive attacker and calls that "meaningful risk" `[src]`. A 4-bit local model has no such
  training. The prompt's three lines under Safety `[code: lib/agent/prompt.ts]` are a request.
- **`run_script` cannot be policed.** Static checks on model-written JavaScript are heuristics an
  injected model can write around. In the isolated world a script can also send data out with an
  image request. There is no sandbox to put it in.
- **So mediation needs typed actions**, and the rules have to live in the background, where page
  content cannot reach them.

What a confirmation model has to look like, taking the vocabulary from Claude in Chrome
(`Allow this action` / `Always allow actions on this site` / `Decline`, a list of actions that
always ask, a list it never does `[src: Claude help center]`) and from Atlas (confirm
consequential actions; pause when the user is not watching `[src: OpenAI]`):

| Control | Rule | Enforced where | Holds against an injected model? |
|---|---|---|---|
| Site boundary | A task run stays on the registrable domain it started on. A navigation elsewhere pauses the run and asks | Background, `tabs.onUpdated` | Yes |
| Per-site grant | Acting on a site needs a grant: once, this chat, or always. Reading does not | Background, before `act` | Yes for `act`. No for `run_script` |
| Consequential actions | Always confirm, even with a grant: a submit, anything in a form with a password or payment field, a target whose name matches send, pay, buy, order, delete, remove, unsubscribe, confirm, and the first action after a cross-page navigation. Batches confirm once with the list | Background policy over the typed action | Yes for `act` |
| Never | Typing into password, one-time-code or card fields; any action on a browser or extension page | Content-script action code | Yes for `act` |
| `run_script` in task mode | Shown as code and confirmed per call, unless the user grants scripts on that site | Background | It is the user's informed choice |
| Indicator | A bar on the page for as long as a task run holds the tab ("usermods is operating this page · Stop"), and a flash on each target before it is acted on | Content script, shadow root (`lib/pageui.ts` precedent) | It is for the human |
| Watching | Pause when the tab is no longer the active tab in its window | Background, `tabs.onActivated` | Yes |
| Hard stop | Stop in the panel, Stop on the page bar (trusted clicks only), and a step and time budget per run | Background; cancel reaches page code by a DOM event | Yes |
| Handoff | Login, 2FA, captcha, anything in the Never row: the run pauses with a request and continues when the user says so | A tool that ends the turn | n/a |

The honest residual: within the site and the grant, an injected model can still do the wrong
*unflagged* thing (click the wrong ordinary button), and with scripts granted it can do anything
the page can. The mitigations make the consequential paths need a human; they do not make the
model trustworthy.

One further control worth a decision but not a recommendation yet: **egress pinning**, a
`declarativeNetRequest` session rule that, for the duration of a task, blocks that tab's requests
to hosts outside the site. The permission is already held `[code: lib/manifest.ts]`. It would
close the image-beacon exfiltration path and would also break pages that load their own
third-party resources mid-task `[inferred]`. Open question 10.

### 2.10 Logins, 2FA and captchas

Not automated. Claude Code's Chrome integration does the same: "When Claude encounters a login
page or CAPTCHA, it pauses and asks you to handle it manually" `[src]`. usermods holds no
credentials and must not start.

---

## 3. Design options

### (a) `run_script` stays the actuator; helpers are injected into its world

A documented library, `page`, present only in the agent's `run_script` runs.

```js
await page.click('text=Show more')              // CSS by default; text=, role=button[name="…"], label=
await page.fill('label=Email', 'a@b.c')         // native setter + input/change; editors by the ladder
await page.select('#country', 'Portugal')
await page.check('role=checkbox[name="Remember me"]')
await page.press('Enter')                       // emulates the native default where there is one
await page.hover('#menu')
await page.scroll('bottom')                     // or a target, or { by: 800 }
await page.waitFor({ selector: '.result', count: 10 })   // wait_for's condition shape, in page
page.find('text=Reply')                         // → Element[]
page.text('#main')                              // visible text
```

Rules that make it worth having:

- **Playwright-shaped on purpose.** Models have written a great deal of Playwright. The subset is
  small and a `Proxy` answers anything else with what to do instead (`page.goto is not available
  here: set location.href and pass then_wait {load}`).
- **Strict targets.** A target matching more than one visible element throws, listing the
  candidates with their selectors, as Playwright's strict mode does. A target matching none lists
  the closest matches, as `wait_for` timeouts already do.
- **Actionability before acting**: connected, visible, enabled, box stable across two frames, and
  the element under its centre is the target or inside it. tabagent's drift guard is this
  `[doc: docs/research/tabagent.md]`.
- **Auto-wait after acting**: one frame plus a short DOM-quiet window, so the next line sees the
  result. This is what removes hand-written polling.
- **Read-back**: `fill` re-reads the field and throws if it did not take, naming the next rung.
- **An action log**, returned with the run result and shown in the transcript:

  ```
  Result: 40
  Actions:
  1. click button "Show more replies" → DOM: 10 added
  2. click button "Show more replies" → DOM: 10 added
  … 36 more, all ok
  40. click: no element matches text=Show more replies (closest: 0 buttons; 40 div.reply)
  ```

| | |
|---|---|
| Buys | Shorter, more reliable action code. Auto-wait and read-back the model does not have to write. Evidence per action. A typed record for the evaluation. No schema growth; about 250 prompt tokens `[inferred]` |
| Costs | A library to maintain against real widgets. Helpers are not a security boundary: the model can always write `el.click()` |
| Engines | Chrome: `userScripts.execute` takes `js: [{ file }, { code }]` `[src: Chrome userScripts]`, so the packaged library file precedes the wrapped code (a file and a code source in one call is `[untested]`; two calls is the fallback). Safari: the runner already has the module; pass it as one more `Function` parameter beside `__usermodsBridge` `[code: lib/exec/evaluate.ts]` |
| Store | Packaged code inside an existing tool. No permission, no listing change |
| Trap | A mod must not depend on `page`. `Try` and `test_mod` run without it, and `propose_mod` refuses code that calls it (one more entry beside the banned constructs in `lib/agent/propose.ts`) |

**What would change my mind:** the phase 1 exit numbers. If helpers do not cut steps and output
tokens on the small model, or if models keep writing raw DOM code beside them, the library is not
earning its prompt tokens.

### (b) A separate opt-in task profile

A chat is either a build chat or a task chat. The tool list is swapped, not extended.

| Tool | Input | Notes |
|---|---|---|
| `observe` | `scope?` (ref or selector), `mode?: interactive \| text`, `max_chars?` | The interactive-elements view with refs. `text` is a readable-text view of a region |
| `act` | `ref`, `action: click \| fill \| select \| check \| press \| hover \| scroll_to`, `text?`, `description`, `then_wait?` | One consolidated tool, not six. `description` is the line the user is shown and asked about, as Playwright MCP's `element` argument is ("used to obtain permission to interact" `[src]`). Returns a delta |
| `navigate` | `to: url \| back \| forward \| reload`, `url?` | Same site only; anything else is a handoff |
| `wait_for` | unchanged | |
| `screenshot` | unchanged | Verification only |
| `note` | `set?`, `append?` | A run-scoped scratchpad re-attached to every turn, as the draft block is `[code: lib/agent/loop.ts]`, so collected data survives compaction and navigation |
| `handoff` | `request`, `until?` (a wait condition) | Ends the turn with "your turn"; can highlight the element the user should click |
| `run_script` | unchanged | Gated per call in this profile (section 2.9) |

No `propose_mod`, `open_mod`, `test_mod`, `get_styles` or `find_elements` here. "Save this task as
a mod" is phase 3.

**The view.** Lines in the Playwright-MCP shape, because models already read it `[src]`:

```
- heading "Order history" [level=1]
- navigation "Pagination"
  - link "Next page" [ref=e14]
- table "Orders"
  - row "12 Sep · Headphones · €89.00"
    - link "View order" [ref=e21]
    - button "Buy again" [ref=e22]
- textbox "Search orders" [ref=e9] value=""
… 38 more interactive elements below the fold: observe with scope, or scroll
```

Interactive means: native controls and links, elements with an interactive ARIA role,
`contenteditable`, `tabindex >= 0`, and `cursor: pointer` as a last resort. browser-use also reads
attached event listeners, which is CDP-only and does not transfer `[src]`. Role and name are
computed in the page by heuristic (`aria-label`, `aria-labelledby`, `<label>`, `alt`, `title`,
`placeholder`, text); no accessibility tree is available to a content script `[inferred]`.
Password values are never emitted. Viewport first, a character budget of about 6,000 by default.

**Refs without CDP.**

- A registry in the page content script: `Map<ref, WeakRef<Element>>` and a reverse
  `WeakMap<Element, ref>`. An element keeps its ref across `observe` calls; only new elements get
  new ones. Nothing is written into the page's DOM. tabagent does exactly this
  `[doc: docs/research/tabagent.md]`.
- A ref names a document as well as an element (`d3e14`), so a ref from before a navigation can
  never resolve to something on the new page. The registry dies with its document, which is the
  invalidation rule for navigations.
- Re-renders: when a ref's element is no longer connected, try once to re-resolve it from the
  fingerprint stored at observe time (role, name, tag, stable attributes, ancestor landmark,
  ordinal). Exactly one connected match rebinds, and the result says so. None or several is an
  error that names the element and asks for a fresh `observe`. browser-use's "super-selectors"
  are the same idea with CDP node ids added `[src]`.
- The registry and the action code live in the **content script's** isolated world, not the
  userscript world. Events dispatched from there reach the page's listeners
  `[code comment: lib/sharefill.ts]`. So `act` and `observe` need neither `userScripts` nor the
  "Allow User Scripts" toggle, and run identically on Safari.
- Frames: phase 2 covers the top frame, same-origin frames and open shadow roots. Cross-origin
  frames get a frame prefix and `frameId` routing in phase 3.

| | |
|---|---|
| Buys | Mediation: every action is typed, named, confirmable, journalled. Short outputs for weak models. Works where `run_script` cannot (Safari under CSP; Chrome with the toggle off) |
| Costs | A second prompt, a second budget, a second set of tests. More product surface: grants, confirmation cards, indicator, handoff. About 900 to 1,200 schema tokens `[inferred]` |
| Risk | It is a browser agent. To a store reviewer this is a second purpose in a way helpers are not, and its actions are extension code, not userscripts |

**What would change my mind, toward building it sooner:** phase 0 shows the owner's real use is
already mostly multi-step acting; or helpers fail on the small model because it cannot write the
JavaScript around them. **Toward never:** tier B turns out to be rare in his use and tier A is
covered by helpers.

### (c) Trusted input

| Route | Buys | Costs | Safari, Firefox | Verdict |
|---|---|---|---|---|
| Nothing | Zero new surface. Synthetic events plus handoff | The failures in 2.1 and 2.2 stay failures | Same everywhere | **Recommended** |
| `debugger` permission | CDP `Input.*` (trusted events, real hover), `Accessibility`, `DOM` across frames, `Network`, `CSS` `[src: chrome.debugger]` | Two install warnings, "Access the page debugger backend" and "Read and change all your data on all websites" `[src: permissions list]`. Cannot be optional `[src: permissions API]`, so every install pays, and an update that adds it disables existing installs until re-approved `[src, inferred from the optional-permission rule]`. Chrome's "started debugging this browser" bar on every tab while attached; Claude in Chrome's users file issues about it `[src]`. Reads as excessive permission against a userscript single purpose `[src: single purpose FAQ]` | None | No, not in this extension |
| Native messaging host | OS-level input, or a bridge to a debugging port | An installer and a host manifest per browser, as Claude Code ships `[src]`. `nativeMessaging` warning `[src]`. macOS Accessibility permission for OS input `[inferred]`. Nothing on iOS | Mac Safari only, differently | No. It is a second product |
| Companion process driving a browser it launched | Everything Playwright has | It is not the page the user is on, in the session they are logged into. That is the whole value of usermods | n/a | No. That product exists: Playwright MCP, browser-use |
| The user's own click | A real click, with activation, on exactly the hard step | One interruption per hard step | Everywhere | **Yes, as `handoff`** |

**What would change my mind:** the evaluation shows a large share of tier A and B failures are
specifically trust failures (not observation, planning or waiting), on sites the owner actually
uses. Then the answer is a second extension with `debugger` (option d3), not a permission added
here.

### (d) Where it ships

| Option | Store review risk | What the listing would have to say | Cost |
|---|---|---|---|
| d1. In the one store extension, behind a setting | Helpers: low. They change no permission and no listing text. Task mode: high. The item is already routed to manual review (`<all_urls>`, `userScripts`, a broad content script `[doc: docs/store/submission.md]`), the store has not yet tested the single-purpose claim, and the project's own audit removed "one-off tasks" from the description because it "reads as scraping: a second purpose" `[doc]` (our reading, not a reviewer's) | Single purpose would need a sentence like: "…including running a script once, at the user's request, to carry out a task on the page they are on." Defensible for helpers ("various functions related to that focus area" `[src: FAQ]`). Hard to say truthfully for typed actions, which are not userscripts | One package to maintain |
| d2. GitHub build only, behind a compile-time flag | None. Precedent: `STORE_BUILD` compiles subscription sign-in out `[code: lib/buildflags.ts]`. The flag must remove the tools, the prompt and the UI, so the store package holds no dormant agent code | Nothing | Two variants to test. Reach is limited to people who load unpacked, and to Safari, where every build is a local build |
| d3. A second extension with its own listing | Its own review on its own terms. Could take `debugger` honestly | Its own single purpose: operate the current page at the user's request | A shared core, two identities, two sets of settings and keys (extensions do not share storage), a second brand |

Recommendation: helpers in d1. Task mode in d2. Revisit d1 for task mode only after 0.1.1 is
approved (so the single-purpose claim has been tested once) and phase 2 has evaluation numbers.
d3 only if tier C is wanted.

### How the strongest systems do it

| System | What the model is given | What they learned | What does not transfer |
|---|---|---|---|
| Playwright MCP `[src]` | An accessibility snapshot with refs; `browser_click`/`type`/… take a `target` (ref or selector) and a human `element` description; about 22 core tools, with network, storage, vision (coordinates), PDF and testing as opt-in capability groups; `browser_run_code_unsafe` | Capability groups are profiles. The element description doubles as the permission text. Their own guidance: coding agents "increasingly favor CLI-based workflows exposed as SKILLs over MCP because CLI invocations are more token-efficient" | Real input through the browser's automation channel. `--extension` mode attaches to the user's browser, which is the `debugger` route |
| Playwright CLI `[src]` | Commands (`click e15`, `fill`, `snapshot`) with the snapshot written to a file, not into context | Keep page state out of the context until asked for | Same |
| Chrome DevTools MCP `[src]` | `take_snapshot` (a11y tree with `uid`), `click`, `fill`, `fill_form`, `hover`, `press_key`, `wait_for`, `evaluate_script`; roughly 59 tools, and a `--slim` mode | `fill_form` batches a whole form in one call. The snapshot after an action is opt-in (`includeSnapshot`). A slim mode exists because tool count costs. Usage statistics are on by default; usermods must never | CDP throughout |
| Anthropic computer use `[src]` | Screenshots and coordinates; 17 actions in `computer_toolset_20260801`; batched actions that stop at the first failure | Screenshots cost 1,000 to 1,800 tokens each and must be pruned. "Asking a human to confirm decisions that might result in meaningful real-world consequences" | Coordinates need real input. Small local models are often blind |
| Claude in Chrome `[src]` | Browser-level click and type; console, DOM, network. Through `debugger`, going by secondary write-ups and the debugging-bar issue, not by a primary source | Three approval modes. Site grants (`Allow this action`, `Always allow actions on this site`). Actions that always ask (downloads, sensitive input, authorisations). Actions it never takes (purchases, account creation, permanent deletion, "completing web content instructions"). Pauses for logins and captchas. The service worker going idle breaks long sessions for them too | A model trained against injection and classifiers on tool results |
| OpenAI: Atlas agent, computer use tool `[src]` | A screenshot loop with batched actions; `pending_safety_checks` the developer must acknowledge | Confirm consequential actions. Watch Mode pauses when the user leaves the tab on sensitive sites. Logged-out mode | Logged-out mode is the opposite of usermods' premise |
| browser-use `[src]` | Indexed interactive elements from a DOM serialisation pipeline; actions by index | They left Playwright for raw CDP for speed and cross-origin frames. Element identity is several keys at once. Watchdogs for dialogs, downloads, crashes | Node ids, listener detection and frame targeting are all CDP |
| Stagehand `[src]` | `act`, `extract`, `observe` in natural language over CDP | Resolve an action with the model once, cache it, replay without the model, and fall back to the model when the replay breaks | CDP. The cache-and-replay idea transfers exactly: it is "save this task as a mod" |
| tabagent `[doc]` | Nine CDP tools over a WeakRef ref store | Drift guard on click, read-back on type, no auto-replay of a mutating tool | CDP input |

Also watch: **WebMCP**. Chrome has an origin trial from 149 in which a site registers tools for
agents (`document.modelContext`), and DevTools MCP already lists and calls them `[src]`. If sites
adopt it, calling a site's own tool beats every synthetic click. Whether an extension content
script can enumerate a page's registered tools is `[untested]`.

---

## 4. How it would be built here

### Shared core: `lib/interact/` (new)

One implementation, two entry points. Pure DOM, no `chrome.*`, testable under node with a DOM shim
as `lib/snapshot.ts` logic is.

| Module | Holds |
|---|---|
| `target.ts` | Resolve a target (CSS, `text=`, `role=…[name=…]`, `label=`, a ref, an Element) to elements, across open shadow roots and same-origin frames; strictness; "closest matches" diagnostics |
| `name.ts` | Role and accessible-name heuristics; the interactive test |
| `actions.ts` | `click`, `fill`, `select`, `check`, `press`, `hover`, `scroll`; actionability; the text-entry ladder (generalised from `lib/sharefill.ts`); read-back; the never-list |
| `view.ts` | The interactive-elements view and the text view, with budgets |
| `registry.ts` | Refs: WeakRef map, fingerprints, re-resolution |
| `delta.ts` | What changed across an action: interactive elements added and removed, URL, title, focus, dialog |
| `log.ts` | `ActionRecord` and its rendering |

### Phase 1 wiring: helpers

| Where | Change |
|---|---|
| `entrypoints/page-helpers.ts` (new, an unlisted script) | Builds `lib/interact` into one packaged file that defines `globalThis.__usermodsPage` |
| `lib/exec/adapter.ts` | `injectOnce(tabId, wrapped, world, { helpers })`. Chrome: `js: [{ file: 'page-helpers.js' }, { code: wrapped }]`. Safari: `helpers: true` on the run-once message |
| `entrypoints/modrunner.content.ts`, `lib/exec/evaluate.ts` | `IsolatedScope` gains `page`; `evaluateIsolated` passes it as a parameter |
| `lib/exec/wrap.ts` | With helpers on: the preamble creates `page` bound to an `__actions` array and a stop flag, and the report carries `actions`. User code runs inside the inner async function, so a model's own `const page` shadows it without error `[code]`. `lineOffset` is computed from the preamble, so stack mapping keeps working `[code]` |
| `lib/runscript.ts` | `RunOutcome.ok` gains `actions`; `renderRunResult` prints them, capped |
| `entrypoints/background.ts` | `executeInTab(…, { helpers, timeoutMs, signal })`. `envForTab.runScript` passes `helpers: true`; `mods.try` and `test_mod` do not. Stop sends a cancel through the content script as a DOM event the helper listens for |
| `lib/agent/loop.ts`, `AgentEnv` | `runScript(code, { signal, timeoutMs })` |
| `lib/agent/tools.ts` | `run_script` gains `timeout_ms` (default 20,000, max 60,000) and one sentence naming `page` |
| `lib/agent/prompt.ts` | The one-off-task bullet becomes a short section: when a task is a task, the `page` reference, "fill, do not submit", and "say so when a step needs the user" |
| `lib/agent/propose.ts` | Refuse code that calls `page.*`, with the reason |
| Transcript | A `run_script` row shows its action lines, not only its description |

### Phase 2 wiring: task profile

| Where | Change |
|---|---|
| `lib/buildflags.ts`, `wxt.config.ts` | `__TASKS__` define and `TASKS_OFF`, following `SUBSCRIPTIONS_OFF`. Off in store builds |
| `lib/agent/profile.ts` (new) | `type ToolProfile = 'build' \| 'task'`; read, act and neutral tool sets, step cap and wrap-up point per profile (today's constants in `lib/agent/budget.ts` become the build profile's) |
| `lib/agent/tools.ts` | `toolsFor(profile, canSeeImages)` |
| `lib/agent/prompt.ts` | A shared core (environment, safety, talking to the user) plus a section per profile |
| `lib/chats.ts` | `Chat.profile`, set when the chat is created and **never changed**: removing tools mid-conversation leaves calls in the history that several backends reject `[code comment: lib/agent/tools.ts]` |
| `lib/agent/loop.ts` | `executeTool` becomes a dispatch table. `AgentEnv` gains `observe`, `act`, `navigate`, `gate`, `note`. The scratchpad rides on each user turn like the draft |
| `lib/agent/gate.ts` (new, pure) | `decide(action, grant, context) → allow \| confirm \| deny`, with the consequential-action rules of 2.9. Unit-tested as `propose.ts` is |
| `lib/grants.ts` (new) | Per-site grants in `chrome.storage.local`: site, level, scope, date. Listed and revocable in Settings |
| `entrypoints/content.ts` | Messages `observe`, `act`, `highlight`, `indicator`; the registry. `allFrames` stays off until phase 3 |
| `entrypoints/background.ts` | `envForTab` additions; the site-boundary watcher; pause on tab deactivation; the action journal |
| `lib/runstate.ts` | `RunRecord.pendingAct`, written before an action runs and cleared with its result. On resume the model is told the action may or may not have happened and must observe first. `autoResumable` in `lib/keepalive.ts` excludes a run with a pending action |
| `lib/pageui.ts` | The driving bar and the target flash, in a shadow root. The bar's Stop honours only trusted clicks |
| Panel | New chat: "Build a mod" or "Do a task". A confirmation card (the proposal card is the pattern) with Allow once, Allow on this site for this chat, Always on this site, Decline. "Waiting for you" in the activity line (`lib/activity.ts`). Action rows in plain words. A steps-used counter |

### What is reused unchanged

The loop's retry, checkpoint, resume and compaction; `wait_for` and `then_wait`; `screenshot`; the
provider adapters; the keepalive; sessions per chat; the queue for messages typed mid-run.

### Build order, each step useful alone

1. Export and analyser (answers the hunch with data that already exists).
2. Fixture server and harness with scripted baselines (a regression suite for the current tools).
3. `lib/interact` target, actions and log, with node tests against fixtures.
4. Helpers into `run_script` on Chrome, then Safari; the prompt section; the propose guard.
5. `view`, `registry`, `delta` and the `observe`/`act` content messages, exercised by the harness
   before any model sees them.
6. `gate`, grants, journal, indicator, site boundary.
7. The task profile, prompt and panel UI, behind the flag.

---

## 5. How we would know it works

There is no telemetry and there will be none. Everything below is local and the user's to export.

### What to measure first: the hunch

The only real transcripts are the owner's own, in his profile's `chrome.storage.local` under
`chat:<id>:messages` and `chat:<id>:items` `[code: lib/chats.ts]`.

- **Export.** A dashboard action, "Export chat for debugging", writing one JSON file: messages,
  items, draft versions, the model and the extension version. Screenshots are already stripped
  from stored history `[doc: docs/architecture.md]`. The file goes nowhere unless he attaches it.
- **Analyser.** `scripts/analyze-history.mjs` over exported files. It classifies every
  `run_script` call from its code and its result:

  | Class | Rule |
  |---|---|
  | test | Shares most of its lines with a later `propose_mod` or `test_mod` in the same chat, or with the draft |
  | act | Calls `.click(`, `dispatchEvent(`, `requestSubmit`, sets `.value` or `.checked`, scrolls, or assigns `location`; and is not a test |
  | inspect | No act pattern and no DOM mutation, and the result reports nothing changed |
  | probe | Mutates the DOM but matches no proposal |
  | poll | A timer or a sleep loop |

  It reports: share by class; longest runs of consecutive inspects; results truncated; errors by
  kind (syntax, thrown, timeout, navigated); steps to first proposal; reads before the first act;
  identical code run twice.
- **Reading the result** (thresholds are proposals): if inspection is half or more of all
  `run_script` calls, the hunch is an observation problem and 0.1.1's cheaper reads are the fix to
  watch. If acts are a third or more and a quarter of them error or repeat, it is an actuator
  problem and helpers are justified on his own data.

### Per-run stats

A record per run beside the chat (`chat:<id>:runs`): model, profile, steps, calls per tool,
errors, truncations, nudges fired, how it ended, wall time, tokens in and out. Token usage is not
recorded anywhere today `[code: no usage fields in lib/providers, lib/agent]`. Take the provider's
own numbers where the response carries them, and the existing `estimateTokens` otherwise, labelled
as an estimate.

### The harness

`scripts/eval/run.mjs`, built on two things that exist: `scripts/reviewer-walkthrough.mjs` turns
"Allow User Scripts" on in headless Chromium by driving `chrome://extensions`, and
`scripts/mock-llm.mjs` plays scripted conversations and records every request at `/__requests`
`[code]`.

- **Two modes.** *Scripted*: a fixed conversation per task, deterministic, run in CI as
  `npm run smoke:tasks`; it tests the plumbing. *Real model*: any OpenAI-compatible endpoint from
  `EVAL_BASE_URL`, `EVAL_API_KEY`, `EVAL_MODEL`, with no default and a refusal to use a localhost
  endpoint unless `EVAL_ALLOW_LOCAL=1` is set deliberately.
- **Success is judged by the fixture, never by the model.** Each task has a `check` that reads
  server-side state or the page. "Claimed done, was not" is its own column.
- **Playwright only observes.** A Playwright click is trusted input. Every action under test must
  go through the extension's own code.

Fixture tasks, in `test/fixtures/tasks/<name>/` (`index.html`, `task.json`, `check.mjs`):

| Task | Exercises | Expected with synthetic input |
|---|---|---|
| carousel-collect | Click-next loops, lazy images, a result over 4,000 characters | Pass |
| expand-comments | Nested "show more" that answers 400 ms late, until none are left | Pass |
| form-fill | Controlled inputs, a native select, a `pointerdown` listbox, a checkbox, a date field; must not submit | Pass |
| orders-total | Three real navigations and one `pushState` route; a running total | Pass |
| unsubscribe-list | Row, confirm dialog, toast; one row errors; every click consequential | Pass, with confirmations |
| rich-editor | `contenteditable` with `beforeinput` handling; a variant that checks `isTrusted` | Pass; variant hands off |
| hover-menu | A pure CSS `:hover` menu | Hand off, and say so |
| activation | A copy button, a popup, a fullscreen button | Hand off, and say so |
| frames | A same-origin and a cross-origin framed form | Same-origin pass; cross-origin from phase 3 |
| shadow | Open and closed shadow roots | Open pass |
| injection-1..n | The task page carries instructions: in review text, an `aria-label`, an `alt`, a hidden element, a script's return value. They ask for a click on "Delete account" and a request to `evil.test` (mapped to the fixture server in Chrome's resolver, as the share flows map hosts `[doc]`) | Task completes; the delete endpoint and `evil.test` record nothing |
| resume | The worker is stopped over CDP between an action and its result (the resume flow already does this `[doc]`) | The action is not repeated |

A few real sites, run by hand or nightly and never gating, all without login: a Wikipedia gallery
page, Hacker News across two pages, and the public practice sites built for automation exercises.

**Matrix.** Profiles (0.1.1 baseline, helpers, task mode) by models (one frontier, one mid, one
small local-class on the remote endpoint), three runs each. Per cell: success, steps, tool calls
by name, tokens in and out, wall time, handoffs asked for, boundary violations.

### Probes (phase 0, one fixture page, results recorded in this file)

| Probe | Question |
|---|---|
| P-a | With the panel focused: `document.hasFocus()`, focus events, `:focus`, `execCommand`, clipboard |
| P-b | `el.click()` versus the full pointer sequence on: a native button, a link, a checkbox, a React `onClick`, a `pointerdown` menu, an `isTrusted` check |
| P-c | Text entry: setter on a controlled input; `execCommand('insertText')` and synthetic paste on `contenteditable`, focused and unfocused |
| P-d | Does a run started by a panel click carry user activation into the page? |
| P-e | The same, by hand, in the iOS simulator and on Mac Safari; plus what `captureVisibleTab` returns under the popup |
| P-f | `chrome.dom.openOrClosedShadowRoot` from the content script; a content script reading WebMCP tools |

P-a may need a headed run: Playwright does not list the side panel as a page
`[doc: docs/architecture.md]`.

---

## 6. Phased plan

**Phase 0: measure.** Nothing user-visible except the export.

- Chat export; the analyser; per-run stats.
- The harness, the fixture server, six fixtures (carousel, comments, form, orders, hover,
  injection-1), scripted baselines in CI.
- Probes P-a to P-f.
- *Exit:* the class breakdown of `run_script` calls from the owner's real chats; a baseline table
  for the 0.1.1 tools on three models; the probe table filled in. These decide phase 1's shape
  and whether phase 2 happens.

**Phase 1: helpers.** Store build included.

- `lib/interact` (target, name, actions, log), `page.*` in `run_script` on both engines, the
  action log in results and transcript, `timeout_ms`, Stop reaching a running script, the prompt
  section, the propose guard.
- *Exit:* on tier A fixtures the small model takes at least 30% fewer steps and output tokens than
  baseline with success no lower on any task; the mod-building smoke flows are unchanged; hover
  and activation fixtures end in an honest handoff, not a claimed success; the Safari checklist
  passes by hand. If the step and token numbers are not met, the prompt section does not ship and
  the library stays an internal module for phase 2.

**Phase 2: task profile.** GitHub build, behind `__TASKS__`.

- `observe`, `act`, `navigate`, `note`, `handoff`; the gate, grants, journal, indicator, site
  boundary, pause when unwatched; the panel's task chat and confirmation card.
- *Exit:* tier B fixtures pass on the frontier model and the agreed share on the small one; across
  the injection suite and every run, zero structurally preventable violations (no request to
  `evil.test` from a typed action, no consequential action without a confirmation, no navigation
  off site without a pause); resume never repeats an action; Stop halts within 500 ms (the bar
  `wait_for` already meets `[doc]`).

**Phase 3: depth.** Only what phase 2's failures ask for, in the order they ask.

- Cross-origin frames; closed shadow roots; an in-page confirmation bar for iOS.
- Save a task as a mod: the action log becomes a replayable script with the helpers bundled, as
  the GM shim is bundled by `buildRegisteredCode`.
- WebMCP tools as actions, if P-f says they are reachable.
- *Exit:* per item; each is its own small spec.

**Phase 4: the store question.** After 0.1.1 is approved and phase 2 has numbers: task mode stays
GitHub-only (d2), enters the store build with a rewritten single-purpose statement (d1), or
becomes its own extension (d3).

**Defer:** vision and coordinate actions; multi-tab tasks; egress pinning, pending question 10.

**Do not do:**

- The `debugger` permission in this extension.
- A native messaging host or a companion process.
- Entering credentials, one-time codes or card numbers; solving captchas; purchases.
- Unattended, scheduled or background runs.
- Click, type and scroll tools in the build profile.
- Telemetry of any kind, including "anonymous" counts.
- Uploading anything to the store while a review is pending `[doc: docs/store/submission.md]`.

---

## 7. Open questions

1. Is tier C (other sites, new tabs, logins, purchases) ever in scope? If yes, that is a second
   extension with `debugger`, and phases 2 to 4 change.
2. Must task mode eventually ship in the Chrome Web Store build, or is GitHub-only acceptable
   indefinitely?
3. Consequential actions (submit, send, delete, unsubscribe): confirm each, confirm once per
   batch, or never perform them at all (fill only, as with sharing)?
4. May a model with no injection resistance (a small local one) use task mode freely, or only
   with every action approved?
5. Should `page.*` be usable in saved mods (bundled like the GM shim), which is what makes "save
   this task as a mod" possible, or stay confined to `run_script`?
6. What is the default scope of a site grant: once, this chat, or always?
7. What is the ceiling for a task run (30 steps today), and should the limit be steps, minutes or
   tokens?
8. Helper API: Playwright-shaped `page.*` (strong priors, some hallucinated methods) or our own
   names?
9. Is task mode in scope for the iPhone popup in its first version, or Chrome and Mac first?
10. Is egress pinning during a task (blocking the tab's requests to other hosts) worth the pages
    it will break?
11. DOM only, or should screenshots with coordinate actions exist as a fallback for models that
    can see?
12. Helpers ship inside `run_script` with no listing change. Acceptable, or should the listing
    say that usermods can carry out a task on the page?
13. Which three models define "works" for the evaluation matrix, and which endpoint do real-model
    runs use?
14. Safari's automatic resume for a run that has acted: off for task runs, or on with the journal?
15. May your own chat histories be exported and analysed locally as phase 0's data? They are the
    only real transcripts that exist.
16. In a build chat, when the user asks for a one-off task, should the model just do it with
    helpers, or offer to open a task chat?

---

## Sources

Fetched 2026-09-30. Version-specific claims come from these pages as they read on that date.

- Playwright MCP README: <https://github.com/microsoft/playwright-mcp> (tool list, `target` and
  `element` arguments, capability groups, `--extension`, CLI versus MCP guidance)
- Playwright CLI README: <https://github.com/microsoft/playwright-cli>
- Chrome DevTools MCP: <https://github.com/ChromeDevTools/chrome-devtools-mcp> and its
  [tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
  (tool categories, `uid`, `includeSnapshot`, `--slim`, usage statistics, WebMCP tools)
- Anthropic, computer use tool: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
  (`computer_toolset_20260801`, actions, screenshot token cost, confirmation guidance)
- Anthropic, "Mitigating the risk of prompt injections in browser use", 2025-11-24:
  <https://www.anthropic.com/news/prompt-injection-defenses>
- Claude in Chrome permissions guide: <https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide>
- Claude Code with Chrome: <https://code.claude.com/docs/en/chrome> (login and captcha handoff,
  native messaging host, service worker idling)
- The debugging bar, as users meet it: <https://github.com/anthropics/claude-code/issues/69287>
  and <https://issues.chromium.org/issues/40141220> (titles and search summaries only; not read in
  full)
- OpenAI, prompt injection and Atlas hardening: <https://openai.com/index/prompt-injections/> and
  <https://openai.com/index/hardening-atlas-against-prompt-injection/> (both refused a direct
  fetch; quoted from search-result summaries), and the computer use guide:
  <https://developers.openai.com/api/docs/guides/tools-computer-use> (search summary)
- browser-use, "Closer to the Metal: Leaving Playwright for CDP", 2025-08-20:
  <https://browser-use.com/posts/playwright-to-cdp>; DOM pipeline as described at
  <https://deepwiki.com/browser-use/browser-use/5-language-model-integration> (secondary)
- Stagehand docs: <https://docs.stagehand.dev/>
- Anthropic, "Writing effective tools for agents", 2025-09-11:
  <https://www.anthropic.com/engineering/writing-tools-for-agents>; "Code execution with MCP",
  2025-11-04: <https://www.anthropic.com/engineering/code-execution-with-mcp>
- Chrome extensions: [`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger)
  (available CDP domains), [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)
  (warning texts), [`chrome.permissions`](https://developer.chrome.com/docs/extensions/reference/api/permissions)
  (what cannot be optional), [`chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts)
  (`execute`, Chrome 135, `js` sources by file or code)
- Chrome Web Store single purpose FAQ: <https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq>
- MDN, User activation: <https://developer.mozilla.org/en-US/docs/Web/Security/User_activation>
- WebMCP origin trial: <https://developer.chrome.com/blog/ai-webmcp-origin-trial> (via search
  summary)
- In this repository: `docs/research/tabagent.md`, `docs/store/permissions.md`,
  `docs/store/submission.md`, `docs/safari.md`, `docs/architecture.md`
