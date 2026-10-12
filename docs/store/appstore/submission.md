# App Store submission: iPhone and iPad

The runbook for the Safari build's first App Store submission, 0.1.1 (1), and the state of each step.
Companion files in this folder: [listing.md](listing.md) for every text field,
[reviewer-notes.md](reviewer-notes.md) for the App Review notes, `screenshots/` for the images and
how they were made. How the build itself is produced and checked is in
[docs/safari.md](../../safari.md#distribution).

## The record

| | |
|---|---|
| App Store Connect | [usermods, Apple ID 6820909625](https://appstoreconnect.apple.com/apps/6820909625/distribution/info) |
| Team | 2TK86C98Z5 (Apple Developer Program, renews 2027-07-15) |
| Bundle IDs | `com.kballenegger.usermods`, `com.kballenegger.usermods.extension`, both registered as explicit App IDs |
| Platforms on the record | iOS (iPhone and iPad) and macOS, one record. **Only iOS is being submitted.** The macOS version stays in *Prepare for Submission*. |
| SKU, language | `usermods`, English (U.S.) |
| Price, availability | Free, all 175 territories |
| Categories | Developer Tools, then Utilities |
| Subtitle | `Vibe-code userscripts` (Apple's limit is 30 characters) |
| Age rating | 4+ |
| App privacy | Published: Data Not Collected (matches [PRIVACY.md](../../../PRIVACY.md); the developer runs no server) |
| URLs | privacy policy, support and marketing already set, see [listing.md](listing.md) |
| Export compliance | answered by `ITSAppUsesNonExemptEncryption = false` in the app's Info.plist, so the build is not held |

The record was created on 2026-10-09 with everything above already filled in. What is left is the
build, the images, the text, and the Submit button.

## Which build

The one **with** the ChatGPT and SuperGrok subscription sign-ins: `npm run build:safari`, staged
without `--store`. Decided 2026-10-09. This is the opposite of the Chrome Web Store package, so the
review notes explain the sign-ins rather than saying they are absent, and the screenshots may show
them.

```
node scripts/safari-xcode.mjs archive --team 2TK86C98Z5
```

builds, archives, exports `.output/safari-archive/export/usermods.ipa` and checks it, without
uploading. Done on 2026-10-11 for 0.1.1 (1): the archive log confirmed 39 staged files in the
`.appex`, versions 0.1.1 across app, extension and manifest, and an export signed *Apple
Distribution* with App Store profiles for both bundles.

## Steps

1. **Upload the build.** Same archive, no rebuild:

   ```
   node scripts/safari-xcode.mjs archive --no-build --no-stage --team 2TK86C98Z5 --upload
   ```

   This goes through the Apple account signed in to Xcode on this Mac. Processing takes a few
   minutes; the build then appears under **TestFlight → iOS builds**. If it asks for export
   compliance anyway, answer *No* to non-exempt encryption (standard HTTPS only).
2. **TestFlight on a real device.** Done on Kenneth's iPhone on 2026-10-13 (sign-in, a mod, a run surviving the popup's dismissal). For a later build: install it from TestFlight on an iPhone, enable the
   extension (Settings → Apps → Safari → Extensions → usermods, allow on all websites), connect a
   provider, write one mod and reload the page. Check that a subscription sign-in completes and
   that a run survives the popup being dismissed; the simulator cannot prove either (see
   [docs/safari.md](../../safari.md#what-only-a-device-can-prove)). Take the device screenshots
   while you are there if the simulator ones in `screenshots/` are not wanted.
3. **Fill the record through the API.** Steps 3 to 6 of the web form are one command, so what
   goes to Apple is the reviewed text and images in this folder and not a paste:

   ```
   node scripts/appstore-connect.mjs status     what the record holds
   node scripts/appstore-connect.mjs prepare    version string, build, copy, screenshots, review notes, manual release
   node scripts/appstore-connect.mjs submit     add the version to a review submission and submit it
   ```

   `prepare` renames the version from 1.0 to the checkout's version, selects the processed build
   with the checkout's build number, pastes the blocks from [listing.md](listing.md), uploads the
   two screenshot sets from `screenshots/`, writes the review information from
   [reviewer-notes.md](reviewer-notes.md) with its placeholders filled, and sets manual release.
   It changes nothing twice, so it can be run again after a correction. The script's header says
   what goes in `~/.config/usermods/appstore.env`: the API key, and the reviewer endpoint, key and
   contact that fill the notes. Nothing of that is in the repository.
4. **App Review Information**, done by `prepare` from the env file: *Sign-in required* unticked (the
   app has no account), the contact, and the notes with the reviewer endpoint and key. The
   reviewer key was extended on 2026-10-13 to a month past 2026-10-17, so it outlives a review.
   Never commit it.
5. **Version release**: *Manually release this version*, set by `prepare`, so approval does not
   publish before the announcement post is ready.
6. **Submit.** `node scripts/appstore-connect.mjs submit`, iOS only; the macOS version is left
   alone. Or **Add for Review → Submit** on the record's page.

Before pressing Submit:

- [x] The uploaded build is 0.1.1 (1) and its status is *Ready to Submit* (not *Missing
      Compliance*). Uploaded 2026-10-13 after a first attempt was refused for an alpha channel in
      the 1024 icon ([docs/safari.md](../../safari.md#the-host-app)); the second was accepted and
      processed within minutes.
- [ ] The version string on the record reads 0.1.1.
- [ ] The reviewer key works: `curl -s -H "Authorization: Bearer $KEY" "$BASE_URL/models"` lists
      the model the notes name, and the notes carry the real URL and key, not the placeholders.
- [ ] Every screenshot is the exact pixel size Apple asks for (`sips -g pixelWidth -g pixelHeight`).
- [ ] `PRIVACY.md` on `main` is the one the record links to.

After submitting, watch the developer mailbox: App Review writes there, and a rejection is a
message, not a dashboard alert. Resolution Center replies go through the record's page. When it is
approved, release it manually, tag the release, and post the "now on iPhone" note from the launch
plan.

## What the Chrome runbook has that this one does not

No permission justifications (Safari has no equivalent form; what the extension can do is in the
manifest and the review notes), no remote-code question (answered in the notes instead), and no
listing checker yet: `scripts/listing-check.mjs` counts the Chrome description, and the App Store
description in [listing.md](listing.md) states its own counts.
