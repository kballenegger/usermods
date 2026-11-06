# App Review Board appeal: guideline 3.1.1, API keys

usermods iOS 0.1.1 (2), submission bd3c68a4-1bc9-442e-9ae4-b47ca4a03b42, was rejected on
2026-11-04 under guideline 3.1.1: "the app uses API keys to unlock or enable paid functionality, but
some of these API keys are not available for purchase via In-App Purchase". This file holds the
appeal to the App Review Board and a shorter reply for the Resolution Center thread.

**Where it goes:** the appeal form at
<https://developer.apple.com/contact/app-store/?topic=appeal>, signed in as the account holder of
team 2TK86C98Z5. App name *usermods*, Apple ID 6820909625, platform iOS. Paste the block under
[Appeal](#appeal). Nothing here has been sent.

The ChatGPT and SuperGrok in-app purchases were read from their App Store pages on 2026-11-06. The
list of other apps comes from the US App Store on the same day; recheck that they are still listed
before sending.

## Appeal

```
We are appealing the 3.1.1 rejection of usermods 0.1.1 (2), submission bd3c68a4-1bc9-442e-9ae4-b47ca4a03b42.

usermods is a Safari extension that writes userscripts with an AI model the user picks. It contains no In-App Purchase and sells nothing: no price, no upgrade, no subscription, no link to a purchase page. There is no usermods account and no usermods server. Nothing in the app is locked, and nothing is unlocked by a key.

1. The two subscription sign-ins are sold through In-App Purchase by their providers.
The app can use a ChatGPT or SuperGrok subscription that the user already has. Both are sold through In-App Purchase in the provider's own App Store app: ChatGPT Plus, Go and Pro in ChatGPT by OpenAI (id6448311069), and SuperGrok, SuperGrok Lite and SuperGrok Heavy in Grok by X Corp. (id6670324846). That is the case 3.1.1 allows: access purchasable via In-App Purchase in the associated app of the API provider.

2. A model endpoint and key are connection settings, not a purchase.
Connecting to an AI model through an endpoint URL and a key is how AI tools work. The OpenAI-compatible and Anthropic APIs are de facto standards, and many providers and open-source servers implement them. In usermods the endpoint can be:
- a model the user runs themselves, on their own computer or local network (Ollama, LM Studio, or any compatible server), with no key and no payment to anyone;
- any LLM provider that offers one of these standard APIs.
The key is the user's own credential for a service they chose, entered the way an email client takes a mail server and password or an SSH client takes a host and key. usermods takes no payment and receives no money from any provider. The same features work with a free local model and with a paid service.

3. This is common, accepted practice on the App Store.
Many AI clients on the App Store let the user enter their own API key for OpenAI, Anthropic, Google, xAI, OpenRouter or a compatible server, several of them updated in the last few weeks. For example:
- Pal Chat - AI Chat Client (id6447545085)
- Petey - AI Chat for Watch (id6446047813)
- Liquid Apollo by Liquid AI (id6448019325), OpenRouter API key
- Open Minis (id6759188481)
- Solair AI (id6758450823)
- BayesChat - AI chat BYOK MCP (id6777948055)
- Bring Your Own AI (id6784853025)
- RouterChat for OpenRouter (id6776368852)
- LLM Bridge - Multi LLM Client (id6738298481)
- OpenCat - AI Chat, Agent, MCP (id6445999201), on the Mac App Store
We ask that usermods be held to the same standard as these apps.

For testing, the App Review notes include an endpoint and key we provide at no cost.

Thank you for reconsidering.
```

## Resolution Center reply

A shorter version for the App Review thread, if Kenneth wants to reply there as well as appeal.

```
Thank you for the review. usermods has no In-App Purchase and sells nothing; no feature is locked or unlocked by a key. The ChatGPT and SuperGrok subscriptions it can use are sold through In-App Purchase in the providers' own apps (ChatGPT, id6448311069; Grok, id6670324846). Other connections are the user's own model endpoint, which can be a free model running on their own computer, entered the way a mail client takes a server and password. This is the same practice as many approved AI clients, such as Pal Chat (id6447545085), Petey (id6446047813) and Liquid Apollo (id6448019325). We have also filed an appeal with the App Review Board.
```
