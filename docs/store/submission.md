# Chrome Web Store submission checklist

Every field the developer dashboard asks for, in the order it asks, with the exact value to paste
or the file to upload. Written so the submission is a paste job with no decisions left in it.

Sources: [listing.md](listing.md) for the copy, [permissions.md](permissions.md) for the
justifications, [reviewer-notes.md](reviewer-notes.md) for the reviewer field,
[package-audit.md](package-audit.md) for what is in the zip, [../../PRIVACY.md](../../PRIVACY.md)
for the policy. Field names and limits checked against `developer.chrome.com` on 2026-09-19
(`cws-dashboard-listing`, `cws-dashboard-privacy`, `cws-dashboard-distribution`, `best-listing`).

---

## 0. Before you open the dashboard

| | |
|---|---|
| Developer account | Register at the [dashboard](https://chrome.google.com/webstore/devconsole) and pay the **one-time $5 USD** registration fee. Verify the account's email address, or publishing is blocked. |
| Model API key | Create a **scoped, spend-capped** key for the reviewer. It goes in the reviewer-notes field, not in the repo. Revoke it once the review clears. |
| The package | `npm run zip:store` → upload `.output/usermods-0.1.0-chrome.zip`. Current build: 375,104 bytes, sha256 `b7b304c1bfc2a2486e15ceaa19524a8f7a5ec0b1b543898c09ccac382f4b826b`. |

**Upload the zip first.** The dashboard derives the item name and the permission-justification
fields from the uploaded manifest, so the Privacy tab is incomplete until it has one.

---

## 1. Store listing tab

### Title

```
usermods
```

**Nothing to do.** This is not an editable dashboard field — the store reads it from the uploaded
manifest's `name`, which already ships as `usermods`. No change to `wxt.config.ts`, no rebuild.

It is the name on the icon, in the README, in the toolbar tooltip and throughout the UI, so the
listing matches the extension a user installs. The descriptive tagline goes in the **summary**
field below, not into the name. (The limit, for reference, is 75 characters.)

### Summary

**132 characters max.** This is 125 — verified by counting.

```
Customize any website by chatting with the AI of your choice: it reads the page, writes a userscript, runs it on every visit.
```

### Description

3,136 characters. No numeric limit is published for this field; this is far inside any plausible
one. Paste the fenced block under **Detailed description** in
[listing.md](listing.md#detailed-description) verbatim.

Do not trim the "How it works" or "Privacy" sections. The Limited Use policy permits handling web
page content only for a feature described *prominently* on the store page, and those two sections
are what does the describing.

### Category

```
Developer Tools
```

Labelled "primary category" in the docs. Second-best fit if a less technical placement is ever
wanted: *Workflow & Planning*.

### Language

```
English (United States)
```

### Store icon

| | |
|---|---|
| Requirement | 128×128 PNG |
| Upload | `public/icon/128.png` — verified 128×128 |

### Screenshots

At least one, up to five. **1280×800** (or 640×400). All five are 1280×800, verified.

| # | File | What it shows |
|---|---|---|
| 1 | `docs/store/assets/01-chat.png` | the chat proposing a mod on Wikipedia |
| 2 | `docs/store/assets/02-point.png` | the element picker dropping an `@reference` into the composer |
| 3 | `docs/store/assets/03-mods.png` | the Mods list split by what matches this site |
| 4 | `docs/store/assets/04-install.png` | the install page for a live Greasy Fork script |
| 5 | `docs/store/assets/05-migrate.png` | Migrate from Tampermonkey, expanded |

Upload in that order — the store shows them in the order given.

### YouTube video

Optional. **Leave blank.** There is no video.

### Small promo tile

| | |
|---|---|
| Requirement | 440×280 PNG or JPEG |
| Upload | `docs/store/assets/promo-tile.png` — verified 440×280 |

### Marquee promo tile

| | |
|---|---|
| Requirement | **1400×560** PNG or JPEG (not 1440×560), optional — used only if the item is featured |
| Upload | `docs/store/assets/marquee.png` — verified 1400×560 |

### Additional fields

| Field | Value |
|---|---|
| **Official URL** | **Leave blank.** This field is for verified publishers and requires domain ownership verification in Search Console. Not applicable. |
| **Homepage URL** | `https://github.com/kballenegger/usermods` |
| **Support URL** | `https://github.com/kballenegger/usermods/issues` |
| **Mature content** | **No** / unchecked. |

---

## 2. Privacy practices tab

### Single purpose

One field. Paste the block-quoted paragraph under **Single purpose** in
[permissions.md](permissions.md#single-purpose) — it starts "usermods is a userscript manager."
No character limit is published for this field.

### Permission justifications

One field per permission in the uploaded manifest, plus host permissions. Paste the matching
section of [permissions.md](permissions.md#permission-justifications) into each:

| Dashboard field | Paste from permissions.md |
|---|---|
| `sidePanel` | [§ sidePanel](permissions.md#sidepanel) |
| `storage` | [§ storage](permissions.md#storage) |
| `scripting` | [§ scripting](permissions.md#scripting) |
| `tabs` | [§ tabs](permissions.md#tabs) |
| `userScripts` | [§ userScripts](permissions.md#userscripts) |
| `declarativeNetRequest` | [§ declarativeNetRequest](permissions.md#declarativenetrequest) |
| Host permissions (`<all_urls>`) | [§ Host permissions](permissions.md#host-permissions-all_urls) |

Cross-check the generated field list against the built manifest before filling them in — if the
dashboard shows a permission this table does not, the manifest changed and `permissions.md` needs a
new paragraph. Per [package-audit.md](package-audit.md), the shipped manifest declares exactly
these six plus `<all_urls>`.

### Remote code

Select:

```
No, I am not using remote code
```

Paste the explanation from [permissions.md](permissions.md#are-you-using-remote-code). Do include
the userscript paragraphs — a manager that runs user-supplied scripts invites exactly this question,
and answering it before it is asked is faster than answering it in a rejection appeal.

### Data usage — what this item collects

Check these three, leave the rest unchecked:

| Category | Check |
|---|---|
| Personally identifiable information | ☐ No |
| Health information | ☐ No |
| Financial and payment information | ☐ No |
| **Authentication information** | ☑ **Yes** |
| **Personal communications** | ☑ **Yes** |
| Location | ☐ No |
| Web history | ☐ No |
| User activity | ☐ No |
| **Website content** | ☑ **Yes** |

The reasoning for each is in the table in [listing.md](listing.md#data-usage--what-this-item-collects).

> The exact category list and wording appear in the published docs only as a screenshot, never as
> text, so the labels above are reconstructed rather than quoted. If the live form words one of them
> differently, match it by meaning: the three that are true are *the user's own API key*, *the
> user's chat messages*, and *page content sent to the model*.

### Data usage — certifications

Check **all three**. All three are true; see
[listing.md](listing.md#data-usage--certifications) for why each one holds.

1. I do not sell or transfer user data to third parties, outside of the approved use cases.
2. I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
3. I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

```
https://github.com/kballenegger/usermods/blob/main/PRIVACY.md
```

Mandatory for any item that handles user data, which this one does. The URL must be publicly
reachable before submitting — **push the repo and confirm the link renders** first.

### Notes for reviewers

Paste the fenced **short version** from
[reviewer-notes.md](reviewer-notes.md#short-version--paste-this) — 2,174 characters.

**Replace `[reviewer key: PASTE HERE]` with the real scoped API key before submitting.** Without a
key the reviewer cannot exercise the chat at all, and the likeliest outcome is a rejection for a
feature that "does not work".

> Google documents neither this field nor its character limit anywhere on developer.chrome.com. It
> exists in the dashboard UI. If it rejects the text as too long, cut from the bottom up — the
> toggle steps and the key matter most.

---

## 3. Distribution tab

| Field | Value |
|---|---|
| **Contains in-app purchases** | ☐ Unchecked. Free, MIT, no purchases. |
| **Visibility** | **Public** — lists the item for all users. (*Unlisted* = installable only via direct URL; *Private* = named testers only. All three get the same review and the same policy requirements, so choosing Unlisted buys no leniency.) |
| **Geographic distribution** | **All regions.** |
| **Pricing** | Free. There is no pricing control for a free item; it follows from leaving in-app purchases unchecked. |

There is no "show in search results" toggle — that behaviour is what Public vs Unlisted decides.

---

## 4. Last checks before clicking Submit

- [ ] The uploaded zip is the **store** build (`npm run zip:store`), not `npm run zip`. The store
      build omits subscription sign-in; the plain build does not, and shipping it would put
      undocumented vendor endpoints in a listing that declares what it talks to.
- [ ] `manifest.version` is `0.1.0` and matches `package.json`.
- [ ] `manifest.name` is `usermods` — the store title, unchanged.
- [ ] The reviewer-notes field has a **real key** in place of the placeholder.
- [ ] `PRIVACY.md` is pushed and its GitHub URL renders.
- [ ] Permission fields in the dashboard match the built manifest exactly — no extra, none missing.
- [ ] [CHANGELOG.md](../../CHANGELOG.md) has the v0.1.0 entry.

### After submitting

Expect a **slower than average review**: `<all_urls>`, `userScripts` and a broad content script are
three of the things that route an item to manual review, and this item has all three. That is
normal and is what the justifications are written for. Do not resubmit while a review is pending.

Once it clears, tag the release (`v0.1.0`) so the published package and the source history line up.
