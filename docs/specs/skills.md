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

"The same way it shares reusable scripts": Export, a gist, a raw link that installs, a preview,
updates on review. One of the two sites is out.

### 4.1 Greasy Fork is out, the gist and the raw link are in

Greasy Fork's rules, read today: "Scripts must have a reason to be a script" and "Scripts must
include a description of what they do and may not do things unreasonably outside of this
description" `[src: code rules]`; external code is allowed from listed CDNs, from `@require` URLs
carrying a Tampermonkey-format integrity hash, and from its own libraries, which "can additionally
be set to sync from an external URL" `[src: external scripts]`. A library there "should not be
installed directly" `[src: a library's own page]`. Nothing on either page says a non-userscript
file may be posted, and a `.skill.md` is not a script: in Tampermonkey it would be a wall of text,
and dressed as a `.user.js` with a data body it would be a script with no reason to be one.
**Recommended: no Greasy Fork for skills in 0.2**, and no `.user.js` disguise to get there. The
Export menu's Greasy Fork item is absent on a skill row. Whether the maintainer would accept a
file type for one extension is open question 5, and the answer changes nothing in the format.

What stays:

| Way out | Mod today `[code: lib/share.ts, lib/sharecontroller.ts]` | Skill |
|---|---|---|
| Download | `<slug>.user.js` from `shareFileName` | `<slug>.skill.md`, the same slug rule |
| Copy | The whole source | The whole file |
| Share as Gist | Opens `gist.github.com`, fills name, description and file, points at the site's button; the user presses it; the gist is remembered and `@updateURL`/`@downloadURL` point at the sha-less raw URL | The same controller, the same fill, the same hint words with "script" read as "skill"; `updateURL`/`downloadURL` written into the front matter by `reheaderFields`' YAML sibling. A gist renders the Markdown, so the gist page is the human preview |
| Update gist | Bumps the patch version, fills the edit page | Same, `bumpPatch` on `version` |
| The install link | `https://gist.githubusercontent.com/<you>/<id>/raw/<slug>.user.js` | `…/raw/<slug>.skill.md`. GitHub serves it as `text/plain` `[inferred]`, which is what the raw detection reads |

The leak check runs first, as it does today, extended in [§4.4](#44-the-leak-check).

### 4.2 Installing from a raw link

The mod path is a `declarativeNetRequest` redirect of `.user.js` navigations to
`install.html#<url>`, an allow rule for code hosts' HTML views, and a Safari watcher that asks
the same question in code `[code: lib/installurl.ts, entrypoints/background.ts, docs/safari.md]`.
Skills add one pattern beside `USER_JS_PATTERN`:

```
SKILL_MD_PATTERN = ^https?://[^?#]+\.skill\.md([?#].*)?$
```

with the same `USER_JS_VIEW_PATTERN` exemption for blob pages, and `isSkillUrl` beside
`isUserScriptUrl`. The install page reads the URL from its fragment as now, fetches it with
`fetchBinary` (15 s, 5 MB, no credentials `[code: lib/install.ts]`), and decides by content: a
`==UserScript==` header is a script, a front matter with `usermods-skill: 1` is a skill, anything
else is refused with the existing message. `previewFromUrl` gains that branch; `mods.preview`
returns a tagged union `{ kind: 'mod' | 'skill', … }`.

The install banner `[code: lib/banner.ts]` learns the second file: on a gist page, a file whose
Raw link ends in `.skill.md`; on a raw text document, a first line of `---` followed within the
first 2 KB by `usermods-skill:`; on a GitHub blob page, the same. Greasy Fork and OpenUserJS
detection are unchanged, since no skill is there. The banner says `usermods can install the skill
"File an expense"` and **Install** opens the install page in skill mode.

**Identity** for "already installed": the download URL when both sides have one, else
`namespace` + `name`, the `scriptIdentity` rule `[code: lib/installurl.ts]`. A skill and a mod
with the same namespace and name are different things and never match each other.

### 4.3 The install preview

What a reviewer must be able to see before installing a stranger's skill, every line computed
from the parsed steps and front matter, never from the prose:

```
┌──────────────────────────────────────────────────────────────────┐
│ usermods · Install skill                                          │
│ Fetching from https://gist.githubusercontent.com/…/unsub.skill.md │
├──────────────────────────────────────────────────────────────────┤
│ Unsubscribe from the weekly digest                v1.0.2 · ns ada │
│ Turns off the weekly digest in your email preferences and saves. │
├──────────────────────────────────────────────────────────────────┤
│ RUNS ON        news.example.com (and subdomains)                  │
│                starts at /account/settings                        │
│ WHAT IT DOES   7 steps · 2 clicks · 1 navigation · 1 untick ·     │
│                2 waits · 1 reads                                  │
│ ▲ ASKS YOU     1 step submits a form: click "Save preferences".   │
│                usermods asks before it, every run.                │
│ TYPES          nothing                                            │
│ READS          the text of div.flash into "confirmation"          │
│ SENDS          nothing. A skill has no network and runs no code.  │
│                What it types and clicks goes where the site sends │
│                it. If a step breaks and repair is on, this file's │
│                words are shown to the model you connected.        │
│ INPUTS         none                                               │
│ YOUR FIRST RUN each step is shown before it happens               │
├──────────────────────────────────────────────────────────────────┤
│ ▼ steps (7)                                                       │
│   1  go /account/settings                                         │
│   2  click link "Email preferences"  in nav "Account"             │
│   3  wait  checkbox "Weekly digest" visible                       │
│   4  untick checkbox "Weekly digest"  in form "Email preferences" │
│   5  click button "Save preferences" ▲ submits a form             │
│   6  wait  text "Preferences saved"                               │
│   7  read  div.flash → confirmation                               │
│ ▼ the author's notes                                              │
│ ▼ source                                                          │
│                                        [ INSTALL ]   Cancel       │
└──────────────────────────────────────────────────────────────────┘
```

Rules the preview enforces, each a refusal with the line named, in `lib/skills.ts previewSkill`:

- The front matter parses; `usermods-skill` is 1; `name`, `description`, `version`, at least one
  valid `match`, `start` present.
- One site: every `match` host shares its last two labels with the first; `start` and every `go`
  match.
- Every step has one verb, a value of the right shape, and for element steps an `at` with at
  least `css`; a `fill` into a target whose role or name reads as password, one-time code or card
  (the never list's words `[bu §4.5]`) is refused outright, not warned.
- Inputs referenced exist; declared inputs are referenced.
- No step is a script, a `fetch`, a request or a file (there are no such verbs; the parser refuses
  unknown ones).
- Limits of [§1.2](#12-the-file).

Warnings, shown and not blocking: a `wait` with only `ms`; a `go` with a query string; a `click`
with `repeat` over 20; prose longer than 4 KB (it is what a model would read).

The counts under **WHAT IT DOES** and the **ASKS YOU** line use the consequential rule of
`[bu §4.5]` on the recorded names and form facts, and say so: `anything it can tell`. The
**SENDS** paragraph is fixed text, because it is true of every skill.

### 4.4 The leak check

`scanForLeaks` `[code: lib/leakscan.ts]` runs over the whole file as it does over a script: keys,
tokens, private hosts and addresses. Three rules are added for skills, in the same shape
(`kind`, `label`, line, masked preview):

| Kind | Finds | Why |
|---|---|---|
| `typed-value` | A `fill` or `select` with a literal value, not `$input` | "values captured from forms are the obvious leak": a name, an address, an account number typed during the recording. The default makes every typed value an input, so a literal is a choice the user made; the check asks once more before it is published |
| `url-query` | A `go` or `start` whose query string has a value of 12 characters or more that is not a plain word | Session tokens, signed links and ids travel in query strings |
| `prose-secret` | The existing rules, applied to the body | A pasted confirmation number or an email address in the notes |

The panel lists them with **Share anyway** and **Cancel** as today `[doc: docs/guide.md]`; a
`typed-value` offers **Make it an input** inline, which rewrites the step and adds the declaration.

### 4.5 Updates

`checkUrls`, `dueForCheck`, the daily cap, the byte budget, "never applied by a check" and
install-by-hash all carry over `[code: lib/updates.ts, lib/updatecontroller.ts]`; the check
recognises a skill by its front matter as it recognises a script by its header, and a `.meta`
shortcut is not needed because the file is small. The review screen (`install.html?update=<id>`)
gains a skill mode whose **What changed in its powers** is `skillPowersDiff(old, new)`:

- sites added or removed; `start` changed;
- steps added, removed or changed, listed as the preview lists them, with consequential ones
  first: `New step 8: click button "Delete account" ▲ (delete)`;
- inputs added or removed; outputs added or removed; constants changed;
- `ask` steps removed (a skill that used to hand you a step now does it);
- prose changed (shown as a diff; it matters only to repair, and the note says so).

**Check with the agent first** reuses `buildReviewPrompt` with a skill-specific system prompt
that asks about the same things in step terms (new consequential steps, inputs that look like
credentials, prose that addresses the model); the fences and the verdict parsing are unchanged
`[code: lib/updates.ts parseReview]`.

An update to an installed skill clears its walked-first-run flag and any standing allowance
([§5.3](#53-what-asks-every-time)): new steps have not been seen.

## 5. Trust and safety of shared skills

A skill written by a stranger operates pages in the user's signed-in browser. The format was
chosen so that most of what it can do is visible before it runs; this section is what holds, what
is asked, and what does not hold.

### 5.1 The three ways a stranger's file can hurt, and what the format does to each

| Way | In a recipe | In a script | In this format |
|---|---|---|---|
| **Instructions to the model** (prompt injection) | The whole file is instructions, and the model has `act` | The code is the attack; no model needed | The prose and every `why` are shown to the model **only during a repair**, fenced as untrusted with a nonce, for one step, with no `go`, no scripts, 8 tool calls, and every action confirmed. With repair off (the default for installed skills, [§5.3](#53-what-asks-every-time)), the model never reads the file |
| **Doing the wrong thing** (click Delete, submit, send) | Whatever the model does | Whatever the code does, which the guard can only observe `[bu §4.6]` | Every step is a named action gated from the live element. Consequential ones ask every run. The never list denies. The first run walks every step |
| **Taking data out** | The model can be told to | `fetch`, an image URL, a form `[bu §4.6]` | There is no network verb and no code. The only exits: what a `fill` types into the site's own form (the site then sends it where it sends it), and the outputs, which stay on the device unless a model in the same chat is given them through `note` |

The honest comparison with the browser-use spec's table in `[bu §4.6]`: a replayed skill is
*safer* than an ordinary chat on the same site, because the ordinary chat has `run_script` and
the skill has nothing that is not a gated action. Its risk is concentrated in two places: the
repair, and the resolution of a target.

### 5.2 What the install preview declares and verifies

Everything in [§4.3](#43-the-install-preview) is computed from the steps. The author's prose is
labelled as the author's and shown under its own heading; nothing in the preview's summary lines
comes from it. The guarantees a reader can take from the preview:

- **Sites**: the skill cannot take a tab off the site named, because `go` off `match` is refused
  at install and paused at run time.
- **Actions**: the verbs and their counts are the whole program. There is no hidden step.
- **Consequential**: the ▲ lines are the gate's own rule applied to the recorded names; at run
  time the same rule is applied to the live name, so an element renamed since the recording is
  caught either way (recorded "Save" now "Delete" stops the run by the name check; recorded
  "Delete" asks because it is on the list).
- **Reads**: the `read` steps and their outputs are listed; nothing else is read into anything.
- **Sends**: nothing, by construction, and the paragraph says the two real exits.
- **Inputs**: what the user will be asked to type, by label.

What the preview cannot say: whether "Save preferences" on this site does what the author says
it does, and whether the site has changed since the recording. The first is true of every
installed thing; the second is the first run's job.

### 5.3 What asks every time

Regardless of the file's own claims, in every build:

| | Rule | Standing allowance possible? |
|---|---|---|
| Password, one-time-code, card fields | Never typed into; a skill that tries is refused at install and denied at run time `[bu §4.5]` | No |
| Logins, 2FA, captchas, purchases | `ask` steps, done by the user `[bu "Do not do"]` | No |
| A consequential step (submit, send, delete, unsubscribe, pay, …, from the live element) | Asked by name, each run. "Allow every one of these in this run" for a `repeat` | Only for a skill with `origin: local` (made on this device from its own journal, never edited by hand, never updated from a URL): a per-skill **Do not ask again for this step** on the Allow card, listed under Settings › Operating pages with Remove. Cleared by any update or hand edit |
| A repaired step (any `act` the model makes during a repair) | Asked, always, consequential or not. The headline is the extension's read of the element; the model's reason is labelled as the model's `[bu §5.5]` | No |
| The first run of a skill that was installed, imported or hand-edited | Walks: every step is shown on an Allow-style card (`STEP 3 OF 7 · untick checkbox "Weekly digest" · the skill says: turn off the digest`) with **NEXT**, **RUN THE REST WITHOUT ASKING** (from step 3 on; consequential steps still ask) and **Stop**. iOS warns that a shared shortcut "hasn't been reviewed by Apple" and lets the user inspect it `[src: Apple platform security]`; this is the inspection, on the live page | After one complete walk, the skill is `walked` and later runs ask only what the rows above ask |
| A run started by the model (`run_skill`) | The run card is shown and must be confirmed; the model cannot confirm it | No |
| Leaving the site, leaving the tab, the ceiling | As `[bu §4.5]` | As there |
| "Ask before every step" on `[bu §4.5]` | Every step of every skill waits | — |

**Repair is off by default for installed skills** and on by default for local ones: the setting
*Repair broken steps with the model* in Settings › Operating pages has three values, `never`,
`skills made here`, `every skill`. The reasoning: the prose of a local skill is the user's own
model's words from the user's own run; the prose of an installed skill is a stranger's, and the
cheapest way to keep a stranger's words away from the model is not to show them. A user who
turns it on for every skill is told, on the setting, what that means.

**Shared recipes with "ask before every step" on by default**, the question the brief asked: there
are no pure recipes in 0.2 ([§1.1](#11-recipe-replay-or-script)), repaired steps always ask, and
the walked first run is "ask before every step" for exactly one run. That is the recommended
answer; making every run of an installed skill ask every step would make installed skills
useless for the forty-click cases they exist for, and the user can turn the global switch on.

### 5.4 Leak check on sharing

[§4.4](#44-the-leak-check). The rule the brief asked for: values captured from forms are refused
by default by construction (every typed value becomes an input), and the ones the user chose to
keep are listed, masked, before anything opens.

### 5.5 The residual risk

Said plainly, in the order I think it matters:

1. **A decoy with the recorded name.** Resolution is by role, name, stable selector, landmark and
   ordinal, and a page's content can be written by strangers `[bu §3.1]`. A reviewer who can put
   `<button>Unsubscribe</button>` inside the same landmark, with the same stable attribute, can
   make a recorded click land on their element. The drift guard, the "exactly one match" rule
   and the stable-selector check shrink this; they do not close it. A skill that clicks a link
   whose target the attacker controls is the realistic case, and the site boundary then pauses
   the run before the next step, which is after the click.
2. **The wrong ordinary thing.** A click nothing flags, on a site whose "Delete" is in another
   language, is not confirmed. The word list is English `[bu §4.5]`; the form rule covers
   submits in any language; the walked first run is the only control for the rest.
3. **Repair.** With repair on for installed skills, a stranger's prose reaches the model with
   the page in front of it. Every action is confirmed, the sub-run is bounded, there is no `go`
   and no script, and the model is the user's. That is a smaller injection surface than any
   ordinary chat on the same page has today, and it is not zero: a confirmed action the user
   does not read before allowing is still taken.
4. **What the site does with what it is sent.** A skill that fills a form fills it with the
   user's inputs; the site is where they go. usermods cannot know that the "Save preferences"
   form posts the user's email to a third party.
5. **Fingerprints decay.** A skill that resolves on the wrong element without a name mismatch
   is the failure the name check cannot see: two buttons called "Next" in two landmarks, and the
   landmark renamed. The evaluation measures this ([§9](#9-evaluation)) and the number is
   published rather than assumed.
6. **The outputs.** A `read` step reads what its selector matches. A stranger can write a skill
   whose `read` collects every message subject on the page into an output. The preview lists
   it, the output stays on the device, and a model in the same chat can be given it. Nothing is
   sent anywhere by the skill; the user decides what to do with the output.

No vendor claims to have solved any of this for agents that act on pages `[bu §2, sources]`, and
usermods has less than they do: no trained model, no classifier, no trusted input. The design's
claim is narrower: a replayed skill is bounded to steps a reader can see, each gated as the
extension's own `act` is, and the one place a stranger's words meet the model is off by default
and confirmed when on.

## 6. The interface

Consistent with `[bu §5]`: one panel, no mode, questions as rows of the chat column, permissions
only in an extension page, the components and tokens of `docs/design.md` in the BBS Underground
identity `[doc: AGENTS.md, docs/branding.md]`. Nothing here adds a colour, a shadow or a tab.

### 6.1 Words

| Thing | Word | Note |
|---|---|---|
| The saved object | **skill** | "a skill runs steps on a site when you ask"; a mod "changes a page on every visit" |
| Starting one | **run** | `Run File an expense`. Never "execute", never "play" |
| The file | `.skill.md` | Shown in the Export menu and the preview |
| The activity | **running <name>** | Beside **driving**, which stays for a model-led run |
| The card at the end | **On the page** | Unchanged; it gains outputs and SAVE AS SKILL |
| The proposal | **Proposed skill** | The hero card, as a mod's |
| First run of an installed skill | **walking through** | `walking through File an expense · step 3 of 7` |

### 6.2 Where a run starts

Four places, all of them existing surfaces:

1. **The Mods tab.** Its list gains a second heading. Today it is split into the mods matching
   this site and the rest `[code: ModsView.tsx]`; it becomes `MODS ON THIS SITE · OTHER MODS ·
   SKILLS ON THIS SITE · OTHER SKILLS`, each skill row with **Run** as the primary action where a
   mod has its on/off switch, then **Edit in chat**, **Export ▾** (Download, Copy, Share as Gist,
   Update gist), **Delete**. The tab keeps its name: the top bar `CHAT  MODS  ● host  ⚙ ▣ ◐` is
   load-bearing at 360px `[doc: docs/design.md]` and a fourth tab does not fit; the owner may
   prefer a rename (open question 6). *Install from URL* and *Import file* accept both kinds.
2. **The chat's empty state.** Under the three example lines of `[bu §5.3]`, when a skill matches
   the site, a block in the shape of the existing "or keep building on a mod that runs here":

   ```
   │  OR RUN A SKILL ON THIS SITE                   │
   │  [ RUN FILE AN EXPENSE ]  [ RUN EXPORT INVOICES ]
   ```

   Each is a `linklike` that opens the run card. Nothing is sent to the model.
3. **The composer's + menu** gains **Run a skill…**, which opens a picker of every skill, page
   matches first, in the shape of **Edit a mod…** `[doc: docs/guide.md]`. This is the one
   departure from `[bu §5.1]` ("nothing is added to the + menu"), and it is the smallest one:
   one item, present only in a build with `act`, and disabled with its reason when no skill is
   installed, which the menu pattern already allows `[doc: docs/design.md, Menus]`. The phone's
   Add sheet gets the same row.
4. **The model**, through `run_skill`, which lands on the same card.

### 6.3 The run card

A row of the chat column, on `--surface-2` with the primary rail, the shape of "Let usermods
operate this site?" `[bu §5.5]`:

```
▌RUN FILE AN EXPENSE?
▌9 steps on expenses.example.com · fills 3 fields · stops before Submit so you press it.
▌Merchant   [ Blue Bottle            ]
▌Amount     [ 42.00                  ]
▌Note       [                        ]  optional
▌usermods asks before anything it can tell sends, buys, deletes or unsubscribes.
▌[ RUN ]   Not now
```

The summary line is computed from the steps, as the preview's **WHAT IT DOES** is. When the
model started it, a line is added: `the model wants to run this with the values above`, and the
values are editable before RUN. When the site has no standing allowance and this is the chat's
first `act`, the card gains the "Let usermods operate…" paragraph and its tick box, one card
asking both, as `[bu §5.5]` does for a consequential first step. On the first run of an installed
skill the card ends `This is its first run here: each step is shown before it happens.`

### 6.4 The transcript

Rows are the browser-use rows. What a run adds:

```
│    you ran File an expense v1.0.0 · merchant, amount, note        │
│ ▌➤ 1/9 · went to /expenses/new                                     │
│ ▌➤ 2/9 · filled "Merchant"                                         │
│ ▌➤ 3/9 · filled "Amount"                                           │
│ ▌➤ 4/9 · filled "Note"                                             │
│ ▌●  5/9 · waited · button "Submit" visible                         │
│ ▌YOUR TURN                                                         │
│ ▌Check the form and press Submit.                                  │
│ ▌It continues by itself when the page shows "Expense filed".       │
│ ▌[ I HAVE DONE IT ]   Stop                                         │
│    you did this step: press Submit                                 │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ ON THE PAGE · FILE AN EXPENSE · 6 STEPS                        │ │
│ │ expenses.example.com · 1 page · 31s                            │ │
│ │ 3 fields · 1 navigation · you did 1 yourself                   │ │
│ │ OUTPUTS  confirmation: EXP-20261008-0142         [COPY]        │ │
│ │ ▼ actions                                                      │ │
│ └────────────────────────────────────────────────────────────────┘ │
```

The opening note row is the one place inputs are shown in the transcript, by name only; the
values are on the card the user filled in, and are stored with the transcript as the user's
message is. A run that was not a skill ends in the same card with **SAVE AS SKILL** beside the
action count, in the GitHub build, when the run had at least one `act` step and no script. A
broken step is an error row, `could not find button "Export" · stopped at 4/9`, followed by the
card with CONTINUE FROM 5 / TRY AGAIN. A repair is a sub-section of rows under a note
`repairing step 4 with claude-opus-5`, its own looked and touched rows, each touched one having
asked.

On a phone, three or more consecutive rows fold as today, and the fold counts steps: `9 steps ·
9 on the page` `[code: lib/compactshell.ts stepsSummary]`.

### 6.5 The draft panel and proposal card

A draft skill is the chat's artifact, one per chat, with the same bar, version strip, diff, roll
back and inline rename `[code: ArtifactPanel.tsx]`. The collapsed line reads `DRAFT SKILL · File
an expense · v2 · 9 steps` and its buttons are **RUN AGAIN** and **SAVE** (later **UPDATE SKILL**,
and **Save as a new skill instead** when editing an installed one). The proposal card is the
hero card: `PROPOSED SKILL · V1`, name, `recorded from 9 steps · tested in this chat`, RUN AGAIN,
SAVE. Expanded, the draft shows the file with the steps block rendered as the preview's list and
the source under it.

### 6.6 The dashboard, Settings, titles

- **Dashboard › Mods** gains a kind filter beside the site filter: `All · Mods · Skills`. A skill
  row shows version, site, step count, inputs by label, where it came from (a download host,
  *recorded in chat*, *imported*), and `walked` or `first run pending` for an installed one. The
  source editor edits the file with the parser's warnings. Bulk export zips both kinds. The
  overview strip counts skills beside mods.
- **Dashboard › Chats**: the badge `ran File an expense · 9 actions` beside `on the page ·
  14 actions` `[bu §5.7]`; the filter gains `Ran a skill`.
- **Settings › Operating pages** `[bu §5.7]` gains: *Repair broken steps with the model*
  (`never` · `skills made here` · `every skill`, default the middle), with the help text `When a
  skill cannot find a step's target, the model you connected is shown that step's notes and
  asked to do it; every action it takes is confirmed. For a skill you installed, its notes were
  written by someone else.`; and the list *Steps you allowed without asking* under the sites
  list, each `File an expense · click "Submit expense"` with Remove.
- **Titles**: a chat in which a skill ran is titled as any chat is `[code: lib/title.ts]`; the
  skill's name is in the first user turn's note, so the titler sees it.

### 6.7 The iPhone and iPad popup

The compact shell `[doc: docs/design.md]` and the rules of `[bu §5.8]`:

- Skills are in the Mods tab under the same headings; **Run** is on the row and in the row's
  "more" sheet.
- The run card is in the popup: inputs are typed there, RUN pressed there. Then, as for driving:
  `Close this sheet to watch. Stop is on the bar at the top of the page.` The run holds the page's
  keepalive port `[code: lib/keepalive.ts]`.
- Every question is answered in the popup; the bar says `usermods needs an answer · open
  usermods`. `ask` steps are the exception already made for "your turn": the bar carries the words
  and **I HAVE DONE IT** at 44px.
- The walked first run on a phone is slow by design (open the popup for every step). The card
  says so and offers RUN THE REST WITHOUT ASKING from the first step; the recommendation stands
  because a phone is where a mis-click costs most.
- Outputs are read in the popup when it is reopened; Copy is there.

### 6.8 The store build

Absent entirely, with `act` ([§8.3](#83-the-store-question)): no headings in the Mods tab, no
menu item, no run card, no redirect rule for `.skill.md`, no install mode, no `propose_skill`.
A `.skill.md` link in the store build renders as the text it is. Nothing in that build names
what it lacks, as `[bu §5.9]` requires.

## 7. Three skills, end to end

Three fictional sites, so the fixtures of [§9](#9-evaluation) can be the same three pages. Each:
what the user types, the file as saved, what the preview shows to someone installing it, a run,
and where it asks.

### 7.1 A form with inputs: file an expense

**What the user types**, on `https://expenses.example.com/expenses/new`:

> fill this in for lunch at Blue Bottle, 42 dollars, and let me press submit. then save that as
> a skill

**What happens.** The model calls `find_elements` on the form, then one `act` with three `fill`
steps, then `wait_for { selector: 'button[type=submit]', ask_user: 'Check the form and press
Submit.' }`. The panel asks "Let usermods operate expenses.example.com?" (first `act` in the
chat), fills, shows Your turn; the user presses Submit; the page shows "Expense filed"; the
model calls `propose_skill` naming the three typed values as inputs, `note` optional. The
proposal card appears.

**The file**, as the draft panel shows it and SAVE writes it (the front matter of
[§1.2](#12-the-file) is this example; the steps):

```steps
- go: /expenses/new
  why: open the new-expense form
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
- wait: { selector: "button[type=submit]", state: visible }
- ask: Check the form and press Submit.
  until: { text: "Expense filed" }
```

`go` is first because the model recorded from `/expenses/new` and `start` says so; the compiler
writes it so a run from `/expenses` still lands on the form.

**The preview** for someone installing it from the gist link: `RUNS ON expenses.example.com ·
starts at /expenses/new`; `WHAT IT DOES 6 steps · 3 fields · 1 navigation · 1 wait · 1 your
turn`; `ASKS YOU nothing it can tell; step 6 is yours: "Check the form and press Submit."`;
`TYPES merchant, amount, note (your inputs)`; `READS nothing`; `INPUTS Merchant · Amount ·
Note (optional)`.

**A later run**, from the Mods tab on the same site: the run card asks the three inputs; row 1
`went to /expenses/new`; rows 2 to 4 filled; row 5 waited; Your turn; the user presses Submit;
the card `ON THE PAGE · FILE AN EXPENSE · 5 STEPS · you did 1 yourself`. Nothing was asked
beyond the inputs, because nothing in the skill submits.

**The variant that submits.** Had the user said "and submit it", the last steps would be
`click: button "Submit expense"` with `at: { css: "button[type=submit]", in: 'form "New
expense"' }` and `wait: { text: "Expense filed" }`. The preview would carry `▲ ASKS YOU 1 step
submits a form: click "Submit expense". usermods asks before it, every run.`, and every run
would show the Allow card at step 6, headline from the live button. For the user's own skill,
that card offers **Do not ask again for this step**; for the installed copy it does not.

### 7.2 A process across pages of one site: export this month's invoices

**What the user types**, on `https://billing.example.com/`:

> write me a skill that exports this month's invoices as a CSV and lists the invoice numbers

**What happens.** The model: `act { go: '/invoices' }` (on the site, not consequential),
`find_elements` for the period control, `act { select: 'This month', target: listbox "Period" }`
with `then_wait { selector: 'table tbody tr' }`, `find_elements 'table tbody tr td.number'` (the
list it reports from), `act { click: button "Download CSV" }` and `wait_for { ms: 1500 }` for the
download. "Download CSV" is not on the consequential list and is a button, not a submit, so
nothing asks beyond the first-`act` card. Whether a synthetic click on an `<a download>` starts
a download without user activation is `[untested]` (a `window.open` would be blocked `[bu §3.2]`);
the fixture decides, and if it fails the model's run ends in `ask: Press Download CSV.` and so
does the skill. The model calls `propose_skill` with no inputs and one output,
`invoices` from the `find_elements` call, `take: text`, `list: true`.

**The file:**

```markdown
---
usermods-skill: 1
name: Export this month's invoices
description: Filters the invoices page to this month, lists the invoice numbers and downloads the CSV.
namespace: kenneth
version: 1.0.0
match: ["*://billing.example.com/*"]
start: https://billing.example.com/invoices
inputs: {}
outputs:
  invoices: { label: Invoice numbers, list: true }
---

# Export this month's invoices

Opens the invoices page, picks "This month", reads the invoice numbers and downloads the CSV.
Made with usermods 0.2 on 2026-10-08 from a run on billing.example.com.

```steps
- go: /invoices
  why: open the invoices page
- select: This month
  into: listbox "Period"
  at: { css: "select#period", in: 'form "Filters"' }
  why: show only this month's invoices
- wait: { selector: "table tbody tr", state: visible }
- read: invoices
  from: "table tbody tr td.number"
  take: text
  each: true
  why: collect the invoice numbers shown
- click: button "Download CSV"
  at: { css: "a#download-csv", in: 'region "Invoices"' }
  why: download the filtered list
- wait: { ms: 1500 }
```
```

**The preview:** `RUNS ON billing.example.com · starts at /invoices`; `WHAT IT DOES 6 steps ·
1 click · 1 navigation · 1 choice · 2 waits · 1 reads`; `ASKS YOU nothing it can tell`; `TYPES
nothing`; `READS the text of table tbody tr td.number into "Invoice numbers"`; a warning,
`step 6 waits a fixed 1.5 s; a wait on a condition is more reliable`.

**A run two months later**, after the site renamed its filter: step 2's `select#period` is gone
and no listbox is named "Period". With repair at its default (`skills made here`), and this
being the user's own skill, the run pauses: `repairing step 2 with claude-opus-5`, the model
reads the inventory, finds `combobox "Billing period"`, calls `act { select }`; the Allow card
asks (every repaired action asks): `ALLOW THIS? · choose "This month" in combobox "Billing
period" · the model says: show only this month's invoices`. Allowed; the run resumes at step 3;
the card at the end offers **UPDATE SKILL WITH THE REPAIR** and the diff shows step 2's new
target. On the installed copy of the same skill, with repair at its default, the run stops at
step 2 with `could not find listbox "Period" (0 matches; closest: combobox "Billing period")`,
and the user can pick the period by hand and press CONTINUE FROM 3.

### 7.3 An extraction: download links for every photo in an album

**What the user types**, on `https://photos.example.com/albums/2026-kyoto`:

> load the whole album and give me the download links for all the photos

**What happens.** The model: `act { click: button "Load more", repeat: 50 }` (one card, because
`repeat` asks once with its count only when the click is consequential, and "Load more" is not;
so nothing asks beyond the site card), `find_elements 'a.photo-download'` which lists each link
with its URL `[bu §4.3]`, and answers with the list. The user says "save that as a skill"; the
card's SAVE AS SKILL compiles it, and asks nothing, since nothing was typed. The output is the
`find_elements` call, `take: href`.

**The file's steps:**

```steps
- click: button "Load more"
  at: { css: "button.load-more", in: 'main "Album"' }
  repeat: 50
  why: load every photo in the album
- wait: { idle: true, quiet_ms: 800 }
- read: links
  from: "a.photo-download"
  take: href
  each: true
  why: collect each photo's download link
```

with `match: ["*://photos.example.com/*"]`, `start: https://photos.example.com/albums/` and
`outputs: { links: { label: Download links, list: true } }`. `start` is a prefix the user edits
to the album; a run offered on any album page uses the page it is on, since `start` matches it.

**The preview:** `WHAT IT DOES 3 steps · 1 click (up to 50 times) · 1 wait · 1 reads`;
a warning, `step 1 repeats up to 50 times`; `READS the href of a.photo-download into "Download
links"`.

**A run:** the row `1/3 · clicked "Load more" ×14 → none left`, `2/3 · waited · quiet`, `3/3 ·
read 212 download links`; the card shows `OUTPUTS Download links · 212 [COPY] [COPY AS CSV]`.
No question was asked after the site card. When the album has a "Delete album" button beside
"Load more" and a renamed site swaps their classes, the name check stops the run at step 1
rather than click it: `could not click button "Load more" · the element at button.load-more is
now button "Delete album"`.

## 8. The build

## 9. Evaluation

## 10. Open questions

## Prior art

## Sources
