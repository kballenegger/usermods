# Contributing to usermods

Thanks for taking an interest. usermods is a small, opinionated codebase and it would like to stay
that way — readable end to end, with tests that run without a browser wherever the logic allows it.

## Getting set up

You need **Node 22+** and **Chrome 135+** (the extension uses `chrome.userScripts`, which needs
135).

```sh
git clone https://github.com/kballenegger/usermods
cd usermods
npm install          # runs `wxt prepare`, which generates .wxt/ types
npm run dev          # WXT dev server, hot reload, opens a Chrome profile with the extension loaded
```

`npm run dev` handles loading the extension for you. To use a build instead, run `npm run build`,
then in Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
pick `.output/chrome-mv3`. Either way, open **Details** on usermods and turn on **Allow User
Scripts** — Chrome requires that toggle for any extension that runs user scripts, and nothing works
without it.

Then open the side panel, go to Settings, add a provider, and pick its model under the message box. For development, a local model
(Ollama, LM Studio, mlx_lm) through the OpenAI-compatible preset costs nothing and is usually enough.
You do not need a real model at all for the tests or the smoke run — both use a scripted mock.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | WXT dev server with hot reload, Chrome. `dev:firefox` for the Firefox target. |
| `npm run build` | Production build to `.output/chrome-mv3`. `build:firefox` for Firefox. |
| `npm run build:store` | The Chrome Web Store variant: sets `USERMODS_STORE=1`, which drops subscription sign-in and tree-shakes `lib/oauth.ts` out of the bundle, and builds to `.output/store-chrome-mv3`. `zip` and `zip:store` package the two builds. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Node's built-in runner over `test/*.test.ts`, via `--experimental-strip-types`. No bundler, no browser, fast. |
| `npm run smoke` | Builds to `.output/test-chrome-mv3`, then drives the real side panel headless in Playwright against `scripts/mock-llm.mjs`, asserting the whole chat loop end to end. |
| `npm run screenshots` | Regenerates the README and [docs/screenshots.md](docs/screenshots.md) images through the same harness. |
| `npm run store-assets` | Regenerates the Chrome Web Store screenshots and promo tiles into `docs/store/assets/`. |
| `npm run styleguide` | Rebuilds and recaptures the living style guide into `docs/design/`, which `docs/design.md` embeds. |

### Three output folders, on purpose

`.output/chrome-mv3` (from `npm run build` / `npm run dev`) is the only folder meant to be loaded
unpacked in a real browser — it is the one this file's setup instructions point at, and it is
probably the one you have open in Chrome right now. `npm run build:store` writes to
`.output/store-chrome-mv3` instead, and every script that launches a browser against a build
(`smoke`, `screenshots`, `store-assets`, `styleguide`, `screenshots:settings`) writes to
`.output/test-chrome-mv3` (set via `USERMODS_TEST_BUILD=1`, see `scripts/build-dir.mjs`). Before
this split, all of those wrote to the same `.output/chrome-mv3`, so running `npm run smoke` (or a
store build) while the real extension was loaded from that folder would silently replace it —
Chrome reloads whatever is on disk the next time the service worker restarts, mid-session. Keeping
the three apart means only a deliberate `build` or `dev` ever touches the folder Chrome is actually
pointed at.

Two notes on the harness. `scripts/mock-llm.mjs` is a local server that replays scripted
conversations over the OpenAI wire protocol, so neither `smoke` nor `screenshots` needs an API key or
a live model — but the page-inspection tools run for real against live pages. It defaults to port
8791; set `MOCK_LLM_PORT` if that is taken. And read the comment at the top of
`scripts/screenshots.mjs` before touching it: driving a side panel without a real side panel involves
a trick or two.

## Architecture, in the order you will need it

[docs/architecture.md](docs/architecture.md) has the diagram and the agent loop in detail. The short version of where
things live:

- **`entrypoints/background.ts`** — the service worker. The RPC endpoint for the panel, the agent's
  tool implementations, `chrome.userScripts` registration, the `GM_xmlhttpRequest` host, the
  `.user.js` redirect rule. It is the biggest file and the center of everything.
- **`entrypoints/sidepanel/`** — the React UI: `Chat.tsx`, `ModsView.tsx`, `SettingsView.tsx`,
  `Consent.tsx` (the first-run data notice), and `App.tsx` which tracks the active tab.
  `ProvidersSection.tsx` is the provider list in Settings, `ModelPicker.tsx` the model dropdown
  under the composer, and `useConnections.ts` the live read of connections both are drawn from.
- **`entrypoints/content.ts`** — DOM snapshotting, the element picker, selector and style lookups.
- **`entrypoints/install/`** — the install page a `.user.js` navigation lands on.
- **`lib/providers/`** — one adapter per wire protocol behind the `Provider` interface in
  `providers/types.ts`. `anthropic.ts` uses the official SDK; `openai.ts` speaks chat completions
  over raw fetch; `responses.ts` speaks the Responses API that the subscription backends use.
  `index.ts` is the factory that maps a `ProviderKind` to one of them.
- **`lib/agent/`** — provider-neutral. `prompt.ts` is the system prompt, `tools.ts` the tool
  definitions (`get_page`, `find_elements`, `get_styles`, `run_script`, `screenshot`,
  `propose_mod`), `loop.ts` the turn loop that streams text, dispatches tool calls and feeds results
  back.
- **`lib/mods.ts`** — userscript header parsing and match logic. `lib/gm.ts` — the `GM_*` / `GM.*`
  shim injected around every registered script. `lib/connect.ts` — `@connect` enforcement.
  `lib/tampermonkey.ts` — backup import. `lib/install.ts` / `lib/installurl.ts` — the install path.
- **`lib/chats.ts`** — per-site chat persistence in `chrome.storage.local`, including the model
  each chat talks to.
- **`lib/connections.ts`** — the connected providers and per-chat model selection: the migration
  from the old single-provider settings, CRUD, what counts as connected, what the picker lists, and
  `effectiveSettings()`, which turns a chat's selection into the `Settings` every adapter takes.
  `lib/modellist.ts` — how each backend lists its models, and the fallback when one cannot.
- **`lib/buildflags.ts`** — the store-build flag and everything that depends on it.

The pure logic is deliberately separated from the `chrome.*` calls, in files that import types only.
That is what makes `npm test` possible without a browser, and it is the pattern to follow: when you
write something with real logic in it, put the logic where a node test can reach it.

## Adding a provider

Most endpoints need no code at all — anything speaking the Anthropic Messages or OpenAI
chat-completions protocol works today by typing a base URL into the Custom preset. Only a genuinely
different wire protocol or auth scheme needs a new adapter. If you just want a one-click preset for a
service that speaks an existing protocol, that is the `KEY_PRESETS` array in `lib/connections.ts` and
nothing else.

For a real adapter:

1. Add the kind to `ProviderKind` in `lib/types.ts`.
2. Write `lib/providers/yours.ts` exporting a factory that returns a `Provider` — one `chat()`
   method taking `{ system, messages, tools, signal, callbacks }` and returning `{ content,
   stopReason }`. Stream text through `callbacks.onText` as it arrives, translate the provider's tool
   calls into `Part`s, and map its finish reason onto the `stopReason` union. Honour `signal` so Stop
   works.
3. Wire it into the `switch` in `lib/providers/index.ts`.
4. Add a preset in `lib/connections.ts`, and teach `modelsRequest` in `lib/modellist.ts` how the
   backend lists its models. Then add the adapter to the swap matrix in `test/swap.test.ts`: the
   model can be changed mid-conversation, so your adapter has to produce a valid request from a
   history any other adapter wrote, and must never replay another backend's `opaque` parts.
5. Test the translation layer. Request shaping and response parsing are pure functions of their
   input — factor them so a node test can exercise them without the network.

If it needs OAuth rather than an API key, look at `lib/oauth.ts` and `lib/buildflags.ts` first:
subscription providers are excluded from the Web Store build, and the dynamic import in
`providers/index.ts` that keeps the auth module out of that bundle is load-bearing, not incidental.

## Every fix lands with a regression test

This is the one hard rule. **A bug fix is not done until there is a test that fails without it.**

Write it first if you can. Put it in `test/` as a node test whenever the logic can be reached from
there — that is why parsing, matching, `@connect`, header handling and the backup importer all live
in chrome-free modules. When a bug genuinely only exists in the wiring (message passing,
registration, UI state), extend the smoke run in `scripts/screenshots.mjs` with an assertion instead,
and say in the PR why a unit test could not reach it.

New features want tests too, but the standard is judgement rather than a rule. A fix has no such
latitude: something was wrong, and a test is how we learn if it goes wrong again.

## Design

If you are touching anything visual, read **[docs/design.md](docs/design.md)** first. It is the
reference the interface is designed from: the role palette for both themes with hexes and OKLCH
values, the tonal scales, the contrast table, typography, every component with its states and
do/don'ts, motion, theming and the accessibility commitments. It ends with a checklist for adding a
new surface — work through it before you open the PR.

Three things will save you a review round:

- **Use role tokens, never a hex.** Components name `--primary-*`, `--live-*`, `--accent-*`,
  `--info-*`, `--warn-*`, `--error-*`, `--surface-*`, `--text-*`. No hex belongs outside
  `entrypoints/sidepanel/tokens.css`. (The one exception is the in-page element picker in
  `entrypoints/content.ts`, which runs on other people's pages where CSS variables do not reach.)
- **Add your real pairings to `test/contrast.test.ts`.** It is a gate, and it checks both themes. A
  new colour token that is not restated for the day theme also fails there.
- **Anything you read a sentence of goes on a solid panel, in a text face, at ≥13px.** The pixel
  display face is for short labels only and never below 11px.

The living style guide at `entrypoints/styleguide/` renders every component with the real
stylesheets. In a dev build it is linked from the dashboard footer, or open `/styleguide.html?styleguide=1`
directly. Re-capture it with `npm run styleguide` if you change a component's appearance.

## Before you open a PR

All four of these have to pass:

```sh
npx tsc --noEmit
npx wxt build
npm test
npm run smoke
```

The PR template repeats this as a checklist. If one of them cannot pass for a reason you understand
and accept, say which and why in the description — an honest note is fine, a silent red gate is not.

## Commit style

Conventional-ish, lowercase, imperative, scoped when a scope helps:

```
fix(gm): persist GM_setValue writes from the page world
feat: add a store build flag that omits subscription sign-in
docs(store): reconcile submission docs with the store build
```

`feat`, `fix`, `docs`, `refactor`, `test`, `chore` all get used. The subject line says what changed
in a way that makes sense in `git log --oneline`; the body, when there is one, says *why*, and why
this way rather than the obvious alternative. Look at the existing history and match it.

Keep commits coherent. A refactor and the behaviour change it enables are two commits, and a review
is far easier for it.

## Things worth knowing before you propose something big

- **The extension has no server and collects nothing.** No telemetry, no analytics, no crash
  reporting, no account. A feature that needs a usermods-operated backend is not going to land, and
  [PRIVACY.md](PRIVACY.md) is a promise, not a draft.
- **Mods are plain userscripts.** Nothing proprietary in the format, and Tampermonkey compatibility
  is the compatibility target. If a change would make a usermods script fail to run under
  Tampermonkey, it needs a very good argument.
- **The user approves what runs.** Scripts are previewed before saving and proposals before
  installing. Do not add a path that skips that.
- **Open an issue before a large change.** For a typo or a clear bug, just send the PR. For anything
  with a design in it, an issue first saves you writing code in a direction that will not be taken.

## Security

Do not report a vulnerability in a public issue or PR. See [SECURITY.md](SECURITY.md) for private
reporting through GitHub security advisories.

## License

usermods is MIT. By contributing, you agree that your contributions are licensed under it.
