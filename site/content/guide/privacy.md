# Privacy in usermods

usermods has no server, no account and no telemetry, and its author receives no data. When you send a message, your message and the page content the model needs go directly from your browser to the model provider you picked for that chat, and nowhere else.

## What is sent to your model provider

When you send a message, usermods sends to the provider of that chat:

- your message and any images you attached,
- the page's address and title,
- a pruned copy of the page's HTML, and details of elements the model looks up or you point at,
- a screenshot of the visible tab, when the model asks for one.

If the page is your mailbox or your bank, that content goes too. Close the panel on pages you would rather not share. With a local model, nothing leaves your machine.

The panel says this before your first message, and you can read the notice again from Settings under **Review data notice**.

## What stays on your device

API keys, subscription tokens, saved mods, their stored values and your chat history are kept in extension local storage on your device. Keys and tokens are sent only to the endpoint they authenticate.

## Other network requests

usermods makes other requests only to list a provider's models, to fetch a script you chose to install (and its `@require` and `@resource` files), to check installed scripts for updates (at most once a day each, can be turned off), to sign in to a subscription, and on behalf of a script's `GM_xmlhttpRequest` to the hosts it declares. Sharing to a gist or Greasy Fork happens in your own tab when you press the site's button.

## What it does not do

No analytics, no crash reporting, no ads, no sale of data, no collection of browsing history, and no remotely loaded code in the extension.

The full policy is [PRIVACY.md](https://github.com/kballenegger/usermods/blob/main/PRIVACY.md), and the source for every claim is [on GitHub](https://github.com/kballenegger/usermods).
