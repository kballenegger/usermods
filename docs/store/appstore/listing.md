# App Store listing copy: iPhone and iPad

Everything that goes in the **App Store** tab of App Store Connect for the iOS and iPadOS version of
record 6820909625. Companion files: [reviewer-notes.md](reviewer-notes.md) for the App Review
Information section, [../../../PRIVACY.md](../../../PRIVACY.md) for the published policy, and the
Chrome Web Store equivalent at [../listing.md](../listing.md), which this file is adapted from.

**This listing describes the full Safari build** (`npm run build:safari`, output
`.output/safari-mv3`), not `build:safari:store`. Kenneth decided on 2026-10-09 that the iPhone
submission ships with the ChatGPT and SuperGrok subscription sign-ins. The description therefore
mentions them, once, and the review notes explain them. If that decision is ever reversed, the
sentence about subscriptions in **YOUR OWN AI** has to come out, and the build has to be staged
with `scripts/safari-xcode.mjs stage --store`.

Every fenced block is the text to paste. Each one is a single field, one line per paragraph, and its
character count (counted with `node -e`, Unicode code points, the way App Store Connect counts) is
stated under it.

Already set on the record and not repeated here: SKU `usermods`, primary category **Developer
Tools**, secondary **Utilities**, age rating 4+, privacy label **Data Not Collected**, price free.

---

## Name

```
usermods
```

8 of 30 characters. Already on the record; nothing to change.

The product's own name, the one on the icon, in Safari's Extensions list and throughout the UI.
"usermods for Safari" or a name with a tagline in it was considered and rejected: the subtitle is
where Apple wants the descriptive phrase, and using an Apple trademark in an app name draws
scrutiny under Apple's trademark guidelines for no gain in search, since the subtitle and keywords
are indexed anyway.

## Subtitle

```
Vibe-code userscripts
```

21 of 30 characters. Already on the record; **keep it.**

Considered: `Customize any website with AI` (29) reads more plainly to someone who has never heard
the word userscript. It is not clearly better. The subtitle is indexed for search, and "vibe-code"
and "userscripts" are the two terms the product's audience actually types; "customize", "website"
and "AI" are cheaper to carry in the keyword field, which is where they are. It also matches the
manifest description and the Chrome listing, so the product says the same thing everywhere.

## Promotional text

```
Describe the change you want on any website. The AI model you choose reads the page, writes a userscript, tests it in front of you, and saves it. No account, no tracking.
```

170 of 170 characters. Promotional text can be changed at any time without a new review, so this
is the field to rewrite for a launch or a feature, rather than the description.

## Description

Adapted from the Chrome Web Store description and held to the same discipline, because Apple's
guideline 2.3.7 (no irrelevant brand names or keyword stuffing in metadata) asks for the same thing
Google's spam policy does:

- **No more than five brand or site names in the whole description.** This one has five: Safari,
  ChatGPT, SuperGrok, Tampermonkey and GitHub. Greasy Fork and every API-key provider are left out;
  "presets for the common services" carries those, and the screenshots show them. The two
  subscription names are there because the sign-in is a real, visible feature of this build and
  describing it without naming whose subscription it is would be evasive. No other app or
  competitor is named for comparison.
- **Fewer than five uses of any one keyword**, counted whole word with plurals the way
  `scripts/listing-check.mjs` counts the Chrome text: userscript 2, usermods 4 (one of them in the
  link), script 3, model 3, AI 3, extension 2, website 2, change 4. "mod" is not used at all; the
  description says "change" instead, which is also what a new user would call it.
- iPhone and iPad are named once each to say how the UI differs between them. They are Apple's
  platform names rather than third-party brands, and are not counted above.
- **No price, purchase or upgrade language.** The subscription sentence says the person already
  pays the provider, and the description says outright that nothing is sold in the app (guideline
  3.1.1, and see [reviewer-notes.md](reviewer-notes.md)).

Differences from the Chrome text, all because Safari on iOS is a different surface: usermods is
opened from the page menu in Safari's address bar rather than a side panel; the popup is the whole
UI and fills the screen on iPhone; "a model on your own computer" becomes "a model server on your
own network", because `localhost` on a phone is the phone; Greasy Fork sharing and the in-page
install bar are dropped from the bullets to keep the brand count; and setup names the iOS Settings
path instead of Chrome's toggle.

```
Every website has that one thing: the sidebar you never use, the banner that returns on every visit, the layout that wastes half your screen.

usermods lets you fix it by asking.

Open it from the page menu in Safari's address bar and describe the change you want. Your AI model reads the page, works out which elements you mean, writes a small script, tests it in front of you, and hands it back to try or save. Once saved, it applies every time you visit that site.

HOW IT WORKS

• Describe the change in plain language: "hide the sidebar", "make this full width", "stop the video autoplaying".
• The model inspects the real structure and styles of what you are looking at instead of guessing, and normally tests its draft there before showing it to you.
• You see the finished code, and nothing is installed until you save it.
• Tap an element to drop a reference into your message, so you can say "this" and mean it.
• Not sure yet? Run a draft once on the page without saving it.

MADE FOR A SMALL SCREEN

On iPhone everything lives in one sheet over the page: the chat, your saved changes and Settings, with the site you opened it from named at the top. The conversation gets the screen; everything else is one tap away. On iPad it opens as a popover beside the page.

YOUR OWN AI

There is no account and no server behind the app. Connect the service you already use with your own API key, or a model server on your own network. If you already have a ChatGPT or SuperGrok subscription, you can sign in with it instead of a key. Presets for the common services are built in, and any endpoint that speaks a standard chat API works too. Nothing is sold in the app.

A FULL USERSCRIPT MANAGER

What you save is a plain userscript with the standard header: nothing proprietary, and yours to keep.

• Install from a link or a file. A preview shows which sites it runs on, what it is allowed to do and what it loads, before anything is saved.
• Scripts written for other managers work too, including the GM API and @require libraries.
• Moving from Tampermonkey? Import its backup file and your library comes across, with each item's on/off state and stored values.
• Updates are offered, never automatic. At most once a day it checks the address each installed item names for a newer version, and you see what changed before you accept one.
• Export anything as a .user.js file, or share it as a GitHub gist.

PRIVACY

To change a page, the AI has to see it. Before your first message goes out, a notice lists what is sent: your messages; the address, title and content of the page you are on; what test scripts return from it; images you attach; and screenshots it asks for. All of it goes only to the provider you chose for that chat. Your keys and everything you save stay on your device. Nothing is sent to the developer, who runs no server. No tracking, no analytics, no ads.

Open source under the MIT license: https://github.com/kballenegger/usermods

SETUP

After installing, open the app once: it shows where the switch is. Turn the extension on in Settings > Apps > Safari > Extensions > usermods, and allow it on all websites, since you may want to fix any site. Then open any page, tap the page menu in the address bar, and choose usermods.
```

3,254 of 4,000 characters (re-count after any edit; the field refuses a longer paste). The
description cannot be changed without submitting a new version, unlike promotional text.

## Keywords

```
safari,extension,customize,website,ai,llm,agent,chatbot,javascript,css,tweak,web,dark mode,hide,mod
```

99 of 100 characters, 15 terms, no spaces after commas, no term repeated.

What is deliberately **not** here, and why:

- **The name and subtitle words** (`usermods`, `vibe`, `code`, `userscript`). App Store search
  already indexes the name and subtitle, and repeating their words here spends characters for
  nothing.
- **The category names** (`developer`, `tools`, `utilities`). Indexed from the category already.
- **Other apps' and companies' names**, including the userscript managers usermods imports from and
  the providers it connects to. Guideline 2.3.7 forbids trademarked terms and competitor names in
  keywords, and the reviewer rejects for it.
- **Plurals.** App Store search matches singular and plural forms, so `website` covers `websites`.

`dark mode` and `hide` are there because they are the two most common things people ask a page to
do; both are honest, since either is one sentence to the model. `safari` is Apple's own product name
and describes the platform, the way every Safari extension on the store uses it.

## What's New in This Version

```
First release on iPhone and iPad.
```

33 characters (limit 4,000). App Store Connect does not show this field on an app's first version,
so there may be nothing to paste. It is here for when it appears.

**Version number check before upload.** The record was created as version **1.0**, but the build
carries `MARKETING_VERSION = 0.1.1` (`safari/Config/Shared.xcconfig`). App Store Connect matches the
version on the record to the build's `CFBundleShortVersionString`, so one of the two has to change
before the build can be attached: either rename the App Store version to 0.1.1 (matching the Chrome
release and the repo) or bump the xcconfig. Renaming the record is the smaller change.

## URLs

| Field | Value |
|---|---|
| Support URL | `https://github.com/kballenegger/usermods/issues` |
| Marketing URL | `https://github.com/kballenegger/usermods` |
| Privacy Policy URL | `https://github.com/kballenegger/usermods/blob/main/PRIVACY.md` |

All three are already on the record. The privacy policy covers this build: its *(GitHub build only)*
sections describe the subscription sign-in, which the full Safari build also has. PRIVACY.md's
"Two builds" paragraph names only the Chrome Web Store build as the one without sign-in; before
submitting, add a sentence there saying that the App Store build keeps the sign-in, so a reviewer
reading the policy against the app finds them in agreement.

## Copyright

```
2026 Kenneth Ballenegger
```

24 characters. App Store Connect adds the © itself.

---

## Screenshots: caption plan

For a separate agent to shoot. Apple requires a set for the largest iPhone and the largest iPad
the app supports, and scales those down for smaller devices.

| Set | Size, portrait | Device to shoot on |
|---|---|---|
| iPhone 6.9" | 1320 × 2868 (1290 × 2796 also accepted) | iPhone 17 Pro Max simulator, or the newest Pro Max installed |
| iPad 13" | 2064 × 2752 (2048 × 2732 also accepted) | iPad Pro 13-inch (M5) simulator, or the newest 13-inch installed |

Rules for every shot:

- **Real output, not mockups**, as with the Chrome set: the full Safari build running in Mobile
  Safari, captured with `xcrun simctl io booted screenshot`, with a real model answering. Use the
  reviewer endpoint or Kenneth's own provider, never a local model on this Mac.
- **Light theme**, status bar cleaned (`xcrun simctl status_bar booted override --time 9:41
  --batteryState charged --batteryLevel 100 --cellularBars 4`).
- **One caption per shot**, above the device frame, in the BBS Underground style
  ([../../branding.md](../../branding.md)): pixel display face for the caption, the brand's
  electric-blue ground. The captions below are the text; under 40 characters each so they set at a
  readable size on a phone.
- **No other company's logo as the subject.** Wikipedia's page is the demo page because it is
  neutral and stable. Do not show a provider's logo or the subscription sign-in in the screenshots:
  Settings shows the presets, and that is enough. Do not show prices anywhere.
- No real personal data: no signed-in account label, no real API key (Settings masks it, but check).

### iPhone 6.9" (five)

| # | Caption | What the frame shows |
|---|---|---|
| 1 | **Fix any website by asking** | The compact popup over `en.wikipedia.org/wiki/Common_kingfisher`, the chat with "hide the table of contents" sent, a few folded tool steps, and the **proposed mod** card with **Save & enable**. The top bar shows the site chip and the model chip. This is the hero shot. |
| 2 | **Tap the thing you mean** | The element picker active on the page (popup dismissed), one element highlighted, then (or as an inset) the composer with the `@` reference chip dropped in. If one frame cannot show both, show the composer with the chip and the message "make this wider" typed. |
| 3 | **Your scripts, every visit** | The **Mods** view, three or four saved mods with their switches, split by what matches this site; at least one off. Use plain names such as "Hide table of contents", "Wider article", "No autoplay". |
| 4 | **Bring your own AI** | Settings, Providers: one connected provider card (custom OpenAI-compatible, key masked) and the **Add provider** row of presets beneath it. Crop or scroll so the subscription presets are not the focus. |
| 5 | **Install any userscript, safely** | The install preview for a real script from a link (the Greasy Fork script named in [reviewer-notes.md](reviewer-notes.md)), showing its matches, grants and `@require` list before **Install**. |

### iPad 13" (four)

| # | Caption | What the frame shows |
|---|---|---|
| 1 | **Fix any website by asking** | Safari in landscape or portrait with the 440 × 660 popover open beside the Wikipedia page, the same chat and proposed mod card as iPhone 1, the page visible behind with the table of contents already gone. The point of the iPad shot is that the page and the chat are both on screen. |
| 2 | **See the change before you keep it** | The draft sheet or proposed mod card with the code expanded, page behind it showing the result of **Run once**. |
| 3 | **Your scripts, every visit** | The Mods view in the popover, as iPhone 3. |
| 4 | **Bring your own AI** | Settings in the popover, as iPhone 4. |

A fifth iPad shot (the install preview, as iPhone 5) is optional.

Existing captures in `docs/screenshots/ios-ui/` are layout-harness renders at 390 × 844 and
440 × 660, useful as a reference for what each view looks like, but they are not at Apple's sizes
and are not from a running Safari, so none of them can be uploaded as they are.
