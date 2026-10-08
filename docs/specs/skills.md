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

## 3. How a skill runs

## 4. Sharing, installing, updating

## 5. Trust and safety of shared skills

## 6. The interface

## 7. Three skills, end to end

## 8. The build

## 9. Evaluation

## 10. Open questions

## Prior art

## Sources
