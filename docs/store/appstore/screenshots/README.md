# App Store screenshots

Screenshots for the iOS and iPadOS App Store submission, at the exact pixel sizes App Store Connect
asks for. All of them come from `scripts/appstore-screenshots.mjs` and from the full Safari build
(`npm run build:safari`), which includes the ChatGPT and SuperGrok sign-ins.

| Set | Size | Device used |
|---|---|---|
| `iphone-01.png` .. `iphone-05.png` | 1320 × 2868 | iPhone 6.9-inch display: iPhone 17 Pro Max simulator, iOS 26.5 |
| `ipad-01.png` .. `ipad-04.png` | 2064 × 2752 | iPad 13-inch display: iPad Pro 13-inch (M5) simulator, iPadOS 26.5 |

`sips -g pixelWidth -g pixelHeight` was run on every file, and the script checks the sizes itself
at the end of each run.

## Which are real captures and which are composites

There are two kinds of image here. The table says which kind each file is.

**Simulator captures.** `xcrun simctl io <udid> screenshot`, used as captured. Each one shows the
installed app's extension, enabled in Mobile Safari, doing the job in the picture.

**Popup renders.** The extension's own `popup.html` from the built Safari bundle, served by
`scripts/safari-preview.mjs` with stubbed extension APIs (`?fixture=appstore`) and rendered by
Playwright's WebKit at the device's exact point size and pixel ratio: 440 × 956 at 3x for the
iPhone, and 440 × 720 at 2x for the iPad popover. The document, CSS and React build are the real
ones. The data is fixture data and nothing runs, so the chat transcript is fixture text and no
model wrote it. These views come from the preview because the real popup only opens when someone
taps the toolbar button, and `simctl` cannot tap.

| File | What it shows | Kind |
|---|---|---|
| `iphone-01.png` | The chat on a Wikipedia article proposing a mod: the request, the folded steps, the reply, and the **Proposed mod** card with its code open and **Run once** / **Save & enable**. The draft pill is underneath. | Popup render, composited. The popup fills the frame as it does on an iPhone. The status-bar inset (62 pt) and home-indicator inset (34 pt), which the popup pads for on a device, are filled with the colours of the render's own top and bottom rows. The status bar itself is not drawn. |
| `iphone-02.png` | The saved mod "Wikipedia: reading mode" running on the article in Mobile Safari: paper background, serif body, warm links, no hatnote. | **Real simulator capture.** |
| `iphone-03.png` | Mods: install from a URL or a file, then the mods that match this site, each with its on/off switch. | Popup render, composited like `iphone-01`. |
| `iphone-04.png` | The install page that the extension opens for a `.user.js` link: name, version, description, source, match patterns, grants, run-at, **Install** / **Cancel**. | **Real simulator capture.** |
| `iphone-05.png` | Settings: the connected providers (an Anthropic key, the ChatGPT and SuperGrok subscriptions, LM Studio), the add-provider presets and the preferences. | Popup render, composited like `iphone-01`. |
| `ipad-01.png` | The chat proposing the same mod, in the popover over the article before the mod runs. | Composite: the popup render (880 × 1440 px), drawn over a **real simulator capture** of the unmodified article and placed under the toolbar's usermods button. The rounded corners and shadow are drawn to stand in for the system popover. The popover's arrow is not drawn. |
| `ipad-02.png` | The saved mod running on the article in Safari on iPad. The usermods button is in the toolbar. | **Real simulator capture.** |
| `ipad-03.png` | Mods in the popover, over the article with the mod running. | Composite, like `ipad-01`, over the real capture used for `ipad-02`. |
| `ipad-04.png` | The install page for a `.user.js` link on iPad. | **Real simulator capture.** |

### What the real captures needed that was not a tap

- **Enabling the extension.** The script writes `Enabled`, `GrantedPermissions` and
  `GrantedPermissionOrigins` (`<all_urls>`) into Safari's
  `Library/Safari/WebExtensions/Extensions.plist` on each simulator. This is what
  Settings > Apps > Safari > Extensions > usermods > Allow writes. It is the same method
  `docs/safari.md` describes under "Enabling on iOS was written, not tapped".
- **The saved mod.** The script writes one `mods` row (and the `consent` row) into the extension's
  `storage.local`, which is Safari's `LocalStorage.db` in
  `Library/WebKit/com.apple.mobilesafari/WebExtensions/Default/<extension>/`. The row has the shape
  `lib/mods.ts` saves. The script writes it because saving through the UI needs a tap on Install.
  From there it is the product's own path: the background read the row, matched the page and ran
  the mod.
- **The page.** On the machine these were made on, the simulator had no network, so it could not
  reach Wikipedia. The article ("Bulletin board system", CC BY-SA) is a snapshot of the live mobile
  page, with styles inlined, images saved locally and scripts removed. It is served from
  `127.0.0.1:8800`, so **Safari's address bar reads `127.0.0.1`** and the install page's "Fetching
  from" line shows a `127.0.0.1:8800` URL. The saved mod has one extra match pattern,
  `http://127.0.0.1:8800/wiki/*`, because the Safari engine's matcher does not treat a pattern
  without a port as matching a port. The Mods list shows only the Wikipedia pattern because that
  view is the fixture's. `ipad-01` sits on the same snapshot served from port 8801, which no mod
  matches, so it shows the page before the mod.
- **The status bar.** It is set with `xcrun simctl status_bar override` to 9:41, full bars and a
  full battery.
- The install page previews a second fixture script, "YouTube: no Shorts". This way it shows a
  fresh install, not "already installed, reinstall".

### What was not captured, and why

- **The extension's real popup, opened from the toolbar.** Automation cannot tap the toolbar
  button. The chat, Mods and Settings views are the preview renders described above, not the
  popup as Safari presents it.
- **A chat that a model actually ran.** No model was used. The transcript is the
  `?fixture=appstore` fixture in `scripts/safari-preview.mjs`.
- **A real website address in the bar.** See "The page" above.

## Regenerating

Prerequisites: Xcode with the iOS 26 simulators, `npm ci`, `npx playwright install webkit`, and
working `curl` access to `en.m.wikipedia.org` for the article snapshot (it goes through the
machine's proxy settings).

```sh
# Build the full Safari web build, stage it, build the app, install it on the iPhone, and boot it
node scripts/safari-xcode.mjs simulator --device 'iPhone 17 Pro Max'

# Install the same app on the iPad and boot it
xcrun simctl boot <ipad-udid>    # iPad Pro 13-inch (M5)
xcrun simctl install <ipad-udid> .output/safari-xcode/Build/Products/Debug-iphonesimulator/usermods.app

# Open any page in Safari once on each simulator so Safari registers the extension
# and creates its store
xcrun simctl launch <udid> com.apple.mobilesafari

# Captures, renders, composites, size check
node scripts/appstore-screenshots.mjs        # or: npm run appstore-screenshots
```

You can also run the steps on their own: `--sim` (simulator captures), `--render` (popup renders)
and `--compose` (composites and size check). Intermediate images go to `.output/appstore/raw/`.
When the same device name exists on more than one runtime, the script uses the booted one.
