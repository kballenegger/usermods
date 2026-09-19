# usermods Privacy Policy

**Last updated: 18 September 2026**

usermods is an open-source browser extension that lets you customize websites by chatting with a
large language model of your choosing. It is published by Kenneth Ballenegger as a personal,
non-commercial project under the MIT license.

**usermods has no servers.** There is no usermods account, no usermods backend, no analytics and no
telemetry. The author of usermods receives no data from the extension — none, ever. Everything below
describes data that either stays on your own computer or travels directly from your browser to a
service that *you* chose and configured.

The canonical address of this policy — the one given to the Chrome Web Store — is
<https://github.com/kballenegger/usermods/blob/main/PRIVACY.md>. The source code for every claim on
this page is public at <https://github.com/kballenegger/usermods>.

**Two builds.** The build published on the Chrome Web Store omits ChatGPT and SuperGrok subscription
sign-in; it contacts no vendor authentication endpoint at all. The sections below marked
*(GitHub build only)* therefore do not apply to the Web Store version — in that build no
subscription token is ever created, stored or sent. They are documented here because the same
policy covers the GitHub build, which keeps the feature.

---

## 1. Data stored on your device

usermods stores the following in your browser's extension storage (`chrome.storage.local` and
`chrome.storage.session`). This storage is local to your computer and to this extension. usermods
never uploads it anywhere.

| What | Where | Why |
|---|---|---|
| **Provider settings** — each provider you connected: its name, base URL, the list of model names it offered, and which model each chat uses | `chrome.storage.local` | So usermods knows which endpoints exist and which one a chat talks to. |
| **Your API keys**, if you use any | `chrome.storage.local` | Each is sent only to the provider it belongs to, as the authentication header for your own requests. Removing a provider deletes its key. |
| **Subscription tokens** *(GitHub build only)* — OAuth access and refresh tokens for ChatGPT or xAI sign-in, and the account identifier and label (typically your email address and plan name) read out of those tokens | `chrome.storage.local` | Sent only to that vendor, to authenticate your own requests, and refreshed automatically. Removed when you sign out. |
| **Saved mods** — the full userscript text, its header metadata, its enabled state, and any `@require` libraries and `@resource` files downloaded at install time | `chrome.storage.local` | So your mods can run on matching pages. |
| **Mod values** — data your scripts save with `GM_setValue`, including values imported from a Tampermonkey backup | `chrome.storage.local` | The storage that userscripts expect. It belongs to the script, not to usermods. |
| **Chat history** — your messages, the model's replies, the tool calls made and their results, and the page address and title of the tab a chat belongs to | `chrome.storage.local` | So a conversation survives closing the panel. Capped at 200 chats, oldest dropped. Screenshots are stripped from stored history. |
| **Images you attach** — the pictures you paste, drop or pick in the composer, stored as a small thumbnail in the transcript and one full-size copy per chat | `chrome.storage.local` | So a reopened panel still shows what you sent. Deleted with the chat they belong to. |
| **The first-run data notice acknowledgement** | `chrome.storage.local` | So you are asked once rather than every time. |

You can delete any of it: remove a chat or a mod from the panel, sign out to erase subscription
tokens, clear the API key field, or uninstall the extension, which deletes the extension's storage
entirely.

## 2. Data sent to the model provider you pick

usermods is useless unless the model can see the page you want changed. When you send a message, the
extension sends the following **directly from your browser to the one provider that chat is using**
— the model named under the message box, on a provider you connected in Settings. If you have
connected several, the others receive nothing from that message. If you change the model in the
middle of a conversation, the conversation so far is sent to the newly picked provider with your
next message, because a model cannot continue a conversation it has not been shown:

- **Your messages**, and the conversation so far.
- **The address (URL) and title of the page** in the active tab.
- **A pruned copy of the page's HTML** when the model calls the `get_page` tool: visible text,
  element structure and a limited set of attributes. Scripts, stylesheets and hidden elements are
  removed and long text is truncated.
- **Element details** when the model calls `find_elements` or `get_styles`, or when you point at an
  element with the picker: its selector, its position and size, a preview of its text, and its
  computed CSS.
- **A screenshot of the visible area of the tab**, but only when the model calls the `screenshot`
  tool.
- **The output of scripts the model runs** with `run_script` on the page, including anything they
  log to the console.
- **Any images you attach** to a message, downscaled and re-encoded in the panel first — which also
  strips their EXIF metadata, so location and device information in a phone screenshot is not sent.

Three consequences are worth stating plainly:

1. **Page content includes whatever is on the page.** If you open the panel on your webmail, your
   bank, a medical portal or a private document, the content of that page — which may include
   personal information, message text or form values that are present in the DOM — is part of what
   is sent to the model. Close the panel on pages you do not want to share. usermods shows this
   notice before your first message for exactly this reason.
2. **Your API key or subscription token is sent to that endpoint**, as the authentication header of
   your own request. It is not sent anywhere else.
3. **The provider's own policies apply to that data once it arrives.** usermods is not a party to
   that relationship. Read the privacy policy and data-retention terms of whichever provider you
   configure — Anthropic, OpenAI, xAI, OpenRouter, or your own server. If you point usermods at a
   model running on your own machine (Ollama, LM Studio, vLLM, mlx_lm), nothing leaves your computer
   at all.

**Consent.** Before the first message is ever sent, usermods shows a notice describing the above and
requires you to acknowledge it. You can re-read it at any time from Settings → *Review data notice*.

## 3. Other network requests

Besides the model endpoint, usermods makes network requests only in these cases, all of them started
by an explicit action of yours:

- **Installing an outside userscript.** When you install from a URL, click a `.user.js` link or use
  *Fetch models*, usermods requests that URL. `@require` libraries and `@resource` files named in a
  script's header are downloaded at install time from the addresses the script names, and stored
  with the mod.
- **Signing in to a subscription** *(GitHub build only)*. The ChatGPT and xAI device-code sign-in flows contact those
  vendors' own authentication servers.
- **`GM_xmlhttpRequest` from a userscript.** Scripts you installed can make cross-origin requests,
  restricted to the hosts their `@connect` header declares. These are requests made by *that script*
  to hosts *it* names, shown to you in the install preview before you save it. usermods neither
  inspects nor records their contents.

No request is ever made to a server operated by the author of usermods, because there is none.

## 4. What usermods does not do

- No analytics, no telemetry, no crash reporting, no usage statistics.
- No advertising, no advertising identifiers, no retargeting.
- No sale or transfer of user data to anyone. There is no recipient to transfer it to.
- No collection of browsing history. usermods does not log, aggregate or transmit the sites you
  visit. A page's address is sent to your chosen model only as part of a conversation you started,
  and is stored locally with that conversation.
- No remote configuration and no remotely hosted code in the extension itself. The extension ships
  with all of its own code, as Manifest V3 requires.

## 5. Permissions

Each permission usermods requests exists for a feature described on its store listing. A detailed,
per-permission justification is published alongside this policy at
[docs/store/permissions.md](docs/store/permissions.md).

In short: broad host access (`<all_urls>`) exists because usermods works on whatever site you are
looking at, and cannot know in advance which sites those are — the same access a userscript manager
has always needed. It is used to read the page you are on while the panel is open, to run the mods
you saved on the sites their headers match, and to reach the model endpoints you connected.

## 6. Children

usermods is not directed at children and does not knowingly collect any data from anyone, of any
age.

## 7. Chrome Web Store Limited Use affirmation

usermods' use of information received from Google APIs will adhere to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
requirements.

Specifically, and as described above: usermods handles user data only as necessary for its single
purpose of building and running userscripts at your direction; it transmits data only to the model
endpoints you connect and to hosts you explicitly ask it to contact; it transfers data to no third
party, sells no data, uses no data for advertising or creditworthiness purposes, and permits no
human access to user data, because no data ever reaches the developer.

## 8. Changes to this policy

Material changes will be published in this file, and the version history is public in the git
repository. If what usermods sends, or where it sends it, changes materially, the first-run notice
will be shown again.

## 9. Contact

Kenneth Ballenegger — <https://github.com/kballenegger/usermods/issues>
