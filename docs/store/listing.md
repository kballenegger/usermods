# Chrome Web Store listing copy

Everything that goes in the **Store listing** and **Privacy practices** tabs of the developer
dashboard. Companion files: [permissions.md](permissions.md) for the reviewer justifications,
[../../PRIVACY.md](../../PRIVACY.md) for the published policy.

---

## Title

```
usermods
```

The item name is **not a dashboard field**: the store takes it from the manifest's `name`, which
already ships as `usermods` in `wxt.config.ts`. There is nothing to paste and nothing to change.

This is the product's own name — the one on the icon, in the README, in the toolbar tooltip and
throughout the UI — so the listing agrees with the extension a user installs. The tagline lives in
the **summary** field directly beneath the title in the store, which is where the store expects a
descriptive phrase; putting one in the name as well would only duplicate it.

For reference, the manifest `name` limit is **75 characters**, universal across locales since
February 2024 (45 for English before that). An earlier draft of this file claimed a 30-character
cap, which was wrong. The limit is not a constraint here either way: the store also truncates long
names in listing tiles and search results well before 75 characters, so a short name is the right
call independently of the limit.

## Summary

```
Vibe-code userscripts in place. Customize any website by chatting with any LLM.
```

Like the title, the summary is **not a dashboard field**: the dashboard shows it read-only, taken
from the manifest's `description` (`lib/manifest.ts`). 79 characters, under the 132-character limit.
Changing it means changing the manifest and uploading a new package.

## Category

**Developer Tools.** Established userscript managers list there, and the audience that searches that
category is the audience for this extension. *Workflow & Planning* is the second-best fit if a
less technical placement is wanted.

## Language

English (United States).

---

## Detailed description

About 2,800 characters (`npm run listing-check` prints the exact count); the dashboard's limit is
16,000. Each paragraph and bullet is one line, so the
block pastes into the dashboard as it is.

**Rewritten on 2026-09-30 after the first submission was rejected for keyword spam** (violation
reference *Yellow Argon*, 2026-09-22). The reviewer quoted the two bullets that listed eight provider
and tool names in a row. Google's [spam FAQ](https://developer.chrome.com/docs/webstore/program-policies/spam-faq)
gives the rules this text is now held to, and they apply to every later edit:

- **No more than five brand or site names in the whole description.** This one has four: Chrome,
  Tampermonkey, GitHub and Greasy Fork. No provider is named at all; "presets for the common
  services" carries that, and the screenshots show them.
- **Fewer than five uses of any one keyword**, even the extension's main purpose. "userscript"
  appears twice, "usermods" twice (once in the link).
- **No non-affiliation paragraph.** The old one named seven companies and projects, which is a list
  of brands however it is worded.

`node scripts/listing-check.mjs` counts all three and fails if a later edit breaks one.

```
Every website has that one thing: the sidebar you never use, the banner that returns on every visit, the layout that wastes half your screen.

usermods lets you fix it by asking.

Open the side panel on any page and describe the change you want. Your AI model reads the page, works out which elements you mean, writes a small script, tests it in front of you, and hands it back to try or save. Once saved, it runs every time you visit that site.

HOW IT WORKS

• Describe the change in plain language: "hide the sidebar", "make this full width", "stop the video autoplaying".
• The model inspects the real structure and styles of what you are looking at instead of guessing, and normally tests its draft there before showing it to you.
• You see the finished code, and nothing is installed until you save it.
• Point at an element to drop a reference into your message, so you can say "this" and mean it.
• Not sure yet? Run a draft once on the page without saving it.

YOUR OWN AI

There is no account and no server behind this extension. Connect the AI service you already use with your own API key, or a model running on your own computer, in which case nothing leaves your machine. Presets for the common services are built in, and any endpoint that speaks a standard chat API works too.

A FULL USERSCRIPT MANAGER

What you save is a plain userscript with the standard header: nothing proprietary, and yours to keep.

• Install from a link or a file. A preview shows which sites it runs on, what it is allowed to do and what it loads, before anything is saved. On a page that offers one, a small bar offers to install it.
• Scripts written for other managers work too, including the GM API and @require libraries.
• Moving from Tampermonkey? Import its backup file and your whole library comes across, with each item's on/off state and stored values.
• Updates are offered, never automatic. At most once a day it checks the address each installed item names for a newer version, and you see what changed before you accept one.
• Export anything as a .user.js file, or share it as a GitHub gist or on Greasy Fork for others to install.

PRIVACY

To change a page, the AI has to see it. Before your first message goes out, a notice lists what is sent: your messages; the address, title and content of the tab you are on; what its test scripts return from that tab; images you attach; and screenshots it asks for. All of it goes only to the provider you chose for that chat. Your keys and saved mods stay in local extension storage on your device. Nothing is sent to the developer, who runs no server. No telemetry, no analytics.

Open source under the MIT license: https://github.com/kballenegger/usermods

SETUP NOTE

Chrome requires every extension of this kind to be allowed to run user scripts, a switch in chrome://extensions → Details. A banner shows you where it is on first run.
```

The text also stays inside what the single-purpose statement covers. An earlier draft advertised
one-off tasks ("open every carousel and list the image URLs"), which reads as scraping, a second
purpose; the listing now only says a draft can be run once without saving it. And the privacy
paragraph lists every kind of data the first-run notice does, because the User Data policy wants
the listing and the in-product notice to agree.

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
into each permission's field. The dashboard generates one field per permission declared in the
manifest — here `sidePanel`, `storage`, `scripting`, `userScripts`, `declarativeNetRequest` — plus
one for host permissions.

Host permissions get a field of their own, and every field is limited to 1,000 characters.

## Remote code

Select **Yes** and paste the justification from
[permissions.md](permissions.md#are-you-using-remote-code), which also gives the reasoning. A
userscript manager that runs model-written scripts invites the question, and answering it in the
field is better than having it asked in a rejection.

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
  (`.output/store-chrome-mv3/manifest.json`, from `npm run build:store` — the store build's own
  output folder): `sidePanel`, `storage`, `scripting`, `userScripts`, `declarativeNetRequest`, plus
  `<all_urls>` host permissions.
