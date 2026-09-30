# Chrome Web Store submission checklist

## Status

- Publisher: `kenneth@ballenegger.com` (publisher id kept out of the repo).
- Item: `dhmdjekbeinhhnfhcgnkgdpgdafpboic`.
  [Developer dashboard](https://chrome.google.com/webstore/devconsole).
- **2026-09-22: 0.1.0 submitted, and rejected the same day.** Violation *Yellow Argon*, keyword
  spam: "excessive and / or irrelevant keywords in the item's description". The text the reviewer
  quoted was the two bullets that listed eight provider and tool names (Anthropic, OpenAI, xAI,
  OpenRouter, Ollama, LM Studio, vLLM, mlx_lm). Nothing else was cited. The notice went to the
  publisher's mailbox and was not seen for a week, so until 2026-09-30 this file said "pending
  review".
- **2026-09-30: 0.1.1 prepared for resubmission. Not yet uploaded or submitted.** What changed is
  under [What the resubmission changes](#what-the-resubmission-changes); what to do in the dashboard
  is under [Resubmitting](#resubmitting).
- Automatic publication is **off**: an approved item waits for Publish to be pressed.

Things the dashboard turned out to do differently from Google's docs, learned on the first
submission:

- Title and summary are read-only and come from the manifest (`name`, `description`).
- Description limit is 16,000 characters. Single purpose and each permission justification are
  limited to 1,000 characters.
- Choosing "No" for remote code disables its justification field.
- Reviewer access is a **Test instructions** form: Username and Password at 100 characters each and
  Additional instructions at 500. See [reviewer-notes.md](reviewer-notes.md).

---

## What the resubmission changes

**The description, which is what was rejected.** Rewritten in [listing.md](listing.md#detailed-description)
to the rules in Google's [spam FAQ](https://developer.chrome.com/docs/webstore/program-policies/spam-faq):
no more than five brand or site names in the whole text (it has three, and names no model provider
at all), fewer than five uses of any one keyword, and no non-affiliation paragraph listing other
companies. `npm run listing-check` enforces all of it.

**The package, because 0.1.0 would have failed the next stage of review.** Checking the reviewer's
own steps against the store build found that a fresh install did not work:

- With "Allow User Scripts" off, which is how every install starts, Chrome leaves `chrome.userScripts`
  undefined. The extension read that as "this is Safari", picked the Safari engine, reported itself
  ready and showed **no setup banner**.
- After the toggle was turned on, nothing worked until the browser was restarted: every script run
  ended in "No result after 20s" and saved mods did not run.

A reviewer following the test instructions would have hit the second one on step 5. Both are fixed
in 0.1.1 (`lib/exec/engine.ts`, `entrypoints/background.ts`), and `npm run reviewer-walkthrough` now
runs the reviewer's test end to end against the store build, toggle included. It had gone unnoticed
because every earlier test of the real thing was on a profile where the toggle had been on for
days, and the automated flows believed the toggle could not be turned on in automation. It can.

**Other things a reviewer could have held against it**, found by reading the package and the
listing against Google's policies the way a reviewer would:

- **The `tabs` permission was unnecessary** (violation *Purple Potassium*, excessive permissions).
  It adds nothing over `<all_urls>` for what usermods does, and its justification listed API calls
  that do not need it. 0.1.1 does not ask for it. See [permissions.md](permissions.md#tabs-no-longer-requested).
- **"Are you using remote code?" was answered No.** The model's draft is run on the page during the
  chat, and a userscript is by the dashboard's own definition code that is not in the package. The
  answer is now **Yes**, with a justification citing the User Scripts API, which the Manifest V3
  policy names as the permitted way. See [permissions.md](permissions.md#are-you-using-remote-code).
  It is the accurate answer and the defensible one, and it costs a slower review.
- **The first-run data notice left out two things that are sent**: what a script returns when the
  model runs one on the page, and images the user attaches. The listing's privacy paragraph said the
  notice "explains exactly what is sent" over a shorter list still. Both now name everything the
  privacy policy does.
- **The description advertised one-off tasks** ("open every carousel and list the image URLs"),
  which reads as scraping: a second purpose next to a single-purpose statement about userscripts.
- **Three places in the store build mentioned a subscription sign-in** that build does not have: the
  line by the message box, the empty model picker, and the hint under Base URL on the card the
  reviewer fills in.
- **The first store screenshot showed test content.** The scripted model's reply ends in three lines
  that exist to exercise the markdown sanitiser, one reading "do not click me", and that was the
  part of the transcript in the picture.
- The `declarativeNetRequest` justification said "exactly one static rule"; 0.1.1 registers two
  dynamic rules. The host-permission justification was over the 1,000-character limit and had been
  cut by hand.
- The privacy policy said every network request follows "an explicit action of yours", two lines
  above the automatic daily update check; said it transfers data to no third party, which the model
  provider is; and filed *Fetch models* under installing a script.
- The test instructions did not say that the Base URL field comes pre-filled and has to be replaced,
  or that a new extension's icon is inside the puzzle-piece menu.
- The README said the listing was pending review.

0.1.1 also carries everything merged since 0.1.0 (see [CHANGELOG.md](../../CHANGELOG.md)): markdown
replies, the one-row composer, per-chat thinking levels, reviewed updates, sharing, the install
banner, and the fixes from the first user report.

---

## Resubmitting

In the dashboard, on the item above. Nothing here needs a decision; it is upload and paste.

1. **Package** → upload `.output/usermods-0.1.1-chrome.zip` (from `npm run zip:store`; checksum in
   [package-audit.md](package-audit.md)). The permission list is one shorter (`tabs` is gone), so the
   dashboard should show five permission fields plus host permissions, and no new permission
   warning.
2. **Store listing → Description** → replace with the block in
   [listing.md](listing.md#detailed-description).
3. **Store listing → Screenshots** → replace all five with the files in `docs/store/assets/`, in
   order `01` to `05`. They show the 0.1.1 panel.
4. **Privacy practices → justifications** → replace each of the seven texts (single purpose, five
   permissions, host permissions) with its block in [permissions.md](permissions.md).
5. **Privacy practices → remote code** → change the answer to **Yes** and paste the block under
   [Are you using remote code?](permissions.md#are-you-using-remote-code).
6. **Test instructions** → leave Username and Password as they are (the reviewer key was extended
   to 2026-10-17, same key and endpoint) and replace Additional instructions with the block in
   [reviewer-notes.md](reviewer-notes.md#test-instructions).
7. Leave everything else as it is: category, language, icon, promo tiles, URLs, data-usage
   checkboxes, the three certifications, the privacy policy URL, distribution.
8. **Submit for review.** Do not tick automatic publication.

Before pressing Submit:

- [ ] `npm run listing-check` prints `ok`.
- [ ] `npm run reviewer-walkthrough` ends with `ok`.
- [ ] The uploaded zip's SHA-256 matches [package-audit.md](package-audit.md).
- [ ] The reviewer key still works: `curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/models"`
      lists the model that step 4 of the test instructions names.
- [ ] `PRIVACY.md` on `main` is the updated one (its date reads 30 September 2026), since the
      dashboard links to it there.

After submitting, watch the publisher mailbox: the rejection arrived there within a day and sat
unread. When the item is approved and published, tag the release (`v0.1.1`).

---

## Field reference

Every field the dashboard asks for, in the order it asks, for a submission from scratch.

Sources: [listing.md](listing.md) for the copy, [permissions.md](permissions.md) for the
justifications, [reviewer-notes.md](reviewer-notes.md) for the test instructions,
[package-audit.md](package-audit.md) for what is in the zip, [../../PRIVACY.md](../../PRIVACY.md)
for the policy.

### 0. Before you open the dashboard

| | |
|---|---|
| Developer account | Registered, fee paid, contact email verified (2026-09-22). |
| Reviewer key | An OpenAI-compatible endpoint and a time-limited key for it, kept in 1Password (project vault, item "Ornith API - chrome-app-review - 14 days"), model `ornith`. Never in the repo. Revoke it once the review clears. |
| The package | `npm run zip:store` → `.output/usermods-0.1.1-chrome.zip`. |

**Upload the zip first.** The dashboard derives the item name, the summary and the
permission-justification fields from the uploaded manifest.

### 1. Store listing tab

| Field | Value |
|---|---|
| Title | `usermods`. Read-only, from the manifest. |
| Summary | `Vibe-code userscripts in place. Customize any website by chatting with any LLM.` Read-only, from the manifest. |
| Description | The block in [listing.md](listing.md#detailed-description). Do not add provider names, a list of supported sites, or a non-affiliation paragraph: that is what was rejected. Do not trim the "How it works" or "Privacy" sections either; the Limited Use policy permits handling page content only for a feature described prominently on the store page. |
| Category | Developer Tools |
| Language | English (United States) |
| Store icon | `public/icon/128.png` (128×128) |
| Screenshots | `docs/store/assets/01-chat.png` to `05-migrate.png`, 1280×800, in that order |
| YouTube video | Blank |
| Small promo tile | `docs/store/assets/promo-tile.png` (440×280) |
| Marquee promo tile | `docs/store/assets/marquee.png` (1400×560) |
| Official URL | Blank (needs a verified domain) |
| Homepage URL | `https://github.com/kballenegger/usermods` |
| Support URL | `https://github.com/kballenegger/usermods/issues` |
| Mature content | No |

### 2. Privacy practices tab

**Single purpose** and **permission justifications**: one field each, pasted from the matching
block in [permissions.md](permissions.md).

| Dashboard field | Block in permissions.md |
|---|---|
| Single purpose | [Single purpose](permissions.md#single-purpose) |
| `sidePanel` | [sidePanel](permissions.md#sidepanel) |
| `storage` | [storage](permissions.md#storage) |
| `scripting` | [scripting](permissions.md#scripting) |
| `userScripts` | [userScripts](permissions.md#userscripts) |
| `declarativeNetRequest` | [declarativeNetRequest](permissions.md#declarativenetrequest) |
| Host permissions | [Host permissions](permissions.md#host-permissions-all_urls) |

If the dashboard shows a permission this table does not, the manifest changed and `permissions.md`
needs a new block.

**Remote code**: select *Yes* and paste the block under
[Are you using remote code?](permissions.md#are-you-using-remote-code). (Selecting No disables the
field, so the explanation is never read.)

**Data usage**: check these three and leave the rest unchecked. The reasoning for each is in
[listing.md](listing.md#data-usage--what-this-item-collects).

| Category | Check |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| **Authentication information** | **Yes** |
| **Personal communications** | **Yes** |
| Location | No |
| Web history | No |
| User activity | No |
| **Website content** | **Yes** |

**Certifications**: check all three.

**Privacy policy URL**: `https://github.com/kballenegger/usermods/blob/main/PRIVACY.md`

**Test instructions**: see [reviewer-notes.md](reviewer-notes.md).

### 3. Distribution tab

| Field | Value |
|---|---|
| In-app purchases | Unchecked |
| Visibility | Public |
| Geographic distribution | All regions |

### After it clears

Expect a slower than average review: `<all_urls>`, `userScripts` and a broad content script are
three of the things that route an item to manual review. Do not upload anything while a review is
pending, because that restarts it. Once it is approved and published, tag the release and revoke
the reviewer key.
