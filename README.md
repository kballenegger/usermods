# usermods

**Vibe-code userscripts in place.** An open-source browser extension that lets you customize any website by chatting with the LLM of your choice.

Open the side panel on any page, describe what you want changed, and usermods inspects the page, writes a userscript, tests it live, and hands it to you with *Try* and *Save* buttons. Saved mods run automatically on every matching page load. Export them as standard `.user.js` files, or import ones from Greasy Fork.

Userscripts, userstyles, usermods.

## Why

- **Any backend.** Anthropic's API, OpenAI, OpenRouter, or anything OpenAI-compatible: Ollama, LM Studio, vLLM, mlx_lm. Your key, your machine, no account, no hosted service.
- **The model actually sees the page.** It has tools to read a pruned DOM, list elements, read computed styles, take screenshots, and run scripts to test its work before proposing anything.
- **One-off tasks too.** "Scroll to the bottom, open every carousel, and give me download links for all the photos" runs as a script, no mod required.
- **Portable.** Mods are plain userscripts with a `==UserScript==` header. Nothing proprietary.
- **MIT.**

## Status

Early. The core loop works end to end: chat, page inspection, live testing, propose, save, run on load, import and export. See [Roadmap](#roadmap).

## Install (from source)

Requires Node 22+ and Chrome 135+.

```sh
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `.output/chrome-mv3`.
2. Click **Details** on usermods and turn on **Allow User Scripts**. Chrome requires this toggle for any extension that runs user scripts, including Tampermonkey.
3. Click the usermods icon to open the side panel. Go to **Settings**, pick a provider, paste a key (or a local server URL), and save.

For development, `npm run dev` starts WXT with hot reload and opens a Chrome profile with the extension loaded.

## Providers

Two wire protocols, any endpoint:

| Preset | Protocol | Base URL |
|---|---|---|
| Anthropic | Anthropic Messages | `https://api.anthropic.com` |
| OpenAI | OpenAI chat completions | `https://api.openai.com/v1` |
| xAI Grok | OpenAI chat completions | `https://api.x.ai/v1` |
| OpenRouter | OpenAI chat completions | `https://openrouter.ai/api/v1` |
| Ollama, LM Studio, vLLM, mlx_lm | OpenAI chat completions | your local server |
| Custom | either | anything you type |

The base URL is always editable. Anything that speaks one of the two protocols will work, so a self-hosted gateway, a corporate proxy, or a model router all drop in.

### Using a subscription instead of an API key

usermods talks only to the two APIs above and never handles vendor logins. If you want to run it against a Claude, ChatGPT or other subscription, run a local proxy that exposes that login as an Anthropic- or OpenAI-compatible endpoint, and point a Custom preset at it. Several open-source projects do this. Whether that is allowed depends on the vendor's terms, which have changed more than once in 2026, so check before you rely on it. Anthropic's sanctioned route for subscriptions is the Agent SDK credit, which requires the Claude Code CLI on your machine; a proxy built on that is the clean option.

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
- **The agent loop** (`lib/agent/`) is provider-neutral. Tools: `get_page`, `find_elements`, `get_styles`, `run_script`, `screenshot`, `propose_mod`.
- **Mods** are stored in `chrome.storage.local` as full userscript text. The header is parsed for name, description and `@match` patterns. Enabled mods are registered with `chrome.userScripts` in the `USER_SCRIPT` world at `document_idle`.
- **Chat history** is kept per tab in `chrome.storage.session`, so it survives the service worker sleeping but not a browser restart.

## Security notes

- Page content that the model reads is untrusted. The system prompt tells the model to treat it as data, and every generated script is shown to you before it is saved. Read it.
- Scripts run in an isolated world: they see the DOM but not the page's JavaScript globals. Default `@match` is the current site only.
- Your API key is stored in extension local storage and sent only to the endpoint you configure.

## Roadmap

- Agent mode with proper click, type and scroll tools plus screenshot-driven verification, for tasks the DOM-script approach handles poorly.
- Edit an existing mod from chat ("make the button blue instead").
- Mod sharing: export is there; a gallery is not.
- CSS-only mods via a `@usermods-style` header, so pure restyles need no JavaScript.
- Firefox, once its side panel story is settled.

## License

MIT
