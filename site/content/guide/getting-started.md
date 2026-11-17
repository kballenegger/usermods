# Getting started with usermods

To start using usermods, add it to Chrome 135 or later, turn on **Allow User Scripts** for it in `chrome://extensions`, then connect a model in its Settings. After that you open the side panel on any page and describe the change you want.

## Install

1. Add usermods to Chrome from the Chrome Web Store, using the **Get usermods** button at the end of this page. It is free and open source (MIT).
2. Open `chrome://extensions`, click **Details** on usermods, and turn on **Allow User Scripts**. Chrome requires this toggle for any extension that runs user scripts, including Tampermonkey. Without it, saved mods cannot run.
3. Click the usermods icon in the toolbar. The side panel opens on that tab.

## Connect a model

usermods has no account and no hosted model. It talks to a model you choose.

1. In the side panel, go to **Settings**.
2. Under **Add provider**, click a preset: Anthropic, OpenAI, xAI Grok, OpenRouter, a local server such as Ollama or LM Studio, or Custom.
3. Paste an API key, or a local server URL. It saves as you type.

If you pay for ChatGPT (Plus, Pro, Team) or SuperGrok, you can sign in with that instead of a key. See [Using a ChatGPT or SuperGrok subscription](/guide/subscriptions).

![Settings with three connected providers and the Add provider presets](/assets/guide/04-settings.png)

## Make your first change

Go back to **Chat**. The model this chat uses is the chip in the chat bar. Describe what you want, for example "hide the sidebar on this site". usermods reads the page, writes a userscript, tests it, and shows it with **Try** and **Save**. Saved mods run by themselves every time a matching page loads. See [Writing a mod in chat](/guide/write-a-mod).

Before your first message, the panel shows what it will send to your provider. [Privacy](/guide/privacy) has the details.

## Other browsers

The Chrome Web Store build runs in Chrome. A Safari build for Mac, iPhone and iPad can be built from the [source on GitHub](https://github.com/kballenegger/usermods).
