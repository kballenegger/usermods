# The usermods launch video

An experiment: a one-minute launch video made with [HyperFrames](https://github.com/heygen-com/hyperframes)
(HeyGen's open-source HTML-to-video framework, Apache 2.0), in the BBS Underground style of
[`docs/banner.png`](../docs/banner.png). A composition is an HTML file whose timing lives in
`data-*` attributes and whose motion is a single paused GSAP timeline; the HyperFrames CLI seeks it
frame by frame in headless Chrome and encodes the frames to MP4.

## The cuts

| File in `out/` | Shape | Length | For |
| --- | --- | --- | --- |
| `usermods-launch-16x9.mp4` (= `usermods-launch.mp4`) | 1920 x 1080 | 60 s | the master: README, YouTube, sites |
| `usermods-launch-1x1.mp4` | 1080 x 1080 | 60 s | square feeds |
| `usermods-launch-9x16.mp4` | 1080 x 1920 | 60 s | Reels, Shorts, TikTok, Stories; text kept between y=220 and y=1500, clear of the platforms' UI |
| `usermods-launch-x.mp4` | 1080 x 1080 | 51 s | an X post (below); about 31 MB at 5 Mbps, so not committed |
| `usermods-launch-readme.mp4` | 1920 x 1080 | 60 s | the README copy, under 10 MB (below) |

All are H.264 High, yuv420p, 30 fps, AAC. Each shape is its own layout, not a crop: the scenes,
the captions and the camera are composed for it. In the square and tall cuts the camera works the
side panel harder (it is the story) and goes to the page for the before/after.

**The X cut** is square: X plays 16:9, 1:1 and 9:16 inline, and on a phone a square takes more of
the timeline's height than 16:9 without the letterboxing or cropping a tall video gets in the feed.
It is a tighter edit of the same beats (51 s), opens with the wordmark and the one-line promise on
screen by 0.9 s since autoplay is muted, carries every word as burned-in text, and ends on the
GitHub URL. It is re-encoded to X's recommended upload settings: H.264 High, yuv420p, 30 fps
constant, closed 2 s GOPs, 5 Mbps constant bitrate (X's recommended minimum), AAC-LC 128 kbps
stereo, `+faststart`. Sources: X's media best practices,
<https://docs.x.com/x-api/media/quickstart/best-practices> (H.264 High, 30/60 fps, 1:1 or 16:9,
min 5,000 kbps video and 128 kbps AAC-LC, YUV 4:2:0 only, no open GOP, aspect between 1:3 and
3:1, dimensions up to 1280x1024 for API uploads), and for app/web uploads the widely reported
1920x1200 / 1200x1900 maximum, 512 MB and 2:20 length limits (X's own help page could not be
fetched; e.g. <https://www.heyorca.com/blog/x-twitter-media-specs-best-practices-2026>). Posting
through the API rather than the app would need the file scaled to 1024x1024 first.

## Render it

```sh
npm run video            # from the repo root: installs video/'s pinned deps, renders the master
npm run video:all        # from the repo root: every cut above
```

or, inside `video/`:

```sh
npm ci
npm run render           # the master -> out/usermods-launch.mp4
npm run render:all       # all four cuts -> out/usermods-launch-{16x9,1x1,9x16,x}.mp4
npm run render:draft     # fast, lower quality master -> out/usermods-launch-draft.mp4
npm run preview          # HyperFrames Studio in the browser, with a scrubbable timeline
npm run lint             # composition lint
npm run sheet            # contact sheet of the master, one frame every 3 s
npm run sheet:all        # contact sheets of every cut
```

The compositions are generated. `src/body.html` (markup with size and timing placeholders),
`src/launch.css` (styles, with a section per layout keyed on `#root[data-layout]`) and
`src/launch.js` (the timeline, driven by `window.LAYOUT`) are the sources; `scripts/variants.mjs`
holds each cut's config (frame size, scene cuts, camera shots, pacing) and writes `index.html` (the
master, committed so Studio opens it directly) and `variants/{square,vertical,x}.html`.
HyperFrames wants one root composition per project, so the others sit one folder down and render
with `--composition`. `scripts/prepare.mjs` runs it before every render.

HyperFrames is pinned at **0.8.62** and GSAP at **3.14.2** in `video/package.json`, a separate
package so the extension's own dependencies are untouched. Requirements: Node 22+ and ffmpeg.

`scripts/render.mjs` wraps `hyperframes render` for two local reasons: it turns telemetry off
(`HYPERFRAMES_NO_TELEMETRY=1`), and it points HyperFrames at Playwright's cached
`chrome-headless-shell` (the one the screenshot harness already installed) through
`PRODUCER_HEADLESS_SHELL_PATH`, because HyperFrames' own first-run download of that shell hangs
where Google's CDN is slow or blocked. Set the variable yourself to use a different browser.

Do **not** run `hyperframes init` in this folder: it installs the HyperFrames agent skills into
every agent directory in your home folder (`~/.claude/skills`, `~/.agents/skills`, `~/.codex`,
`~/.cursor`, ...), not into the project.

## The README block

The top-level README shows `docs/video-poster.jpg` linking to the 16:9 master. Both it and a
GitHub-attachment-sized copy of the master come from one script, run after a render:

```sh
npm run video:readme     # from the repo root (or `npm run readme` inside video/)
```

- `docs/video-poster.jpg`: 1280x720, the demo mid-transformation (the page turning dark under
  "Run once. The page changes.") with a pixel play badge and the runtime in a corner chip, drawn in
  HTML in the brand's colours and pixel art. Saved as PNG unless the PNG is over 400 KB and the
  JPEG less than half its size (as now). Pass a different time in seconds to pick another frame.
- `out/usermods-launch-readme.mp4`: the master, two-pass H.264 High / yuv420p at 1920x1080, AAC
  96 kbps, `+faststart`, sized to land about 10% under GitHub's 10 MB video attachment cap. Drag it
  into a GitHub comment or release to get a `github.com/user-attachments` URL, then replace the
  README's poster block with that URL on its own line (the comment above the block says so).

## Re-capture the demo footage

The demo beat is the real extension. `capture/capture.mjs` builds nothing itself; run it through
the root script, which makes the test build first:

```sh
npm run video:capture    # from the repo root
```

It opens the real side panel (the `USERMODS_TEST_BUILD` output) against the repo's scripted mock
backend, `scripts/mock-llm.mjs`, on the live Hacker News "Show HN" page, types
`make hacker news dark` one character per frame, lets the mock's `hacker-news-dark` conversation
run, and writes stills (lossless WebP) to `assets/capture/` together with `capture.js`, which lists
the frames and where the card and its buttons sit. No API key and no model endpoint are involved.
The stills are committed, so a render does not need network access.

**Token-by-token streaming.** The mock streams whole words 12 ms apart, too fast to photograph. So
the panel talks to a small pacing proxy inside `capture.mjs` instead, which forwards each request
to the mock and re-streams the reply in token-sized pieces (1-4 characters, whole short words with
their punctuation, longer words split into sub-word pieces, seeded), holding the stream after every
piece until the panel has rendered it and been photographed. Tool calls are forwarded whole and the
panel really runs them between requests. Every streaming frame is therefore the real panel, with
its real wrapping and its "writing" status bar, one token further on. The composition plays those
frames at a seeded, uneven cadence (about 30-80 ms a piece, the odd longer hesitation), with a
beat before each tool row and a shorter one before the text resumes. The status bar's elapsed
seconds count the capture's own (slower) wall-clock time.

Three things in the capture are adjusted, all for the same reasons the README screenshots are
(see the notes at the top of `scripts/screenshots.mjs`):

- `chrome.userScripts` does not exist in an automated Chrome profile, so the panel's first-run
  setup notice and the card's "not tested on this page" line are hidden with the README captures'
  CSS masks.
- For the same reason **Run once** cannot execute in that profile. The "after" page is made by
  evaluating the proposed mod's exact code (read back out of the card) in the page, which is what
  Run once injects. **Save** is real: the mod is written to storage and shows in the Mods tab.
- The mock titles every chat "Full-width Wikipedia articles" (its one canned title reply). The
  capture relabels that one `<option>` to "Hacker News dark", the title a real model gives this
  request. Storage is untouched.

The capture takes about 20 s to photograph the reply; the video plays it in about 5. The user's
prompt stays a plain typewriter, one character per captured frame at about 13.5 characters a
second.

**The page change.** Run once turns the page dark block by block: a grid of 67 x 71 tiles of the
"after" capture flipping on in a seeded order. Each tile overlaps its neighbours by 2 px so no
hairline shows between tiles at any camera scale, and the moment the last one has flipped the grid
is replaced by the single "after" image, so the settled page is one continuous surface.

## What is real and what is rebuilt

| Beat | Time | Source |
| --- | --- | --- |
| Cold open: wordmark, tagline | 0:00-0:04.5 | Rebuilt in HTML: Jersey 10 wordmark, brand palette, pixel sprites drawn in code |
| The problem | 0:04.5-0:08 | Rebuilt in HTML (typed text) |
| Demo: type, the reply streams in token by token, proposal, Run once, Save, Mods tab | 0:08-0:30 | **Real captures** of the extension (see above). The browser frame, cursor, click pings, card highlight and captions are drawn in HTML on top |
| 01 Any model | 0:30-0:34.2 | Real: `docs/screenshots/12-model-picker.png` |
| 02 Edit any installed mod | 0:34.2-0:38.4 | Real: `docs/screenshots/11-editing.png` |
| 03 Tampermonkey import | 0:38.4-0:42.6 | Real: `docs/screenshots/06-migrate.png` |
| 04 Chrome and Safari | 0:42.6-0:46.8 | Real: `docs/screenshots/ios-ui/*` (iPad popover, iPhone), in drawn device frames (the iPad is left out of the square and tall layouts) |
| 05 Open source, MIT | 0:46.8-0:51 | Rebuilt: a code window showing the metadata block of the mod saved in the demo, as captured |
| End card | 0:51-1:00 | Rebuilt in HTML |

## Style

Taken from `docs/branding.md`, `docs/design.md` and `entrypoints/sidepanel/tokens.css`: the six
identity colours used literally (electric blue page, lime wordmark with a cyan lower edge and an
ink offset shadow, yellow tagline, pink rule), navy `#0C1220` for the quieter beats, hard offset
shadows and square corners. Type is the repo's own `@fontsource` faces (OFL): **Jersey 10** for the
wordmark and the big numbers only, **IBM Plex Mono** for everything else. Pixel art (stars, moon,
cursor, skyline) is drawn as SVG rects with `shape-rendering: crispEdges`, and the icon is the
canonical `assets/icon.svg`. Motion is stepped (`steps()` eases) so it moves like pixels, and the
scene changes are blocky 120px wipes with seeded order, so every render is identical.

## Audio

`scripts/music.mjs` synthesises the chiptune bed sample by sample: pulse-wave bass and arpeggio, a
triangle lead and noise drums, from a seeded PRNG. No samples or third-party audio. It runs at
120 BPM, every scene cut sits on a beat, and the arrangement is generated from each cut's own
scene times (drums in at the problem line, the lead on the demo cut, a breakdown into the
features, a thinner end card), so the 51 s X cut gets its own track. All of the
video's message is carried by on-screen text, so it works muted.

## Files

- `src/` the composition sources; `index.html` and `variants/` are generated from them
- `scripts/variants.mjs` the per-cut configs and the generator
- `scripts/render-all.mjs` renders every cut and re-encodes the X one
- `capture/capture.mjs` the Playwright capture of the real extension
- `assets/capture/` its committed output
- `scripts/prepare.mjs` stages fonts, gsap, the icon, the README stills and the music into
  `assets/` (all generated and git-ignored)
- `scripts/music.mjs` the chiptune synthesiser
- `scripts/render.mjs` the render wrapper described above
- `scripts/contact-sheet.sh` the review sheet
- `scripts/readme-assets.mjs` the README poster and the README-sized encode
- `out/` renders, all git-ignored. Finished cuts are published as assets on the `launch-video` GitHub release, not committed.
