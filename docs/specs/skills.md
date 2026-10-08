# Skills in usermods: reusable, shareable browser automations

**Status: spec for 0.2, first revision of 2026-10-08.** Builds on
[browser-use.md](browser-use.md) (7e96c26), whose phase 5 has one line, "saving steps as a mod, the
action log replayed". This is that line, specified. It is written against the worktree at 7e96c26,
with the facts that landed on `main` since (36a158e: lane 4, `test_mod`, form values never sent to
the model) read through git and tagged `[code: main]`. Decisions D1 to D5 and the "Do not do" list
of the browser-use spec are taken as fixed; where this spec bends one, it says so by number.

Evidence is tagged where it matters:

- `[code]` read in this worktree at 7e96c26, with the file named; `[code: main]` read at 36a158e
- `[doc]` a document in this repository, named; `[bu §n]` a section of the browser-use spec
- `[src]` an external source, linked under [Sources](#sources), fetched 2026-10-08
- `[inferred]` my reasoning from the above; plausible, not checked
- `[untested]` a platform behaviour nobody has run here

Contents: [Decisions](#decisions-and-recommendations) · [Plan](#the-plan-in-brief) ·
[1 What a skill is](#1-what-a-skill-is) · [2 How one is made](#2-how-a-skill-is-made) ·
[3 How one runs](#3-how-a-skill-runs) · [4 Sharing, installing, updating](#4-sharing-installing-updating) ·
[5 Trust](#5-trust-and-safety-of-shared-skills) · [6 Interface](#6-the-interface) ·
[7 Examples](#7-three-skills-end-to-end) · [8 Build](#8-the-build) · [9 Evaluation](#9-evaluation) ·
[10 Open questions](#10-open-questions) · [Prior art](#prior-art) · [Sources](#sources)

---

## Decisions and recommendations

Recommended here, the owner's to overrule. Each is argued in the section named.

| # | Recommendation | Where |
|---|---|---|
| S1 | **A skill is a recorded replay with intent attached, not a recipe and not a script.** Its steps are the `act` steps, waits and handoffs the extension itself observed in a run (the journal of `[bu §4.5]`), each with the element as the extension read it and one line of the model's intent. It runs without a model. The model is used only to make one, and to repair a step whose target no longer resolves. Pure natural-language recipes and code-carrying skills are not in 0.2 | [§1](#1-what-a-skill-is) |
| S2 | **The file is `<name>.skill.md`: YAML front matter and a Markdown body**, the shape of SKILL.md `[src: agentskills.io]` with the steps in one fenced YAML block. It is readable raw, renders on a gist, and nothing in it is code. It is not a `.user.js`: a file that does nothing in Tampermonkey has no business on Greasy Fork | [§1.2](#12-the-file) |
| S3 | **Inputs are declared; values are never stored.** Every value typed during the recording becomes an input unless the user marks it constant. Password, one-time-code and card fields never enter a journal, so they cannot enter a skill | [§1.3](#13-inputs-and-outputs), [§2.3](#23-what-is-captured-and-what-never-is) |
| S4 | **A skill is invoked, never a mode (D5).** From the Mods tab, the chat's empty state, the composer's **+** menu, or by the model through `run_skill`, and every start is confirmed on a card that shows the inputs and what the skill will do. One site per run stays (D1): a skill names one site, and every URL in it must be on that site | [§3](#3-how-a-skill-runs), [§6](#6-the-interface) |
| S5 | **Replay goes through the same gate, guard and journal as `act`.** The file's own claims decide nothing at run time: consequential steps are confirmed from what the extension reads on the page, the never list holds, Stop and the site boundary hold. A step whose target does not resolve stops the run, or, when a model is connected and the setting is on, hands that one step to the model, whose every repaired action is confirmed | [§3.3](#33-when-the-page-has-changed), [§5](#5-trust-and-safety-of-shared-skills) |
| S6 | **Shared the same way, minus Greasy Fork.** Gist and a raw link, through the same fill-and-you-press flow, with the leak check extended to typed values and URLs. Updates through `@updateURL` with a powers diff computed from the two step lists. The install page previews sites, actions, consequential steps, inputs, outputs and the prose, and refuses what it cannot verify | [§4](#4-sharing-installing-updating) |
| S7 | **A freshly installed skill walks its first run**: every step is shown before it happens, with "run the rest without asking" after the user has seen enough. Repaired steps always ask. Standing allowances exist only for skills made on this device | [§5.3](#53-what-asks-every-time) |
| S8 | **Skills live in the Mods tab under their own heading**; the tab keeps its name, because the top bar has no room for a fourth tab at 360px `[doc: docs/design.md]`. The dashboard's Mods section gains a kind filter. The install page gains a skill mode | [§6](#6-the-interface) |
| S9 | **GitHub build only, behind the `__ACT__` flag, after browser-use phase 3.** A skill is `act` steps, so it cannot exist without `act`, and the store's single-purpose statement does not cover it until the owner takes browser-use open question 1 the other way | [§8](#8-the-build) |

**What this spec does not change in the browser-use spec.** D1 to D5 hold. The one line it amends:
`[bu §5.1]` says "Nothing is added to the **+** menu"; skills add exactly one item, **Run a skill…**,
argued in [§6.2](#62-where-a-run-starts). Its "Do not do" list holds in full: nothing here is
scheduled, unattended, cross-site, or answered on the web page.

## The plan in brief

1. **A skill is what the extension saw, written down.** The action journal the browser-use spec
   already keeps for resume becomes a file: the steps, the element each one touched as the extension
   read it, the waits, the handoffs. The model's description of each step rides along as intent, for
   the human who reads the file and for the model that repairs it. Nothing in the file is code.
2. **Made by doing, not by writing.** "Save this as a skill" after a run in chat; "write me a skill
   that…" makes the model do it once and then save it. `propose_skill` cannot invent a step: it
   names journal entries, and the extension writes the steps from its own record, as `propose_mod`
   cannot propose what was never run `[code: lib/agent/loop.ts]`.
3. **Runs without a model.** A replay is cheap, deterministic and works on a weak model's machine
   with no model at all. Every step passes the gate of `[bu §4.4]` as if the model had just called
   `act`, so the controls that hold today hold for a stranger's file.
4. **Breaks honestly.** A step whose element is gone stops the run and says which step; with a
   model connected and the setting on, that one step is handed to it, bounded, every action
   confirmed, and the repaired skill is offered back as a new version.
5. **Shared as a gist and a raw link; previewed before install.** The preview is computed from the
   steps, not from the author's prose: sites, verbs, counts, consequential names, inputs, outputs.
   Updates show a diff of those. The leak check refuses typed values and tokens in URLs.
6. **The risk is said.** The prose is a prompt injection the moment repair runs; a decoy element
   with a recorded name can be clicked; a non-English "Delete" is not in the word list. The design
   confirms every repaired step, stops on ambiguous targets and walks a first run, and still cannot
   make a stranger's skill safe. [§5.5](#55-the-residual-risk) says what remains.
7. **After browser-use phase 3, GitHub build, Chrome first.** The format, parser, preview and
   share path are pure and can be built alongside phase 3; the runner needs phase 3's `lib/interact`
   and journal. Safari after browser-use phase 4. The store after browser-use phase 6.

---

## 1. What a skill is

The owner's words: "share reusable skills the same way it shares reusable scripts, for example to
help submit forms or run certain common processes on various websites." A mod is a saved outcome of
the first use (change it); a skill is a saved outcome of the second (do something here). It is the
"better ending" the browser-use spec promised in `[bu §2]`: "steps that worked can later become a
saved mod that replays them without a model."

### 1.1 Recipe, replay or script

| | (a) Recipe | (b) Replay | (c) Script |
|---|---|---|---|
| The file holds | Natural-language steps and a site | The recorded action log: verb, target as the extension read it, value, wait; refs re-resolved by fingerprint `[bu §4.3]` | A userscript with a callable function and declared inputs |
| Runs on | A capable model, every time | Nothing. The content script replays it | The script engine, as a mod does |
| Weak or no model | Fails or misbehaves; the owner's data has no weak-model baseline `[bu §1]` | Works. The model is needed only when a step breaks | Works |
| What the preview can verify | Nothing. The prose is the author's claim | Everything: the steps are the content. Sites, verbs, names, counts, inputs, outputs are computed, not read | The code, which is what the mod preview shows today `[code: entrypoints/install/main.tsx]` and what most users do not read |
| Third-party risk | A prompt injection by construction: a stranger's instructions fed to the user's model with `act` in hand | A stranger's clicks, each named before it happens and gated as `act` is | Exfiltration by script, which no in-page rule stops `[bu §4.6]` |
| When the site changes | Adapts, if the model is good | Stops at the step, or repairs that step with the model | Breaks, silently or loudly |
| Tokens per run | Hundreds to thousands | Zero | Zero |
| Safari pages whose CSP refuses `new Function` `[code: lib/exec/evaluate.ts]` | Works (through `act`) | Works | Does not run |
| Already exists? | No | No | Nearly: a mod with `GM_registerMenuCommand` is an on-demand script, and the Mods tab has Run `[doc: README.md]` |

**Chosen: (b), with (a)'s words attached to every step and to the whole.** A skill is a replay whose
every step carries the model's one-line intent (`act`'s `description`, which the browser-use spec
already labels "the model says" on the Allow card `[bu §5.5]`) and whose front matter carries a
description. The intent is for two readers: the person deciding whether to install, and the model
asked to repair a step. It has no power of its own: the extension never executes prose.

Why not (a): the product is bring-your-own-model including local ones `[doc: README.md]`, and a
recipe is the format that needs the best model to do anything and makes a stranger's text the
plan. Why not (c): a skill that carries code is a mod, and the mod path already has its install
preview, its powers diff and its "read the code" trust story. Putting code into a second format
would give the project two ways to ship a script and the reviewer two things to read. What (c)
wanted, inputs and an on-demand entry point, a mod can gain later by header alone (open question 7).

Two things wait: **a step without a recording** (a pure instruction such as "find the invoice for
last month and open it"), which would make the file a recipe again, and **loops over rows across
pages**, which need a block structure the first version does not have. Both are open question 2.

### 1.2 The file

`<slug>.skill.md`: YAML front matter, then Markdown. The shape is the one Anthropic, the agentskills
specification and OpenAI's Codex all converged on for "a folder with a SKILL.md whose front matter
is `name` and `description`" `[src: Anthropic Agent Skills; agentskills.io; OpenAI build-skills]`,
reduced to one file so a raw link can carry it. The steps are a fenced YAML block, because YAML is
standard, line-oriented, diffable and legible without a renderer; a JSON file (workflow-use's
choice `[src]`) reads badly raw and on a gist, and a bespoke line grammar would be the proprietary
thing the mod format avoids.

```markdown
---
usermods-skill: 1
name: File an expense
description: Fills the new-expense form on expenses.example.com from your inputs and stops before Submit so you press it.
namespace: kenneth
version: 1.0.0
match:
  - "*://*.expenses.example.com/*"
start: https://expenses.example.com/expenses/new
inputs:
  merchant: { label: Merchant }
  amount: { label: Amount, example: "42.00" }
  note: { label: Note, optional: true }
outputs: {}
license: MIT
updateURL: https://gist.githubusercontent.com/kenneth/3b1f…/raw/file-an-expense.skill.md
---

# File an expense

Fills the three fields of the new-expense form and leaves Submit to you.
Made with usermods 0.2 on 2026-10-08 from a run on expenses.example.com.

```steps
- fill: $merchant
  into: textbox "Merchant"
  at: { css: "input#merchant", in: 'form "New expense"' }
  why: enter the merchant name
- fill: $amount
  into: textbox "Amount"
  at: { css: "input[name=amount]", in: 'form "New expense"' }
  why: enter the amount
- fill: $note
  into: textbox "Note"
  at: { css: "textarea#note", in: 'form "New expense"' }
  why: enter the note, if any
  when: $note
- ask: Check the form and press Submit.
  until: { text: "Expense filed" }
```
```

**Front matter.** `usermods-skill: 1` is the format version and the install trigger: a `.skill.md`
without it is a Markdown file. `name`, `description`, `version`, `namespace` and `license` are the
userscript header's fields under YAML names, so `shareFileName`, `bumpPatch`, `greasyForkMissing`'s
logic and `scriptIdentity` (`url:` else `ns: name`) carry over unchanged in spirit
`[code: lib/share.ts, lib/installurl.ts]`. `match` is a list of Chrome match patterns, parsed by
`toMatchPattern` `[code: lib/mods.ts]`; one site (D1), so every pattern's host must share its last
two labels with the first's, the sibling rule of `[bu §4.5]`. `start` is where a run begins and
must match. `updateURL`/`downloadURL` are what `checkUrls` reads `[code: lib/updates.ts]`.
Unknown keys are kept, as `parseHeader` keeps unknown header keys in `raw` `[code: lib/mods.ts]`.

**The body** is prose for people and, during repair, for the model. The extension writes two lines
and keeps whatever the user adds. One fenced block whose info string is `steps` is the program; a
file with none, or with two, is refused.

**Steps.** A step is a YAML map with one verb key. The verbs are `act`'s own `[bu §4.1]`, plus three
the journal already records:

| Verb | Value | Other keys | From |
|---|---|---|---|
| `click` | the target's role and name, as read | `at`, `repeat` (≤ 50), `why`, `confirm` | `act` click |
| `fill` | `$input`, or a literal the user marked constant | `into`, `at`, `why`, `when` | `act` fill |
| `select`, `check`, `press`, `hover`, `scroll_to` | as `act` | `at`, `why` | `act` |
| `go` | a URL on the site, or `back`, `forward`, `reload` | `why` | `act` go |
| `wait` | one `wait_for` condition `[code: lib/agent/tools.ts WAIT_CONDITION_PROPERTIES]` | `timeout_ms` | `wait_for`, `then_wait` |
| `ask` | the words shown on the Your-turn card | `until` (a wait condition, optional) | `wait_for` with `ask_user` |
| `read` | the output's name | `from` (a selector), `take` (`text`, `href`, `src`, or an attribute), `each` (true for a list) | a `find_elements` the model used for its answer ([§2.2](#22-from-a-description)) |

`at` is the fingerprint of `[bu §4.3]` serialised: `css` (the most stable selector `find_elements`
labelled, `[stable: id]` before `[stable: data-attr]` `[code: main, lib/snapshot.ts labels]`),
`in` (the nearest landmark, role and name), `nth` (the ordinal among same-named siblings, present
only when it mattered), and the role and name on the verb line itself. `why` is the model's
intent. `when: $input` skips the step when an optional input is empty. `confirm: true` marks a
step the author wants asked every time regardless of the gate; it can add questions, never remove
one.

**Limits.** 200 steps; 2 MB, Greasy Fork's figure `[src]`; a `read` capped at 500 items.

### 1.3 Inputs and outputs

- **Inputs** are a map of name to `{ label, example?, optional?, kind? }`, `kind` one of `text`
  (default), `number`, `date`, `choice` with `options`. A step refers to one as `$name`. The run
  card asks for every input before the first step ([§6.3](#63-the-run-card)); the model can supply
  them through `run_skill`, and the card still shows them. Values live in the run, never in the
  file and never in the skill's storage: there is no `GM_setValue` for a skill.
- **Outputs** are a map of name to `{ label, list?: true }`, filled by `read` steps. They are shown
  on the card of recorded facts at the end `[bu §5.4]` with Copy and, for a list, Copy as CSV; and
  they are appended to the chat's `note` `[bu §4.1]` so a model in the same chat can use them.
- **Constants.** A `fill` with a literal is allowed, because some forms want the same value every
  time, and the leak check flags every one on sharing ([§4.4](#44-the-leak-check)).

### 1.4 When it runs

On demand, in the tab the user is looking at, attended. Never on page load, never on a schedule,
never in the background, never on another site: all four are on the browser-use "Do not do" list
and nothing here reopens them. A skill is not registered with `chrome.userScripts` and never runs
as a script; the mods engine `[code: lib/exec/]` does not know it exists. "Run it when I open
this page" is a mod, and a user who wants that writes one.

### 1.5 Site scope

One site per skill and per run (D1). `match` decides whether a skill is offered on the current
tab, using `urlMatches` `[code: lib/mods.ts]` as the Mods tab does. The run's boundary is the
browser-use one: a navigation off the site pauses the run and asks `[bu §4.5]`. A file whose
`start` or any `go` is off its own `match` is refused at install, so a stranger cannot write a
skill that walks the user from one site to another; the boundary check at run time is the second
line, not the first.

## 2. How a skill is made

Four ways in, one rule for all of them: **a step in a skill made here is a step the extension
observed.** The model names what to keep; the extension writes the steps from its journal.

### 2.1 From a run the user just did: "save this as a skill"

The card of recorded facts at the end of a run that operated the page (`ON THE PAGE · 12 ACTIONS`
`[bu §5.4]`) gains one button, **SAVE AS SKILL**, in the GitHub build. Pressing it:

1. Takes the chat's journal from the first `act` of the turn to the last tool call, and compiles
   it ([§2.4](#24-the-compiler)).
2. Asks one question when there is something to ask: a card listing every value typed during the
   run, each with `input` (default) or `constant`, and a name derived from the field's label.
   "Which of these change each time?" Nothing else is asked.
3. Opens the result as the chat's draft: the same draft panel as a mod, with versions and a diff
   `[code: ArtifactPanel.tsx]`, labelled `DRAFT SKILL · File an expense · v1`. The model is told
   the draft exists through the same `[Current draft …]` block `[code: lib/agent/loop.ts renderTurn]`,
   so "rename the amount input to total" is an edit, as "make the button blue" is for a mod.
4. **SAVE** writes it to storage, beside the mods ([§8.1](#81-storage)).

A chat holds one draft. A chat that has a draft mod and operates the page cannot also have a draft
skill without replacing it; the button asks, as `open_mod` does `[code: lib/agent/tools.ts]`.

### 2.2 From a description: "write me a skill that…"

There is no mode (D5) and no special prompt. The model reads the request as the second use (do
something here) and does it, through `act`, confirmed as any run is. When it has done it once, it
calls **`propose_skill`**, a new tool beside `propose_mod`:

```
propose_skill {
  name, description,
  from_step?, to_step?,            // journal entry ids; default: this turn's first act to its last call
  inputs: [{ journal_step, name, label, optional? }],   // which typed values are inputs
  outputs: [{ name, label, from_step, take, list? }],   // which find_elements results are outputs
  constants?: [journal_step]       // typed values to keep literally (the user asked)
}
```

It is refused when no `act` has run in this chat since the last proposal (the "test it first" rule
of `propose_mod`, applied to steps), when a named journal step does not exist, when a `fill` the
model did not name as input or constant typed anything, and when an output's `from_step` is not a
`find_elements` call. The card is **PROPOSED SKILL · V1**, the same hero card, with
`recorded from 9 steps on expenses.example.com · tested in this chat`, **RUN AGAIN** (a replay of
the draft on the current page, the equivalent of RUN ONCE) and **SAVE**.

The prompt gains, in a build with `act`: `When the user wants something they can run again
("save this", "make this a skill", "write me a skill that…"), do it once with act, then call
propose_skill naming the typed values that should be inputs. You cannot write steps; usermods
records them.` About 60 tokens `[inferred]`.

**`read` steps.** An extraction ("list the download links") is a `find_elements` the model made and
then reported from. `propose_skill`'s `outputs` names that call and what to take from its matches
(`href`, `text`, `src`, an attribute). The compiler verifies the call existed and matched at least
one element, and writes a `read` step at that point in the sequence. The model declares the output;
the extension verifies it was looked at. A `read` whose selector the model never queried is
refused.

### 2.3 What is captured, and what never is

| Captured | How |
|---|---|
| Every `act` step: verb, the target as the extension described it (role, name, tag, landmark, stable selector, ordinal), `repeat` count, the model's `description` as `why` | From the journal `[bu §4.5]`, which already holds the gate's description of every step |
| `wait_for` calls and `then_wait` conditions between acts | As `wait` steps, with the condition and timeout |
| `wait_for` with `ask_user` | As `ask` steps, the request text and the condition that ended it |
| `go` URLs on the site | As `go` steps. The query string is scanned ([§4.4](#44-the-leak-check)) |
| Typed values | As `$input` references, or constants when the user said so |
| The first page's URL | As `start` |

| Never captured | Why |
|---|---|
| Anything typed into a password, one-time-code or card field | `act` refuses those steps `[bu §4.5]`, so they are never in the journal. A journal step the user did themselves during "your turn" is an `ask` step with no value |
| Page content, screenshots, `get_page` or `find_elements` results, `note` contents | A skill is steps, not a transcript. Outputs are declared selectors, not the values they produced. Form values are not even sent to the model since lane 4 `[code: main, lib/snapshot.ts valueIsSafe]` |
| `run_script` and `test_mod` calls | A script is not a step the extension can name or replay. A run that did its work by script has nothing to save, and the card says so: `this run used scripts; only its 3 act steps can be saved` |
| The chat, the model's reasoning, the user's messages | Not part of the work |
| What the guard held or the user declined | Not done, so not a step |

A run that handed the user a login ("your turn: sign in") saves an `ask` step at that point, with
the model's words and the condition that ended the wait. Someone else running the skill does the
same thing by hand. usermods holds no credentials and the file holds none.

### 2.4 The compiler

`lib/skillcompile.ts`, pure, tested under node: journal entries in, steps out.

- Consecutive `act` calls with several `steps` flatten to one step each, in order.
- A `fill` whose value matches a declared input, after trimming, becomes `fill: $name`. A value
  that appears in no declaration and was not marked constant is an error (the panel's card in
  [§2.1](#21-from-a-run-the-user-just-did-save-this-as-a-skill) prevents it; `propose_skill`'s refusal does the same for the model).
- A `wait` that immediately follows an `act` with `then_wait` is folded into it; a `wait` with
  only `ms` is kept but flagged in the preview as fragile.
- `go` to a URL off `match` is an error, not a step.
- The fingerprint's `css` is the best selector `find_elements` labelled for that element; when the
  registry has none (the step came from a selector the model typed), the compiler asks the content
  script for one before the run ends `[inferred: needs the registry to keep the element reference]`.
- Steps the gate refused or the user declined are dropped; a run with a dropped consequential step
  gets a note in the body: `one step was declined during recording and is not in this skill`.

### 2.5 Editing an existing skill, and by hand

- **Edit in chat**, on every skill row as on every mod row `[doc: docs/guide.md]`: the skill opens
  as the chat's draft, `open_skill` is the tool, and the model is told it is editing something
  installed. A change that needs a new step ("after saving, also download the receipt") is done on
  the page and re-proposed; the compiler splices the new journal entries where `propose_skill`'s
  `after_step` says, and the diff shows the insertion. A change to words, inputs or outputs is a
  re-proposal with no new run, allowed because no step changed.
- **By hand**: the dashboard's source editor opens the `.skill.md`, with the parser's warnings
  shown as the install screen shows a header's `[code: entrypoints/dashboard/ModsSection.tsx]`.
  A hand-written step is a step the extension did not observe. It is allowed (the file is the
  user's), and the skill's record gains `origin: edited`, which costs it the standing allowances
  of [§5.3](#53-what-asks-every-time) until it has walked one run.
- **Import file**: a `.skill.md` from disk, through the same preview as an install.

## 3. How a skill runs

A run is a replay through the machinery of `[bu §4]`: each step becomes the message the `act` tool
would have sent, and nothing downstream knows there was no model.

### 3.1 Where it starts

- The run card ([§6.3](#63-the-run-card)) is offered when the current tab's URL matches `match`.
  If the URL is on the site but is not `start`, the first thing the run does is `go start`,
  shown as a step; the `go` is on the site, so it is not consequential `[bu §4.5]`.
- Off the site, the row in the Mods tab reads `runs on expenses.example.com`, as a mod row says
  where it matches, and **Run** opens `start` in the current tab first, then starts. That is one
  navigation the user asked for by pressing Run; it does not make a run cross-site.
- The run binds to the tab, as every run does `[code: lib/sessions.ts]`.

### 3.2 Step by step

For each step, in order:

1. **Resolve the target** with `lib/interact/registry.ts`'s re-resolution `[bu §4.3]`: the fingerprint
   (`at` plus role and name) against the live document. Exactly one connected, visible match binds.
   None or several is a stop ([§3.3](#33-when-the-page-has-changed)); the drift guard (the element
   under the point is the target) applies as for `act`.
2. **Describe it** from the live element, not from the file: `lib/interact/describe.ts` gives the
   gate the role, name, form facts and link target it reads now.
3. **Gate it**: `lib/agent/gate.ts` decides allow, confirm or deny from that description and the
   allowances `[bu §4.4 mechanism 1]`. A `confirm: true` in the file forces confirm. The never list
   denies; a denied step stops the run with `step 4 was refused: it types into a password field`.
4. **Journal it** (`RunRecord.pending`), run it, clear it. A `wait` runs the `wait_for` path; an
   `ask` shows Your turn with the file's words and waits for `until` or **I have done it**; a
   `read` queries and appends to the output.
5. **Report it**: a touched row as `[bu §5.4]` draws it, `filled "Merchant"`, with the step number
   added: `3/9 · filled "Merchant"`.

The run is **driving** from its first step; the activity line reads
`running File an expense · 3 of 9 · filling "Amount" · 12s · Stop`, and the on-page bar reads
`usermods is running File an expense · 3 of 9 [STOP]` `[bu §5.5, §5.6]`.

### 3.3 When the page has changed

A step whose target resolves to nothing, or to several elements, or whose live description no
longer matches the recorded role and name (the button is there but it now says "Delete"), is a
**broken step**. The name check is strict on purpose: a recorded `click: button "Save"` may not
click a button that now reads anything else, whatever the selector says.

| Model connected and *Repair broken steps with the model* on | What happens |
|---|---|
| No | The run stops: `stopped at 4 of 9 · could not find button "Export" (0 matches; closest: 2 buttons in nav "Billing")`. The card offers **CONTINUE FROM 5** (the user does step 4 by hand, then presses it; the step is journalled as done by the user), **TRY AGAIN** (resolve once more, for a slow page) and **Stop** |
| Yes | The run pauses and hands that one step to the chat's model as a bounded sub-run: the system prompt, the skill's description and this step's `why` fenced as untrusted text with a nonce (the update review's technique `[code: lib/updates.ts buildReviewPrompt]`), the page inventory, and the instruction to carry out this step with `act` and nothing else: no `go`, no scripts, at most 8 tool calls. **Every `act` step the model makes during a repair is confirmed**, consequential or not ([§5.3](#53-what-asks-every-time)). When its `act` succeeds the run resumes at the next step. When the repair runs out of calls or the user declines, the run stops as above |

A repaired run ends with the card offering **UPDATE SKILL WITH THE REPAIR**: the broken step is
replaced by the journal entries the repair made, the patch version is bumped, and the diff is
shown. A skill installed from a URL that is repaired locally keeps its `updateURL`; the next
update from it will be reviewed against the repaired copy, which the powers diff shows.

This is Stagehand's rule, "replays a cached act() result deterministically with self-healing
turned off. If the recorded selector no longer resolves, Stagehand falls back to full inference"
`[src]`, with the inference confirmed because the model is whichever the user connected.
workflow-use, the closest product to this design, has the same fallback and calls its own
"currently really bad" `[src]`; the bounded sub-run and the confirmation are what make a bad
repair cheap here.

### 3.4 Pauses, Stop, resume, ceilings

- **Pauses**: consequential steps ask by name, from the live description (`ALLOW THIS? · click
  button "Submit expense" · it submits a form · step 9 of 9 of File an expense · the skill says:
  file the expense`); `ask` steps hand off; leaving the site pauses; leaving the tab pauses; the
  first run of an installed skill walks ([§5.3](#53-what-asks-every-time)). All are rows of the
  chat column, none on the page `[bu §4.4 mechanism 6]`.
- **Stop** is the same stop, between steps and between repeats. Nothing in a skill runs as a
  script, so there is no uninterruptible step.
- **Resume**: a run interrupted with a `pending` step is offered Resume; on resume the card shows
  the pending step and asks `Did this happen? · click "Submit expense"` with **IT DID, CONTINUE
  FROM 10**, **DO IT AGAIN** (goes through the gate again), **Stop**. No pending action is ever
  replayed on its own, tabagent's invariant `[doc: docs/research/tabagent.md]`. With a model
  connected the same question can be put to it first; its answer is shown, the choice stays the
  user's. Safari's automatic resume does not fire over a pending skill step, as `[bu §4.5]` says
  for `act`.
- **Ceilings**: a replay has no model round trips, so the 30-step turn ceiling does not apply. Its
  own: 200 steps in the file, 50 per `repeat`, and 500 actions per run, after which it pauses with
  **CONTINUE** as the model ceiling does `[bu §4.7]`. A repair sub-run is 8 tool calls. Wall time
  is not capped; an `ask` can wait as long as the user takes.
- **Inputs mid-run**: an input the card did not get (the user left an optional one empty and a
  step uses it without `when`) asks for it when the step is reached, in the panel.

### 3.5 The three uses and D5

A skill run is the second use, invoked. The chat is the same chat; the transcript shows the same
rows; a user can type while it runs and the message is read between steps, as while driving
`[bu §5.5]`. When the model starts a skill (`run_skill`) in the middle of a conversation, the run
card asks first; when the run ends, the model gets the outputs and the record as a tool result and
goes on. A chat is not "a skill chat"; it is a chat in which a skill ran, and the dashboard badge
says `ran File an expense · 9 actions`.

`run_skill { skill_id, inputs }` sits beside `act`: the user's turn lists the skills that match
the current URL, as it lists the mods installed on the page `[code: lib/agent/prompt.ts]`, and the
prompt says `When a listed skill does what the user asked, call run_skill with its inputs instead
of doing the steps yourself; the user confirms the run.` The model may not start a skill the card
has not confirmed, and may not bypass a skill by doing the same steps with `act` when the user
named the skill.

## 4. Sharing, installing, updating

## 5. Trust and safety of shared skills

## 6. The interface

## 7. Three skills, end to end

## 8. The build

## 9. Evaluation

## 10. Open questions

## Prior art

## Sources
