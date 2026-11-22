# Providers and API keys

usermods works with Anthropic's API, OpenAI, xAI, OpenRouter and any endpoint that speaks the Anthropic Messages or OpenAI chat completions protocol, including local servers like Ollama, LM Studio, vLLM and mlx_lm. You add one or more providers in Settings and pick the model per chat.

## Presets

| Preset | Protocol | Base URL |
|---|---|---|
| Anthropic | Anthropic Messages | `https://api.anthropic.com` |
| OpenAI | OpenAI chat completions | `https://api.openai.com/v1` |
| xAI Grok | OpenAI chat completions | `https://api.x.ai/v1` |
| OpenRouter | OpenAI chat completions | `https://openrouter.ai/api/v1` |
| Ollama, LM Studio, vLLM, mlx_lm | OpenAI chat completions | your local server |
| Custom | either | anything you type |

The base URL is always editable, so a self-hosted gateway, a corporate proxy or a model router works too.

**Add provider** adds to a list. You can have Anthropic, OpenRouter and two local servers connected at once, each with its own name, key and model list. A provider counts as connected once it has a key, a sign-in, or a base URL that needs neither. Removing a provider deletes its key from the device.

## Choosing the model in the chat

The chip under the message box shows the model the chat is using. Open it to see every model from every connected provider, grouped by provider, with a filter. **Refresh models** asks the providers again, and **Manage providers** goes to Settings.

![The model dropdown with two providers' models and a Thinking row](/assets/guide/12-model-picker.png)

- Each chat remembers its model. A new chat starts on the last model you picked.
- You can switch mid-conversation. The next turn goes to the new model with the full conversation.
- An endpoint that cannot list its models still works: type the model id in the picker's field.
- If a chat's provider is removed or signed out, the chat says so and waits for you to pick another model. It never sends your page to a different provider without asking.

## Thinking level

Under the models is **Thinking**: how hard the chat asks the model to reason. usermods maps it onto that provider's own setting and only shows the levels the model accepts. **Default** sends nothing extra. Like the model, it is remembered per chat.

## Where your key goes

Keys are stored in extension local storage on your device and sent only to the endpoint they authenticate. Point usermods at a local model and nothing leaves your machine.
