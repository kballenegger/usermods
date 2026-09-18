# Chrome Web Store listing copy

Everything that goes in the **Store listing** and **Privacy practices** tabs of the developer
dashboard. Companion files: [permissions.md](permissions.md) for the reviewer justifications,
[../../PRIVACY.md](../../PRIVACY.md) for the published policy.

---

## Title

```
usermods — userscripts by chat
```

(The store caps the item name at 30 characters; this is exactly 30. A plain `usermods` also works if
a shorter name is preferred.)

## Summary (132 characters max)

```
Customize any website by chatting with the AI of your choice: it reads the page, writes a userscript, runs it on every visit.
```

(125 characters.)

## Category

**Developer Tools.** Established userscript managers list there, and the audience that searches that
category is the audience for this extension. *Workflow & Planning* is the second-best fit if a
less technical placement is wanted.

## Language

English (United States).

---

## Detailed description

```
Every website has that one thing. The sidebar you never use, the banner that comes back every visit,
the layout that wastes half your screen, the button that should be three clicks closer.

usermods lets you fix it by asking.

Open the side panel on any page and describe the change you want. usermods reads the page, works out
which elements you mean, writes a userscript, tests it live in front of you, and hands it back with
Try and Save buttons. Save it, and it runs automatically every time you visit that site.

HOW IT WORKS

• Describe the change in plain language: "hide the sidebar", "make this full width", "stop the
  video autoplaying".
• The model inspects the real page — its structure, its elements, its computed styles — instead of
  guessing, and runs its draft once to check the result before showing it to you.
• You see the finished script, and nothing is saved until you click Save.
• Point at an element on the page and it drops a reference into your message, so you can say "this"
  and mean it.
• Need something once rather than forever? "Open every carousel and list the image URLs" just runs.

BRING YOUR OWN MODEL

usermods has no account and no server of its own. You choose where it sends your requests:

• Anthropic, OpenAI, xAI or OpenRouter with your own API key.
• A model running on your own machine through Ollama, LM Studio, vLLM or mlx_lm, so nothing leaves
  your computer.
• Anything else that speaks the Anthropic Messages or OpenAI chat-completions protocol.

A REAL USERSCRIPT MANAGER

Mods are plain userscripts with a standard ==UserScript== header — nothing proprietary, and yours to
keep.

• Install scripts from Greasy Fork, OpenUserJS or a file. Clicking a .user.js link shows a preview
  of what it matches, what it is granted and what it loads, before anything is saved.
• Works with scripts written for Tampermonkey: the GM_* and GM.* API, @require libraries, @resource
  files, @connect host restrictions, @run-at and page-world scripts.
• Moving over? A Tampermonkey backup file imports your whole library in one step, with each
  script's on/off state and its stored values.
• Export any mod back out as a .user.js file whenever you like.

PRIVACY

To change a page, the model has to see it. usermods explains exactly what that means before your
first message ever goes out, and sends it only to the endpoint you configured. Your messages, the
page's content and screenshots the model asks for go to your model provider; your API keys, tokens
and mods stay in local extension storage on your device. Nothing is sent to the author of usermods,
who runs no server. There is no telemetry and no analytics of any kind.

Open source and MIT licensed: https://github.com/kballenegger/usermods

NOTE

Chrome requires you to turn on "Allow User Scripts" for usermods in chrome://extensions → Details.
Every user script manager needs this toggle. usermods shows you where it is on first run.

usermods is an independent open-source project and is not affiliated with, endorsed by, or
sponsored by Google, Anthropic, OpenAI, xAI, or the authors of Tampermonkey, Violentmonkey or
Greasemonkey.
```

---

## Graphic assets checklist

All graphic assets are built and checked in. Regenerate them with `npm run store-assets`
(`scripts/store-assets.mjs`); the icon itself is `assets/icon.svg`, rasterized to `public/icon/*.png`
by `scripts/render-icons.mjs`.

The mark is the BBS Underground pixel **u** — a lime letterform with a cyan underside and an ink
shadow on an electric-blue tile — drawn on a 16×16 grid. `assets/icon-source.png` is the owner's
original artwork and the reference every rendering is checked against; see [branding](../branding.md).
Because it is pixel art it is only ever scaled by whole multiples of 16 with nearest-neighbour
sampling: `render-icons.mjs` fails the build if any output pixel is a colour that is not in the
source, which is what an interpolated (blurred) rescale would produce. The promo images wear the
same brand rather than the app's in-product charcoal, since they sit beside the banner in the
listing.

| Asset | Requirement | Status |
|---|---|---|
| Store icon | 128×128 PNG | **Done.** `public/icon/128.png`, rendered from `assets/icon.svg`. |
| Screenshots | 1280×800 **or** 640×400 PNG/JPEG, at least one, up to five | **Done.** Five at 1280×800 in `docs/store/assets/`: `01-chat.png`, `02-point.png`, `03-mods.png`, `04-install.png`, `05-migrate.png`. The panes are real extension output composited into a window frame, not mockups. |
| Small promo tile | 440×280 PNG/JPEG | **Done.** `docs/store/assets/promo-tile.png`. |
| Marquee promo tile | 1400×560 PNG/JPEG | **Done** (optional; only used if featured). `docs/store/assets/marquee.png`. |

Screenshot captions, as composited: (1) the chat proposing a mod on Wikipedia, (2) the element
picker dropping an @reference into the composer, (3) the Mods list split by what matches this site,
(4) the install page for a live Greasy Fork script, (5) Migrate from Tampermonkey, expanded.

---

# Privacy practices tab

## Privacy policy URL

```
https://github.com/kballenegger/usermods/blob/main/PRIVACY.md
```

The policy lives at `PRIVACY.md` in the repository root and is served by GitHub's own file view.
That rendered page is the URL to paste into the dashboard; a published policy is mandatory for any
item that handles user data. Keeping it in the repo rather than on a separate site means the policy
and the code it describes are versioned together, and a reviewer can diff them.

## Single purpose

Paste the single-purpose statement from [permissions.md](permissions.md#single-purpose).

## Permission justifications

Paste the corresponding paragraph from [permissions.md](permissions.md#permission-justifications)
into each permission's field. The dashboard lists one field per permission in the manifest
(`sidePanel`, `storage`, `scripting`, `tabs`, `userScripts`, `declarativeNetRequest`) plus one for
host permissions.

## Remote code

Select **No, I am not using remote code**, and paste the explanation from
[permissions.md](permissions.md#are-you-using-remote-code) into the field. It matters that a
reviewer reads the userscript explanation there, since a manager that runs user-supplied scripts
invites the question.

## Data usage — what this item collects

The dashboard asks you to check every category the item collects, where "collect" means transmit off
the user's device. Answer:

| Category | Check? | Why |
|---|---|---|
| **Personally identifiable information** (name, address, email address, age, identification number) | **No** | usermods asks for none of it. The store build has no sign-in of any kind and collects no identifier. |
| **Health information** | No | Not collected. |
| **Financial and payment information** | No | Not collected. |
| **Authentication information** (passwords, credentials, security questions, PINs) | **Yes** | The user's own API key is stored locally and transmitted to the model endpoint they configured, to authenticate their own requests. They are disclosed here because they are transmitted off the device, even though the destination is the user's own provider. |
| **Personal communications** (emails, texts, chat messages) | **Yes** | The user's chat messages to the model are transmitted to the endpoint they configured. If the user opens the panel on a page that itself contains messages, that page content is part of what is sent — disclosed here for that reason. |
| **Location** (region, IP address, GPS coordinates) | No | Never requested or derived. |
| **Web history** (the list of web pages a user has visited) | No | usermods keeps no history of visited pages, and transmits none. The address of the page a user is actively working on is sent as part of the conversation they started, which is covered by "Website content" below. |
| **User activity** (clicks, mouse position, scroll, keystroke logging) | No | No monitoring of user activity. The element picker acts on a single deliberate click and records only the element chosen. |
| **Website content** (text, images, sounds, videos, hyperlinks) | **Yes** | This is the core one. Pruned page HTML, element details and screenshots of the visible tab are sent to the model endpoint the user configured, so it can write a script for that page. |

## Data usage — certifications

Check all three. They are all true:

1. **I do not sell or transfer user data to third parties, outside of the approved use cases.**
   True. No data reaches the developer, and none is sold or transferred to anyone. Data goes only to
   the model endpoint the user chose, which is the approved use case of providing the item's single
   purpose.
2. **I do not use or transfer user data for purposes that are unrelated to my item's single
   purpose.** True. Page content and messages are used only to write and run the userscript the user
   asked for.
3. **I do not use or transfer user data to determine creditworthiness or for lending purposes.**
   True.

## Limited Use affirmation

Section 7 of [../../PRIVACY.md](../../PRIVACY.md) carries the required sentence:

> usermods' use of information received from Google APIs will adhere to the Chrome Web Store User
> Data Policy, including the Limited Use requirements.

---

## Notes for the submitter

- The listing description must prominently describe the page-reading feature, because the Limited
  Use policy permits handling web content only for a user-facing feature described prominently on
  the store page. The "How it works" and "Privacy" sections above do that; do not trim them.
- Expect the broad host permission and the `userScripts` API to draw a slower review. The
  justifications in [permissions.md](permissions.md) are written to be pasted verbatim.
- Before submitting, re-check that the permission list in the dashboard matches the built manifest
  (`.output/chrome-mv3/manifest.json`): `sidePanel`, `storage`, `scripting`, `tabs`, `userScripts`,
  `declarativeNetRequest`, plus `<all_urls>` host permissions.
