# Using a ChatGPT or SuperGrok subscription

usermods can sign in with a ChatGPT subscription (Plus, Pro, Team) or a SuperGrok subscription (or X Premium+) from Settings, with no API key and no local proxy. Usage counts against your plan's limits.

## Sign in

1. Open the side panel and go to **Settings**.
2. Under **Add provider**, click **ChatGPT subscription** or **SuperGrok subscription**.
3. Follow the device-code sign-in: a page opens, you type a short code, and you are done.

Once signed in, the model picker lists the models your plan allows. If that listing fails, a short built-in list is offered instead, marked as such, and you can always type a model id.

## What to know

- Both sign-ins use the same backend the vendors' own coding agents use. Neither vendor publishes developer docs for it, and either can change or close it without notice. OpenAI and xAI have both said third-party tools may use these logins.
- Tokens are stored in extension local storage on your device and refreshed automatically.
- xAI has been seen to reject some standard-tier SuperGrok accounts with a 403 even when the subscription is active.
- There is no Claude subscription sign-in, because Anthropic does not allow its subscription to be used outside its own clients. Use an Anthropic API key, or point a Custom Anthropic provider at a local proxy you run.
- Any other subscription works the same way: run a local proxy that exposes it as an Anthropic- or OpenAI-compatible endpoint and add it as a Custom provider.

## Which version has it

Subscription sign-in is in the Chrome Web Store build from version 0.1.2. Version 0.1.1 left it out. The [GitHub build](https://github.com/kballenegger/usermods) has always had it.
