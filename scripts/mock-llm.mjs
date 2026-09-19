#!/usr/bin/env node
// A tiny OpenAI-compatible chat-completions server that plays scripted conversations.
//
// It exists so the screenshots in docs/screenshots can be regenerated without an API key, a
// network call, or a local model server. It speaks exactly the subset of the protocol that
// lib/providers/openai.ts sends and parses:
//
//   POST /v1/chat/completions  with {model, stream: true, messages, tools}
//        -> text/event-stream of `data: {choices:[{delta:{...}, finish_reason}]}` lines,
//           terminated by `data: [DONE]`.
//   GET  /v1/models            -> {data: [{id}, ...]}  (Settings' "Fetch models" button)
//   GET  /__requests           -> {requests: [{at, script, messages, images, hasImages}, ...]} body
//        DELETE /__requests    received, in order; the isolation flow reads this back to prove that
//                              one chat's user text never entered another chat's model
//                              conversation, and the images flow reads `images` — one entry per
//                              image_url part, with its media type, byte size, dimensions when the
//                              PNG header gives them, and where it sat relative to the text — to
//                              prove what an attachment actually looked like on the wire.
//                              DELETE empties the log.
//   GET  /__violations        -> {violations: [{at, kind, detail, script}, ...]}  every request
//        DELETE /__violations  that was structurally invalid. See "Validation" below.
//   POST /__faults            <- {plan: [fault, ...]}  make the NEXT chat-completions requests fail
//        GET  /__faults        the way a real network does. See "Fault injection" below. GET shows
//        DELETE /__faults      what is left of the plan; DELETE clears it (the outage is over).
//
// Scripting. A conversation is picked by matching the FIRST user message in the request against
// a script's `match` regex; the agent prefixes each turn with "[Current page: <title> — <url>]",
// so matching on the user's own words is enough. Within that script, the reply returned is the
// one at index = (number of assistant messages so far), which makes the loop deterministic: the
// agent calls back after each round of tool results and gets the next step.
//
// What the scripts deliberately avoid: run_script and screenshot. chrome.userScripts is
// unavailable in an automated profile (the "Allow User Scripts" toggle cannot be flipped
// programmatically), so those tools would fail and put an error row in the transcript. get_page,
// find_elements and get_styles all go through the content script and work fine.
//
// A consequence, since propose_mod started refusing untested scripts: every propose_mod here
// passes `untested_reason`, because in this profile a mod genuinely cannot be run first. That is
// the honest state and the proposal card says so. The one exception is the first propose in the
// `guardrails` scenario, which omits it on purpose so the smoke run can watch the loop refuse it.
//
// It is also the only reason a captured screenshot would carry a "not tested on this page" line;
// a real session with the user-scripts toggle on runs the script and shows no such line, so the
// capture scripts mask that line (HIDE_UNTESTED_LINE in scripts/screenshots.mjs). The asserting
// flows do not mask it — they assert it is visible.

import http from 'node:http';

// ---------------------------------------------------------------------------
// Scripted conversations
// ---------------------------------------------------------------------------

/**
 * The two markers the isolation flow asserts on. Each appears in exactly one script's output, so
 * finding one in the other chat's transcript is proof of a leak and nothing else.
 */
export const SLOW_MARKER = 'SLOWMARKER-6f3a';
export const FAST_MARKER = 'FASTMARKER-b21c';

/** The compaction flow's marker, so its transcript is identifiable the same way. */
export const COMPACT_MARKER = 'COMPACTMARKER-9d4e';

/** The images flow's marker, so its reply is identifiable in the transcript. */
export const IMAGES_MARKER = 'IMAGESMARKER-4c7b';

/** The artifact (draft mod) flow's marker. */
export const ARTIFACT_MARKER = 'ARTIFACTMARKER-7e21';

/**
 * The resume flow's markers and prompts. Four conversations, one per thing that can go wrong: a
 * stream that drops once, an outage that outlasts the retries, a service worker killed mid-run and
 * a panel closed mid-run. Each `done` marker appears only in that conversation's LAST step, so
 * seeing it means the run got all the way there; each `first` sentence appears only in its first
 * step, so counting it in the transcript is how a duplicated reply is caught.
 */
export const RESUME = {
  drop: {
    prompt: 'survive a dropped connection RESUMEPROMPT-a1',
    first: 'RESUMEFIRST-a1 I will read the page first and then report back on what it contains.',
    done: 'RESUMEDONE-a1',
  },
  outage: { prompt: 'survive a long outage RESUMEPROMPT-b2', first: 'RESUMEFIRST-b2 Reading the page.', done: 'RESUMEDONE-b2' },
  kill: { prompt: 'survive a dead worker RESUMEPROMPT-c3', first: 'RESUMEFIRST-c3 Reading the page.', done: 'RESUMEDONE-c3' },
  close: { prompt: 'survive a closed panel RESUMEPROMPT-d4', first: 'RESUMEFIRST-d4 Reading the page.', done: 'RESUMEDONE-d4' },
};

/**
 * How long the kill and close conversations hold a step's first byte, so the flow has time to act
 * while a request is demonstrably in flight. The kill conversation holds its second step (the
 * worker is killed under it). The close conversation holds its second step briefly (the panel is
 * closed under it, so that step's text, tool call and result all happen with no panel attached) and
 * its third step for longer (the panel is reopened under it, and must show a run in progress).
 */
export const RESUME_HOLDS = { kill: [0, 4000, 0], close: [0, 2000, 7000] };

/** Three steps: read the page, look at the heading, report. `holds[i]` delays step i's first byte. */
function resumeScript(name, r, holds = [0, 0, 0]) {
  const hold = (i) => (holds[i] ? { firstByteDelay: holds[i] } : {});
  return {
    name,
    match: new RegExp(r.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    steps: [
      { text: r.first, calls: [{ name: 'get_page', args: { max_chars: 4000 } }], ...hold(0) },
      { text: 'Now the heading.', calls: [{ name: 'find_elements', args: { selector: 'h1', limit: 3 } }], ...hold(1) },
      { text: `${r.done} The page has one heading and nothing else of note.`, ...hold(2) },
    ],
  };
}

/**
 * The three versions the artifact flow's draft passes through, as the mock streams them.
 *
 * They are exported so scripts/screenshots.mjs asserts against the exact text the server sent
 * rather than against a second copy that could drift from it — the same rule the isolation markers
 * follow. v1 and v2 differ by two lines in the middle, which is what makes the diff assertion
 * meaningful: a diff that reported the whole file as changed would pass a weaker check.
 */
export const ARTIFACT_V1 = `const style = document.createElement('style');
style.textContent = \`
  #promo-banner { display: none !important; }
  .promo-button { background: #888; }
\`;
document.head.appendChild(style);`;

export const ARTIFACT_V2 = `const style = document.createElement('style');
style.textContent = \`
  #promo-banner { display: none !important; }
  .promo-button { background: #1155dd; color: #fff; }
\`;
document.head.appendChild(style);`;

/** The third proposal, after the rollback, so 'Update mod' has something new to write. */
export const ARTIFACT_V3 = `const style = document.createElement('style');
style.textContent = \`
  #promo-banner { display: none !important; }
  .promo-button { background: #888; }
  .promo-footer { display: none !important; }
\`;
document.head.appendChild(style);`;

const ARTIFACT_NAME = 'Wikipedia: hide the promo banner';
const ARTIFACT_MATCHES = ['*://*.wikipedia.org/wiki/*'];
const ARTIFACT_DESC = 'Hides the promotional banner and tones down its button.';

/** propose_mod arguments for one version of the artifact flow's draft. */
function artifactProposal(code) {
  return {
    name: ARTIFACT_NAME,
    description: ARTIFACT_DESC,
    matches: ARTIFACT_MATCHES,
    untested_reason: 'chrome.userScripts is unavailable in this automated profile',
    code,
  };
}

/** How long the slow conversation holds its first byte, so a run is demonstrably still in flight. */
const FIRST_BYTE_MS = Number(process.env.MOCK_LLM_SLOW_MS ?? 4000);

/** The script the guardrails conversation proposes twice: once refused, once with an override. */
const REFERENCES_CODE = `const style = document.createElement('style');
style.textContent = '.reflist { font-size: 0.8em; columns: 2; }';
document.head.appendChild(style);`;

/**
 * Each step is one assistant turn: `text` streams out as content deltas, `calls` become tool_calls.
 * A step with calls ends with finish_reason "tool_calls"; one without ends with "stop".
 */
const SCRIPTS = [
  resumeScript('resume-drop', RESUME.drop),
  resumeScript('resume-outage', RESUME.outage),
  resumeScript('resume-kill', RESUME.kill, RESUME_HOLDS.kill),
  resumeScript('resume-close', RESUME.close, RESUME_HOLDS.close),
  {
    name: 'wikipedia-reader',
    match: /hide the sidebar and make the article full width/i,
    steps: [
      {
        text: "Let me look at the page structure first.",
        calls: [{ name: 'get_page', args: { max_chars: 12000 } }],
      },
      {
        text: "Vector 2022 skin. The table of contents is in #vector-toc-pinned-container and the body is capped by .mw-page-container. Checking both.",
        calls: [
          { name: 'find_elements', args: { selector: '#vector-toc-pinned-container, .vector-column-start', limit: 5 } },
          { name: 'get_styles', args: { selector: '.mw-page-container', properties: ['max-width', 'margin', 'padding-left'] } },
        ],
      },
      {
        text: "The container is capped at ~1600px with the sidebar reserving space on the left. Hiding the sidebar and lifting the cap gives the article the full window.",
        calls: [
          {
            name: 'propose_mod',
            args: {
              name: 'Wikipedia: full-width article',
              description: 'Hides the pinned table of contents and lets the article body use the whole window.',
              matches: ['*://*.wikipedia.org/wiki/*'],
              untested_reason: 'chrome.userScripts is unavailable in this automated profile',
              code: `const css = \`
  /* Pinned table of contents and the empty column it sits in */
  #vector-toc-pinned-container,
  .vector-column-start,
  .vector-sticky-pinned-container { display: none !important; }

  /* The skin reserves the sidebar's width with a padding on the container */
  .mw-page-container { max-width: none !important; padding-left: 1.5rem !important; }
  .mw-page-container-inner { column-gap: 0 !important; }

  /* Vector caps the prose itself, not just the shell */
  .mw-content-container,
  .vector-body { max-width: none !important; }
\`;

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);`,
            },
          },
        ],
      },
    ],
  },

  {
    name: 'hacker-news-dark',
    match: /make hacker news dark/i,
    steps: [
      {
        text: "Reading the markup — HN is table-based, so I want the real element names before writing selectors.",
        calls: [{ name: 'get_page', args: { max_chars: 8000 } }],
      },
      {
        text: "Three tables: #hnmain wraps everything, .titleline holds the story links, .subtext the byline. Confirming the background colors.",
        calls: [
          { name: 'get_styles', args: { selector: '#hnmain', properties: ['background-color', 'color'] } },
        ],
      },
      {
        text: "#f6f6ef on the body, #ff6600 on the header bar. A stylesheet is enough here — no JavaScript needed.",
        calls: [
          {
            name: 'propose_mod',
            args: {
              name: 'Hacker News dark',
              description: 'A dark theme for Hacker News: dark surfaces, dimmed orange header, readable link colors.',
              matches: ['*://news.ycombinator.com/*'],
              untested_reason: 'chrome.userScripts is unavailable in this automated profile',
              code: `const css = \`
  body, #hnmain { background: #16181c !important; color: #c9ccd1 !important; }

  /* Header keeps HN's orange, dimmed so it is not the brightest thing on screen */
  #hnmain > tbody > tr:first-child td { background: #b34700 !important; }

  a:link { color: #9db4d0 !important; }
  a:visited { color: #6f7f92 !important; }

  .titleline > a { color: #e6e8ea !important; }
  .subtext, .subtext a, .rank, .age a, .hnname { color: #8b9096 !important; }

  /* Comment threads and the reply form */
  .comment, .commtext { color: #c9ccd1 !important; }
  .c00, .c00 a:link { color: #c9ccd1 !important; }
  textarea, input[type=text] { background: #22252a !important; color: #e6e8ea !important; border: 1px solid #3a3f46 !important; }

  .votearrow { filter: invert(0.85) hue-rotate(180deg); }
\`;

const style = document.createElement('style');
style.textContent = css;
document.documentElement.appendChild(style);`,
            },
          },
        ],
      },
    ],
  },

  {
    // The @element-reference exchange. The panel sends "[@token = label — selector: …]" ahead of
    // the user's text, so the reply can talk about the element the user pointed at.
    name: 'element-reference',
    match: /this box/i,
    steps: [
      {
        text: "That's the site-notice banner at the top of the article. Checking whether anything else on the page uses the same class before I match on it.",
        calls: [{ name: 'find_elements', args: { selector: '.mw-dismissable-notice, #siteNotice', limit: 10 } }],
      },
      {
        text: "Only the one, and it is inserted after load, so the mod watches for it rather than running once.",
        calls: [
          {
            name: 'propose_mod',
            args: {
              name: 'Wikipedia: no site notices',
              description: 'Removes the dismissable banner at the top of articles, including ones inserted after load.',
              matches: ['*://*.wikipedia.org/*'],
              untested_reason: 'chrome.userScripts is unavailable in this automated profile',
              code: `const SELECTOR = '#siteNotice, .mw-dismissable-notice';

const drop = () => document.querySelectorAll(SELECTOR).forEach((el) => el.remove());

drop();

// Fundraising banners arrive after the first paint, so keep watching for a little while.
const observer = new MutationObserver(drop);
observer.observe(document.body, { childList: true, subtree: true });
setTimeout(() => observer.disconnect(), 10000);`,
            },
          },
        ],
      },
    ],
  },

  {
    // The attached-images flow (screenshots.mjs --images). The user pastes a mockup and drops a
    // second one, so this script is picked by words a person would actually type beside a picture.
    // One step, no tool calls: the flow is about what reached the wire and what the panel shows,
    // and a proposal card would only add rows for it to scroll past.
    name: 'attached-images',
    match: /make the header look like this/i,
    steps: [
      {
        text: `${IMAGES_MARKER} I can see the mockup: a dark bar with the title centred. Nothing to change on the live page yet — tell me which part to start with.`,
        calls: [],
      },
    ],
  },

  {
    // A deliberately slow first byte, for the side panel's activity indicator. The point of that
    // line is to tell "the model is thinking" apart from "the thing is stuck", and there is no way
    // to see it work without a backend that makes the panel wait. `firstByteDelay` holds the
    // response open before anything is streamed, the way a thinking model does.
    name: 'slow-first-byte',
    match: /take your time/i,
    steps: [
      {
        firstByteDelay: 3000,
        text: 'Thanks for waiting. Let me look at the page.',
        // Several big snapshots, executed one after another. The panel's activity line has to be
        // observable while a tool runs, and a single page-inspection call against a local content
        // script can finish inside one animation frame, leaving nothing for the smoke test to see.
        // A run of them keeps the tool phase on screen for long enough to be asserted on honestly.
        calls: [
          { name: 'get_page', args: { max_chars: 60000 } },
          { name: 'get_page', args: { max_chars: 60000 } },
          { name: 'get_page', args: { max_chars: 60000 } },
          { name: 'find_elements', args: { selector: '#firstHeading', limit: 3 } },
        ],
      },
      {
        // A second slow step, so the indicator is seen going back to a model phase after a tool
        // one, rather than only at the very start of the run.
        firstByteDelay: 2000,
        text: 'That is the article title. Nothing to change here.',
        calls: [],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // The chat-isolation flow (screenshots.mjs --isolation). Two conversations whose output cannot
  // be mistaken for one another, and one of them is slow enough to still be streaming while the
  // user has moved to another tab and started the other.
  // ---------------------------------------------------------------------------
  {
    name: 'isolation-slow',
    match: /walk the ancestry of the slow marker/i,
    // First byte only after FIRST_BYTE_MS, so the panel is still waiting when the user switches.
    slowFirstByte: true,
    steps: [
      {
        text: `${SLOW_MARKER} step one: reading the page before I touch anything.`,
        calls: [{ name: 'get_page', args: { max_chars: 4000 } }],
      },
      {
        text: `${SLOW_MARKER} step two: the selectors check out, here is the rest of the answer.`,
        calls: [],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // The compaction flow (screenshots.mjs --compaction). Several USER TURNS, each reading the page
  // again, so the history crosses a shrunken contextBudget and BOTH tiers have something to do.
  //
  // Turns, not just tool rounds, are what tier 2 needs: it cuts only at user-turn boundaries, so a
  // single long turn — however many get_page calls it makes — can only ever be elided. The flow
  // sends four messages, and each one is a separate script below, matched on its own words.
  //
  // The SIZE comes from the page itself: get_page at max_chars against a real Wikipedia article is
  // tens of thousands of characters per call, and the history keeps every one of them.
  // ---------------------------------------------------------------------------
  {
    name: 'compaction-1',
    match: /trace every heading on this page/i,
    steps: [
      { text: `${COMPACT_MARKER} turn 1: reading the page.`, calls: [{ name: 'get_page', args: { max_chars: 60000 } }] },
      { text: `${COMPACT_MARKER} turn 1: and again, scoped to the content.`, calls: [{ name: 'get_page', args: { max_chars: 60000, selector: '#content' } }] },
      { text: `${COMPACT_MARKER} turn 1: the headings are h2 inside .mw-heading.`, calls: [] },
    ],
  },
  {
    name: 'compaction-2',
    match: /now check the infobox/i,
    steps: [
      { text: `${COMPACT_MARKER} turn 2: reading the page again for the infobox.`, calls: [{ name: 'get_page', args: { max_chars: 60000 } }] },
      { text: `${COMPACT_MARKER} turn 2: the infobox is a table.tab.`, calls: [{ name: 'find_elements', args: { selector: 'table.infobox, h2', limit: 100 } }] },
      { text: `${COMPACT_MARKER} turn 2: got it.`, calls: [] },
    ],
  },
  {
    name: 'compaction-3',
    match: /and the references section/i,
    steps: [
      { text: `${COMPACT_MARKER} turn 3: another full read for the references.`, calls: [{ name: 'get_page', args: { max_chars: 60000 } }] },
      { text: `${COMPACT_MARKER} turn 3: and the body once more.`, calls: [{ name: 'get_page', args: { max_chars: 60000, selector: 'body' } }] },
      { text: `${COMPACT_MARKER} turn 3: references live under #References.`, calls: [] },
    ],
  },
  {
    name: 'compaction-4',
    match: /now write the mod/i,
    steps: [
      { text: `${COMPACT_MARKER} turn 4: one last look.`, calls: [{ name: 'get_page', args: { max_chars: 60000 } }] },
      {
        text: `${COMPACT_MARKER} done — here is the mod.`,
        calls: [
          {
            name: 'propose_mod',
            args: {
              name: 'Wikipedia: numbered headings',
              description: 'Numbers the section headings of an article.',
              matches: ['*://*.wikipedia.org/wiki/*'],
              untested_reason: 'chrome.userScripts is unavailable in this automated profile',
              code: "document.querySelectorAll('.mw-heading h2').forEach((h, i) => { h.prepend(`${i + 1}. `); });",
            },
          },
        ],
      },
    ],
  },

  {
    name: 'isolation-fast',
    match: /name the fast marker/i,
    steps: [
      {
        text: `${FAST_MARKER} answered immediately, in a different chat on a different site.`,
        calls: [],
      },
    ],
  },

  {
    // The agent-guardrails conversation, for the smoke run. It deliberately misbehaves twice, so
    // the smoke can assert that the loop pushes back rather than going along with it:
    //
    //   steps 0-3  four page reads in a row and nothing acted on  -> lib/agent/budget.ts nudges
    //   step 4     propose_mod with no run_script behind it       -> lib/agent/propose.ts refuses
    //   step 5     propose_mod again with untested_reason         -> accepted, card says untested
    //
    // The second propose is the recovery path an override is for: chrome.userScripts is
    // unavailable under automation (see note 4 in scripts/screenshots.mjs), so a script here
    // genuinely cannot be run, which is exactly the situation untested_reason exists to describe.
    name: 'guardrails',
    match: /tidy up the references section/i,
    steps: [
      { text: 'Looking at the page.', calls: [{ name: 'get_page', args: { max_chars: 6000 } }] },
      { text: 'Checking the reference list.', calls: [{ name: 'find_elements', args: { selector: '.reflist', limit: 3 } }] },
      { text: 'And the citations inside it.', calls: [{ name: 'find_elements', args: { selector: '.reference', limit: 3 } }] },
      { text: 'One more look at the styling.', calls: [{ name: 'get_styles', args: { selector: '.reflist', properties: ['font-size'] } }] },
      {
        text: 'That should be enough to write it.',
        calls: [
          {
            name: 'propose_mod',
            args: {
              name: 'Wikipedia: compact references',
              description: 'Shrinks the reference list so it takes less room at the bottom of an article.',
              matches: ['*://*.wikipedia.org/wiki/*'],
              code: REFERENCES_CODE,
            },
          },
        ],
      },
      {
        text: 'I cannot run scripts on this page, so I am proposing it untested.',
        calls: [
          {
            name: 'propose_mod',
            args: {
              name: 'Wikipedia: compact references',
              description: 'Shrinks the reference list so it takes less room at the bottom of an article.',
              matches: ['*://*.wikipedia.org/wiki/*'],
              code: REFERENCES_CODE,
              untested_reason: 'scripts cannot be run in this browser profile',
            },
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// The wait_for flow
// ---------------------------------------------------------------------------
//
// This one is scripted against a fixture page this server serves itself (/__fixture/async.html),
// rather than a live site, because every condition it exercises needs the page to change on a
// known schedule: content that arrives after 800ms, a pushState route change after 300ms, an
// element that becomes visible through a class flip and no DOM mutation at all, and a region that
// mutates for 1.5s and then stops. No real site offers all four on demand.
//
// It deliberately includes a wait that CANNOT succeed. A timeout is the outcome the design cares
// most about — it must come back as a plain, diagnostic statement rather than an error — and the
// only way to see that is to ask for something that is not there.

export const WAIT_MARKER = 'WAITMARKER-3ab7';

// ---------------------------------------------------------------------------
// The vision flow's two conversations
// ---------------------------------------------------------------------------
//
// One takes a screenshot against a backend that accepts images and one takes a screenshot against
// a backend that refuses them, which is the pair the whole feature turns on. Both use `screenshot`
// rather than run_script, for once: unlike chrome.userScripts, chrome.tabs.captureVisibleTab works
// perfectly in an automated profile, so this is one of the few tool calls the harness can drive for
// real — and the point of the flow is what the CAPTURE looked like on the wire.

export const VISION = {
  sighted: {
    prompt: 'look at the page and tell me what you see VISIONPROMPT-s1',
    done: 'VISIONDONE-s1',
  },
  blind: {
    prompt: 'look at the page and tell me what you see VISIONPROMPT-b2',
    done: 'VISIONDONE-b2',
  },
};

/** Two steps: take a screenshot, then report. The report is what the flow waits for. */
function visionScript(name, v) {
  return {
    name,
    match: new RegExp(v.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    steps: [
      { text: 'Taking a look at the page.', calls: [{ name: 'screenshot', args: {} }] },
      { text: `${v.done} I have what I need from the page.` },
    ],
  };
}

const WAIT_SCRIPT = {
  name: 'wait-for',
  match: /test the waiting/i,
  steps: [
    {
      // 1. An already-true condition. The assertion on this one is a TIME: the fixture's #ready is
      // present from first paint, so this must come back in ~0ms rather than after an observer
      // tick, which is what makes waiting cheap enough that the model will keep reaching for it.
      text: 'Checking what is already on the page.',
      calls: [{ name: 'wait_for', args: { selector: '#ready', state: 'visible' } }],
    },
    {
      // 2. Content that lazy-loads. The fixture inserts three .result items 800ms after #load is
      // clicked; find_elements alone would see none of them.
      text: 'Now waiting for the results that load late.',
      calls: [{ name: 'wait_for', args: { selector: '.result', count: 3, timeout_ms: 8000 } }],
    },
    {
      // 3. A style-only reveal: #fade is in the DOM the whole time and becomes visible because the
      // page edits the CSS RULE that hid it. Nothing mutates, so a MutationObserver is blind to it
      // — this is exactly what the polling floor in lib/waitdom.ts is there to catch.
      text: 'Waiting for the element that becomes visible without any DOM change.',
      calls: [{ name: 'wait_for', args: { selector: '#fade', state: 'visible', timeout_ms: 8000 } }],
    },
    {
      // 4. Page text, which is how a model checks for a result it has no selector for.
      text: 'Checking the page says it finished.',
      calls: [{ name: 'wait_for', args: { text: 'Loaded three results', timeout_ms: 8000 } }],
    },
    {
      // 5. A SPA route change. No navigation happens — pushState only — so nothing but a url
      // condition watched from the background would see it.
      text: 'Waiting for the route to change.',
      calls: [{ name: 'wait_for', args: { url: '/__fixture/async.html?step=2', timeout_ms: 8000 } }],
    },
    {
      // 6. The region that mutates for 1.5s then stops: "wait until it stops changing".
      text: 'Waiting for the churn to settle.',
      calls: [{ name: 'wait_for', args: { idle: true, quiet_ms: 400, timeout_ms: 8000 } }],
    },
    {
      // 7. The deliberate timeout. Nothing on the fixture matches, and nothing ever will.
      text: 'Now waiting for something that will never appear.',
      calls: [{ name: 'wait_for', args: { selector: '.never-going-to-exist', timeout_ms: 1500 } }],
    },
    {
      text: `${WAIT_MARKER} The waits behaved: the ready element matched at once, the late results and the faded element both arrived, the route changed, the page settled, and the impossible one timed out with diagnostics rather than an error.`,
      calls: [],
    },
  ],
};

/**
 * The long wait the Stop assertion interrupts. One call, twenty seconds, nothing that will match:
 * pressing Stop must end the run promptly rather than at the timeout, and must leave no observer
 * behind on the page.
 */
const WAIT_STOP_SCRIPT = {
  name: 'wait-stop',
  match: /wait a really long time/i,
  steps: [
    {
      text: 'Waiting for something that will not happen for a while.',
      calls: [{ name: 'wait_for', args: { selector: '.also-never-exists', timeout_ms: 20000 } }],
    },
    { text: 'Done waiting.', calls: [] },
  ],
};

// ---------------------------------------------------------------------------
// The artifact flow (screenshots.mjs --artifact). One chat, one draft, three turns.
//
// Turn 1 proposes v1. Turn 2 is "make the button blue instead" — the request the whole feature
// exists for — and the reply proposes a COMPLETE updated script that differs from v1 by two lines,
// which is what the panel's diff has to show. Between turns 2 and 3 the flow rolls back to v1
// through the UI, so turn 3's request carries v1's code in its draft block rather than v2's: that
// is the assertion that proves the model is being told what the draft actually is, not merely what
// it last said.
//
// Each turn is its own script, matched on its own words, because pickScript takes the LAST matching
// user message — the same shape the compaction flow uses for its four turns.
const ARTIFACT_SCRIPTS = [
  {
    name: 'artifact-1',
    match: /hide the promo banner on this page/i,
    steps: [
      { text: `${ARTIFACT_MARKER} reading the page to find the banner.`, calls: [{ name: 'get_page', args: { max_chars: 8000 } }] },
      {
        text: `${ARTIFACT_MARKER} found it. Here is the first version.`,
        calls: [{ name: 'propose_mod', args: artifactProposal(ARTIFACT_V1) }],
      },
    ],
  },
  {
    name: 'artifact-2',
    match: /make the button blue instead/i,
    steps: [
      {
        // No page read: the draft is attached to this turn, so an edit needs nothing else. That is
        // the behaviour the prompt asks for, and scripting it this way means the flow's assertion
        // about what the request carried is about the FIRST request of the turn.
        text: `${ARTIFACT_MARKER} changing the button's colour on the draft. One line moved.`,
        calls: [{ name: 'propose_mod', args: artifactProposal(ARTIFACT_V2) }],
      },
    ],
  },
  {
    name: 'artifact-3',
    match: /also hide the footer/i,
    steps: [
      {
        text: `${ARTIFACT_MARKER} added the footer rule to the draft.`,
        calls: [{ name: 'propose_mod', args: artifactProposal(ARTIFACT_V3) }],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// The edit-a-mod flow (screenshots.mjs --editmod).
//
// The owner's report: there is no easy way to keep adding to a mod. Everything below is a scripted
// model playing the three directions that answer it.
//
// The script under edit is an IMPORTED userscript with a real metadata block — @require, @grant,
// @connect, @run-at, a @version the Update button compares against — because that is the case the
// draft's kept-header machinery exists for, and the case a generated header would silently destroy.
// Every propose_mod here carries ONLY a body and four fields, exactly as a real model's does, so
// the flow's assertion that the block survived is an assertion about the product and not about the
// mock being careful.
// ---------------------------------------------------------------------------

/** The edit flow's marker, so its transcript is identifiable the way the others are. */
export const EDITMOD_MARKER = 'EDITMODMARKER-3b9f';

/**
 * The imported userscript the flow installs and then edits.
 *
 * A function of the base URL because its @require must resolve: installing a userscript fetches its
 * dependencies, so a dead @require is an install failure rather than a test fixture. The library is
 * served by this same server (/__fixture/kingfisher-lib.js), which also lets the flow assert that
 * the FETCHED BODY is still attached after an edit — a stronger claim than the @require line
 * surviving.
 */
export function editModSource(baseUrl) {
  return `// ==UserScript==
// @name        Kingfisher Notes
// @namespace   https://example.org/usermods
// @description Adds a notes box to kingfisher articles.
// @version     2.4.1
// @match       *://*.wikipedia.org/wiki/*
// @require     ${baseUrl}/__fixture/kingfisher-lib.js
// @grant       GM_setValue
// @grant       GM_getValue
// @connect     api.example.org
// @run-at      document-end
// ==/UserScript==

GM_setValue('installed', true);
document.documentElement.dataset.kingfisherNotes = 'v1';`;
}

/** The body of the first revision: the model keeps what was there and adds one line. */
export const EDITMOD_V2 = `GM_setValue('installed', true);
document.documentElement.dataset.kingfisherNotes = 'v2';
document.documentElement.dataset.kingfisherExtra = 'added-by-chat';`;

/**
 * The body the SECOND chat proposes, after finding the mod on the page and opening it.
 *
 * It has to differ from what that mod already holds (EDITMOD_V2), or addVersion dedupes it — a
 * model re-proposing the script that is already installed is not a new version, by design. So this
 * is a real further change, which is also what the scenario is about: a fresh chat picking up an
 * existing mod and adding to it rather than starting a second one.
 */
export const EDITMOD_V2B = `GM_setValue('installed', true);
document.documentElement.dataset.kingfisherNotes = 'v2';
document.documentElement.dataset.kingfisherExtra = 'added-by-chat';
document.documentElement.dataset.kingfisherMarked = 'yes';`;

/** The body of the revision proposed after a detach, which becomes a SEPARATE mod. */
export const EDITMOD_V3 = `GM_setValue('installed', true);
document.documentElement.dataset.kingfisherNotes = 'v3-detached';`;

const EDITMOD_NAME = 'Kingfisher Notes';
const EDITMOD_MATCHES = ['*://*.wikipedia.org/wiki/*'];

/** propose_mod arguments for one revision: a body and four fields, and no header. */
function editModProposal(code, name = EDITMOD_NAME) {
  return {
    name,
    description: 'Adds a notes box to kingfisher articles.',
    matches: EDITMOD_MATCHES,
    untested_reason: 'chrome.userScripts is unavailable in this automated profile',
    code,
  };
}

export const EDITMOD_PROMPTS = {
  /** Sent in a chat that was seeded from the mod by "Edit in chat": the draft is already there. */
  revise: 'add a second data attribute to the notes box',
  /** Sent in a BRAND-NEW chat: the model has to notice the mod in the page list and open it. */
  fromScratch: 'also mark the article as having notes',
  /** Sent after the user detached: the same shape of request, but it must become its own mod. */
  afterDetach: 'now make it say v3-detached instead',
};

const EDITMOD_SCRIPTS = [
  {
    // The seeded chat. The draft block already carries the mod, so no open_mod is needed — the
    // model edits what it was handed, which is the behaviour the draft block's "you are EDITING an
    // installed mod" lines are for.
    name: 'editmod-revise',
    match: /add a second data attribute to the notes box/i,
    steps: [
      {
        text: `${EDITMOD_MARKER} the draft is the installed mod, so I will keep everything it does and add the attribute.`,
        calls: [{ name: 'propose_mod', args: editModProposal(EDITMOD_V2) }],
      },
    ],
  },
  {
    // The brand-new chat. Two steps on purpose: open_mod first (which is the whole point — the
    // model saw the mod in the page list and picked it up rather than writing a second one), then
    // the revision. A one-step script would prove nothing about open_mod.
    name: 'editmod-open',
    match: /also mark the article as having notes/i,
    steps: [
      {
        text: `${EDITMOD_MARKER} there is already a mod for this on the page. Opening it rather than writing a second one.`,
        calls: [{ name: 'open_mod', args: { mod_id: '__EDITMOD_ID__' } }],
      },
      {
        text: `${EDITMOD_MARKER} read it. Adding the attribute and keeping the rest.`,
        calls: [{ name: 'propose_mod', args: editModProposal(EDITMOD_V2B) }],
      },
    ],
  },
  {
    name: 'editmod-detached',
    match: /now make it say v3-detached instead/i,
    steps: [
      {
        text: `${EDITMOD_MARKER} here is that change.`,
        calls: [{ name: 'propose_mod', args: editModProposal(EDITMOD_V3) }],
      },
    ],
  },
];

/**
 * The mod id the `editmod-open` script passes to open_mod.
 *
 * A mod's id is a UUID minted at install time, so the script cannot hold it: the flow installs the
 * mod, reads the id out of storage, and POSTs it here before sending the message that triggers the
 * script. That is honest in the way that matters — the model is still choosing an id it was shown
 * in the page list, and the flow's assertion is that the LIST carried that id at all.
 */
let editModId = '';
export function setEditModId(id) {
  editModId = id;
}

/** Substitute the live mod id into a scripted open_mod call. */
function resolveArgs(args) {
  if (args?.mod_id === '__EDITMOD_ID__') return { ...args, mod_id: editModId };
  return args;
}

SCRIPTS.push(
  WAIT_SCRIPT,
  WAIT_STOP_SCRIPT,
  ...ARTIFACT_SCRIPTS,
  ...EDITMOD_SCRIPTS,
  visionScript('vision-sighted', VISION.sighted),
  visionScript('vision-blind', VISION.blind),
);

/** The fixture page the wait flow drives. Served by this server so the flow needs no live site. */
const ASYNC_FIXTURE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Async fixture</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  /* #fade is in the DOM from the start and is revealed by editing THIS RULE, not the element.
     Nothing about #fade mutates — no node, no attribute, no text — so a MutationObserver sees
     absolutely nothing, however wide its subtree. Only something that re-checks computed style on
     a timer notices. A class flip would NOT test this: classList.add is an attribute mutation and
     the observer catches it. This is the case the polling floor in lib/waitdom.ts exists for. */
  #fade { opacity: 0; visibility: hidden; }
  #churn { min-height: 2rem; }
</style>
</head>
<body>
  <h1 id="ready">Ready</h1>

  <button id="load">Load results</button>
  <ul id="results"></ul>
  <p id="status"></p>

  <div id="fade">Now you see me</div>
  <button id="reveal">Reveal</button>

  <a id="route" href="#">Go to step 2</a>

  <button id="churnstart">Start churn</button>
  <div id="churn"></div>

<script>
  // Results arrive 800ms after the click: long enough that proceeding immediately finds nothing.
  document.getElementById('load').addEventListener('click', () => {
    setTimeout(() => {
      const ul = document.getElementById('results');
      for (let i = 1; i <= 3; i++) {
        const li = document.createElement('li');
        li.className = 'result';
        li.textContent = 'Result ' + i;
        ul.appendChild(li);
      }
      document.getElementById('status').textContent = 'Loaded three results';
    }, 800);
  });

  // A reveal that mutates NOTHING in the DOM: it rewrites the CSSOM rule that hides #fade. The
  // element is untouched, so a MutationObserver is blind to it however it is configured.
  //
  // It also records WHEN it happened, on window. The flow reads that back and checks how long the
  // wait took to notice, because "it matched eventually" is not the property under test — an
  // unrelated mutation elsewhere on the page wakes the observer and makes any reveal look seen.
  // What the polling floor guarantees is that it is noticed PROMPTLY, with nothing else going on.
  window.__revealedAt = null;
  document.getElementById('reveal').addEventListener('click', () => {
    setTimeout(() => {
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText === '#fade') {
            rule.style.opacity = '1';
            rule.style.visibility = 'visible';
          }
        }
      }
      window.__revealedAt = Date.now();
    }, 600);
  });

  // A pushState route change, 300ms after the click. No navigation: the content script survives,
  // and only something watching the tab's URL sees it.
  document.getElementById('route').addEventListener('click', (e) => {
    e.preventDefault();
    setTimeout(() => history.pushState({}, '', '/__fixture/async.html?step=2'), 300);
  });

  // 1.5s of continuous mutation, then silence.
  document.getElementById('churnstart').addEventListener('click', () => {
    const box = document.getElementById('churn');
    const stopAt = Date.now() + 1500;
    const tick = () => {
      box.textContent = 'churning ' + Date.now();
      if (Date.now() < stopAt) setTimeout(tick, 60);
      else box.textContent = 'settled';
    };
    tick();
  });
</script>
</body>
</html>
`;

/** A fallback so an unscripted message still produces something sane instead of hanging. */
const FALLBACK = {
  steps: [{ text: 'This mock server has no script for that message. See scripts/mock-llm.mjs.', calls: [] }],
};

// ---------------------------------------------------------------------------
// Chat titles
// ---------------------------------------------------------------------------
//
// After a turn completes, the background makes one extra call with no tools and the title system
// prompt from lib/title.ts, asking for a short name for the chat. It is answered here with a fixed
// string, deliberately dressed in the quotes and trailing period a real model tends to add, so the
// screenshots flow exercises the panel's sanitiser rather than a pre-cleaned answer.

/** Matches the title system prompt without pinning its exact wording. */
const TITLE_SYSTEM = /you name chat conversations/i;
const TITLE_REPLY = '"Full-width Wikipedia articles."';

// The title the switcher should end up showing once lib/title.ts has stripped the quotes and the
// period: "Full-width Wikipedia articles". screenshots.mjs keeps its own copy of that string rather
// than importing it, because importing this file starts a second server on the same port.

/** A title request: no tools offered, and a system message that reads like the title prompt. */
function isTitleRequest(body) {
  if ((body.tools ?? []).length) return false;
  return (body.messages ?? []).some((m) => m.role === 'system' && TITLE_SYSTEM.test(messageText(m)));
}

// ---------------------------------------------------------------------------
// Compaction summaries
// ---------------------------------------------------------------------------
//
// Tier 2 of lib/agent/compact.ts makes a second tool-free call with its own system prompt, asking
// for a summary of the earlier conversation. It is answered here with a fixed string shaped like a
// real answer — the sections the prompt demands, and a code block — so the browser flow can see
// that the summary reached the history rather than just that a call happened.

const SUMMARY_SYSTEM = /you compress the earlier part of a conversation/i;

export const SUMMARY_MARKER = 'SUMMARYMARKER-4c81';

const SUMMARY_REPLY = [
  `${SUMMARY_MARKER}`,
  'GOALS: the user wants every section heading on this Wikipedia article numbered.',
  'DECISIONS: a CSS counter was rejected because the headings are wrapped in .mw-heading; prepending text in JS works.',
  'SELECTORS: ".mw-heading h2" — stable, verified on this article. "#content" — stable. "h1, h2, h3" — stable.',
  'CURRENT PROPOSAL: none yet.',
  'OPEN PROBLEMS: none.',
  'LATEST REQUEST: trace every heading on this page.',
].join('\n');

/** A compaction-summary request: no tools, and the compaction system prompt. */
function isSummaryRequest(body) {
  if ((body.tools ?? []).length) return false;
  return (body.messages ?? []).some((m) => m.role === 'system' && SUMMARY_SYSTEM.test(messageText(m)));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
//
// A real backend answers an invalid history with a 400 the extension surfaces as a chat error; this
// mock used to answer anything at all, so a dangling tool call or an orphan tool message went
// unnoticed until someone ran the extension against a real provider. Every request is now checked
// against the shape /v1/chat/completions actually requires, and the browser flows assert that the
// server saw zero violations — which is how the pairing invariant stays honest as the loop and the
// compactor rewrite history underneath it.

/** Every structural problem seen, in order. The screenshots flows read this back and fail on it. */
const violations = [];

/**
 * Check one chat-completions body. Returns a list of {kind, detail}; empty means valid.
 *
 * The rules are the ones OpenAI, and every compatible backend, enforce:
 *   - every assistant tool_call id is answered by exactly one following `tool` message;
 *   - every `tool` message answers a tool_call that came before it, and only once;
 *   - the answers to one assistant message are CONTIGUOUS and start immediately after it, with
 *     nothing wedged in between — see the adjacency check below;
 *   - roles are known, and a message that carries tool_calls is an assistant message;
 *   - content is present where the API forbids omitting it (user, system, and a tool reply);
 *   - a `tools` array is present whenever the history contains tool calls, because a model cannot
 *     be asked to continue a conversation whose tools it was never shown.
 */
export function validateChatRequest(body) {
  const out = [];
  const messages = body?.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return [{ kind: 'no-messages', detail: 'request has no messages array' }];
  }

  /** tool_call id -> index of the assistant message that made it. */
  const calls = new Map();
  /** tool_call id -> how many `tool` messages answered it. */
  const answers = new Map();
  let sawToolCall = false;

  out.push(...checkToolAdjacency(messages));

  messages.forEach((m, i) => {
    const where = `messages[${i}]`;
    if (!m || typeof m !== 'object') {
      out.push({ kind: 'bad-message', detail: `${where} is not an object` });
      return;
    }
    if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) {
      out.push({ kind: 'bad-role', detail: `${where} has role ${JSON.stringify(m.role)}` });
      return;
    }
    if (m.tool_calls && m.role !== 'assistant') {
      out.push({ kind: 'tool-calls-on-non-assistant', detail: `${where} is a ${m.role} message carrying tool_calls` });
    }

    if (m.role === 'assistant') {
      for (const c of m.tool_calls ?? []) {
        sawToolCall = true;
        if (!c || typeof c.id !== 'string' || !c.id) {
          out.push({ kind: 'tool-call-no-id', detail: `${where} has a tool_call with no id` });
          continue;
        }
        if (calls.has(c.id)) out.push({ kind: 'duplicate-tool-call-id', detail: `tool_call id ${c.id} appears twice (${where})` });
        calls.set(c.id, i);
        if (!c.function || typeof c.function.name !== 'string' || !c.function.name) {
          out.push({ kind: 'tool-call-no-name', detail: `${where} tool_call ${c.id} has no function name` });
        }
        if (typeof c.function?.arguments !== 'string') {
          out.push({ kind: 'tool-call-bad-arguments', detail: `${where} tool_call ${c.id} arguments is not a string` });
        }
      }
      // An assistant message may have null content, but only when it is making a tool call.
      if (!(m.tool_calls ?? []).length && !hasContent(m.content)) {
        out.push({ kind: 'empty-assistant', detail: `${where} is an assistant message with neither content nor tool_calls` });
      }
      return;
    }

    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) {
        out.push({ kind: 'tool-message-no-id', detail: `${where} is a tool message with no tool_call_id` });
        return;
      }
      if (!calls.has(m.tool_call_id)) {
        out.push({ kind: 'orphan-tool-message', detail: `${where} answers tool_call ${m.tool_call_id}, which no earlier assistant message made` });
      }
      answers.set(m.tool_call_id, (answers.get(m.tool_call_id) ?? 0) + 1);
      if (!hasContent(m.content)) out.push({ kind: 'empty-tool-content', detail: `${where} (tool ${m.tool_call_id}) has empty content` });
      return;
    }

    // system / user
    if (!hasContent(m.content)) out.push({ kind: 'empty-content', detail: `${where} is a ${m.role} message with empty content` });
  });

  for (const [id, at] of calls) {
    const n = answers.get(id) ?? 0;
    if (n === 0) out.push({ kind: 'unanswered-tool-call', detail: `tool_call ${id} (messages[${at}]) was never answered by a tool message` });
    else if (n > 1) out.push({ kind: 'duplicate-tool-answer', detail: `tool_call ${id} was answered by ${n} tool messages` });
  }

  if (sawToolCall && !(body.tools ?? []).length) {
    out.push({ kind: 'no-tools-array', detail: 'the history contains tool calls but the request offered no tools' });
  }

  out.push(...collectImages(messages).problems);

  return out;
}

/**
 * The rule that makes "one user message after the tool messages" legal and "one user message
 * between them" a 400.
 *
 * An assistant message carrying N tool_calls must be followed IMMEDIATELY by exactly those N `tool`
 * messages, one after another, with nothing in between. What comes after the last of them is free —
 * which is what lets lib/providers/openai.ts put a screenshot in a user message there, the same way
 * the Responses adapter does, since a `tool` message cannot hold an image itself.
 *
 * This is checked separately from the pairing rules above because it is about POSITION, and the
 * pairing pass only knows about ids. Before the image change nothing in the extension could produce
 * a message between an assistant's calls and their answers, so the gap never mattered; now that a
 * user message is deliberately emitted nearby, the mock has to be able to tell the two apart.
 */
function checkToolAdjacency(messages) {
  const out = [];
  messages.forEach((m, i) => {
    const wanted = m?.role === 'assistant' ? (m.tool_calls ?? []).length : 0;
    if (!wanted) return;
    for (let k = 0; k < wanted; k++) {
      const next = messages[i + 1 + k];
      if (!next) {
        out.push({
          kind: 'tool-answers-truncated',
          detail: `messages[${i}] made ${wanted} tool_calls but the history ends after ${k} tool message(s)`,
        });
        return;
      }
      if (next.role !== 'tool') {
        out.push({
          kind: 'tool-answers-not-adjacent',
          detail: `messages[${i}] made ${wanted} tool_calls, but messages[${i + 1 + k}] is a ${next.role} message — every answer must follow immediately, with nothing in between`,
        });
        return;
      }
    }
    // …and the run of tool messages must STOP there: an extra one answers a call from somewhere
    // else, which the pairing pass reports separately but which is also a position error.
    const after = messages[i + 1 + wanted];
    if (after?.role === 'tool') {
      out.push({
        kind: 'tool-answers-overrun',
        detail: `messages[${i}] made ${wanted} tool_calls but messages[${i + 1 + wanted}] is another tool message`,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Attached images
// ---------------------------------------------------------------------------
//
// A vision backend takes an `image_url` content part whose url is a data URL. Nothing about that
// is enforced by the transport, so an extension that sent a truncated base64 string, a media type
// no model accepts, or a 40 MB original would look fine here and fail against a real provider —
// which is the whole class of bug this mock exists to catch. Every image part is checked and
// recorded.

/** Media types a vision endpoint will take. Anything else is a violation, not a preference. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Refuse anything an endpoint would: this is comfortably above a 1568px JPEG at q0.85. */
const MAX_IMAGE_BYTES = 4_000_000;

/**
 * Describe and check one image_url part.
 *
 * Returns {info, problems}: `info` is what /__requests records, `problems` are violations. A part
 * that is not a data URL at all, whose base64 does not decode, or whose decoded bytes do not start
 * with the magic number its media type promises, is a violation — those are precisely the failures
 * that a permissive mock would swallow.
 */
export function inspectImagePart(part, where) {
  const problems = [];
  const url = part?.image_url?.url;
  if (typeof url !== 'string' || !url) {
    problems.push({ kind: 'image-no-url', detail: `${where} is an image_url part with no url` });
    return { info: null, problems };
  }
  const m = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(url);
  if (!m) {
    problems.push({ kind: 'image-not-data-url', detail: `${where} image url is not a base64 data URL (starts ${JSON.stringify(url.slice(0, 32))})` });
    return { info: null, problems };
  }
  const mediaType = m[1].toLowerCase();
  const b64 = m[2];
  if (!IMAGE_TYPES.has(mediaType)) {
    problems.push({ kind: 'image-bad-media-type', detail: `${where} image media type is ${mediaType}` });
  }
  let bytes = null;
  let dimensions = null;
  if (!b64) {
    problems.push({ kind: 'image-empty', detail: `${where} image data URL carries no base64 payload` });
  } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    problems.push({ kind: 'image-bad-base64', detail: `${where} image payload is not valid base64` });
  } else {
    let buf = null;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      buf = null;
    }
    if (!buf || !buf.length) {
      problems.push({ kind: 'image-bad-base64', detail: `${where} image payload did not decode` });
    } else {
      bytes = buf.length;
      if (bytes > MAX_IMAGE_BYTES) {
        problems.push({ kind: 'image-too-large', detail: `${where} image is ${bytes} bytes, over ${MAX_IMAGE_BYTES}` });
      }
      if (!magicMatches(buf, mediaType)) {
        problems.push({ kind: 'image-corrupt', detail: `${where} image bytes do not look like ${mediaType}` });
      }
      dimensions = readDimensions(buf, mediaType);
    }
  }
  return { info: { mediaType, bytes, ...(dimensions ?? {}) }, problems };
}

/** Does the decoded payload begin the way its declared type must? Catches truncation and mislabels. */
function magicMatches(buf, mediaType) {
  if (mediaType === 'image/png') return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mediaType === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  if (mediaType === 'image/gif') return buf.length > 6 && buf.toString('latin1', 0, 3) === 'GIF';
  if (mediaType === 'image/webp') return buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  return true; // an unknown type is already a violation above; do not report it twice
}

/**
 * Width and height where the header makes them cheap to read.
 *
 * PNG and JPEG are enough for what the flows assert — the extension re-encodes every attachment to
 * one of those two — and a format we cannot measure simply records no dimensions rather than
 * pulling in an image library.
 */
function readDimensions(buf, mediaType) {
  try {
    if (mediaType === 'image/png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mediaType === 'image/jpeg') {
      // Walk the segment chain to the first SOF marker, which is where the size lives.
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        // SOF0-SOF15, minus the four that are not frame headers (DHT, JPG, DAC, RST).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {
    /* a header we cannot read is not a violation; it just records no dimensions */
  }
  return null;
}

/**
 * Every image in one request, in order, with the index of the message it came from and whether it
 * sat before the text part of that message. The images flow asserts on both: the extension must
 * put the picture first, because that is the order the providers document.
 */
/**
 * The messages as /__requests stores them: identical, except that an image_url part keeps only a
 * short marker in place of its base64.
 *
 * Without this a single flow's log is tens of megabytes of duplicated base64 — every request
 * resends every earlier image — and the GET that reads it back stalls. Everything the flows assert
 * about an image is in the `images` summary beside it, so nothing is lost.
 */
export function stripImageData(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m?.content) || !m.content.some((p) => p?.type === 'image_url')) return m;
    return {
      ...m,
      content: m.content.map((p) =>
        p?.type === 'image_url' && typeof p.image_url?.url === 'string'
          ? { ...p, image_url: { ...p.image_url, url: `${p.image_url.url.slice(0, p.image_url.url.indexOf(',') + 1)}<${p.image_url.url.length} chars>` } }
          : p,
      ),
    };
  });
}

export function collectImages(messages) {
  const out = [];
  const problems = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m?.content)) return;
    const firstText = m.content.findIndex((p) => p?.type === 'text');
    m.content.forEach((p, j) => {
      if (p?.type !== 'image_url') return;
      const { info, problems: bad } = inspectImagePart(p, `messages[${i}].content[${j}]`);
      problems.push(...bad);
      if (info) out.push({ message: i, part: j, role: m.role, beforeText: firstText === -1 || j < firstText, ...info });
    });
  });
  return { images: out, problems };
}

/** Content the API will accept: a non-empty string, or a non-empty array of parts. */
function hasContent(content) {
  if (typeof content === 'string') return content.length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Concatenate a chat-completions message's content into plain text. */
function messageText(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  return '';
}

/**
 * Which script this request belongs to.
 *
 * The LAST user message that matches a script wins, not the first. A multi-turn conversation (the
 * compaction flow) sends a different message each turn, and each one has its own script; matching
 * on the first user message would replay turn 1 forever. Single-turn scripts are unaffected,
 * because their only matching message is also the last one.
 *
 * A user message carrying tool results is skipped: only a real turn can start a script.
 */
function pickScript(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text = messageText(m);
    const hit = SCRIPTS.find((s) => s.match.test(text));
    if (hit) return { script: hit, from: i };
  }
  return { script: FALLBACK, from: 0 };
}

/**
 * The step index is how many assistant turns have happened SINCE this script's own user message.
 * Counting from the start of the history would make a later turn resume at the end of an earlier
 * script's step list.
 */
function stepFor(script, messages, from = 0) {
  const turns = messages.slice(from).filter((m) => m.role === 'assistant').length;
  return script.steps[Math.min(turns, script.steps.length - 1)];
}

/**
 * Every chat-completions body this server has been handed, in order. The isolation flow reads this
 * back over GET /__requests to prove the two conversations never saw each other's text — a leak
 * that the transcripts alone could hide, because injecting B's message into A's model history is
 * invisible on screen until the model answers the wrong question.
 */
const requests = [];

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------
//
// A mock that always answers cannot test what happens when the network does not. A test posts a
// PLAN: an ordered list of faults. Each chat-completions request (title and summary calls included;
// an outage does not care what the request was for) consults the first fault in the plan that still
// has something left:
//
//   {kind: 'drop', afterChunks: 4, times: 1}     answer 200, stream that many chunks, then kill the
//                                                socket: a connection lost mid-reply.
//   {kind: 'status', status: 503, retryAfter: 1, times: 2}
//                                                answer with that status (and Retry-After, seconds).
//   {kind: 'refuse'}                             kill the socket before answering: what a refused
//                                                connection or no route looks like to fetch().
//   {kind: 'no-vision'}                          answer 400 the way a text-only model does, but
//                                                ONLY when the request actually carried an image
//                                                part; a request without one is let through
//                                                untouched. That is how a real text-only backend
//                                                behaves, and it is what makes the Auto fallback
//                                                testable: the first request is refused, the
//                                                extension re-sends without the picture, and the
//                                                same standing fault lets that one through.
//                                                Defaults to "until cleared".
//
// `times` defaults to 1 for drop and status and to "until cleared" for refuse. `skip: N` lets the
// first N requests through untouched before the fault starts, which is how a flow lets a run make
// real progress and THEN takes the network away. `script` limits a fault to one scripted
// conversation by name. DELETE /__faults is the network coming back.
//
// A faulted request is still validated and still recorded in /__requests (with `fault` set), so a
// flow can count the attempts the extension made.

/** The plan, mutated in place as it is used up. */
let faults = [];

function parseFaults(plan) {
  if (!Array.isArray(plan)) return [];
  return plan
    .filter((f) => f && ['drop', 'status', 'refuse', 'no-vision'].includes(f.kind))
    .map((f) => ({
      kind: f.kind,
      times: Number.isFinite(f.times) ? f.times : f.kind === 'refuse' || f.kind === 'no-vision' ? Infinity : 1,
      skip: Number.isFinite(f.skip) ? f.skip : 0,
      afterChunks: Number.isFinite(f.afterChunks) ? f.afterChunks : 3,
      status: Number.isFinite(f.status) ? f.status : 503,
      ...(f.retryAfter !== undefined ? { retryAfter: f.retryAfter } : {}),
      ...(typeof f.script === 'string' ? { script: f.script } : {}),
    }));
}

/**
 * The fault this request should suffer, if any, consuming it from the plan.
 *
 * `carriesImages` is what makes a 'no-vision' fault behave like a real text-only backend rather
 * than like a broken one: such a server answers 400 to a request with a picture in it and answers
 * normally to the same request without, which is precisely the pair the Auto fallback needs to see.
 * A 'no-vision' fault therefore does NOT consume a turn on an image-free request; it simply does
 * not apply, and the next fault in the plan (if any) is considered instead.
 */
function takeFault(scriptName, carriesImages = false) {
  for (const f of faults) {
    if (f.times <= 0) continue;
    if (f.script && f.script !== scriptName) continue;
    if (f.kind === 'no-vision' && !carriesImages) continue;
    if (f.skip > 0) {
      f.skip -= 1;
      return null;
    }
    f.times -= 1;
    return f;
  }
  return null;
}

/**
 * The 400 a text-only model answers an image with. Modelled on what these actually say — the
 * extension's classifier (lib/providers/vision.ts) has to recognise real wording, not a phrase
 * invented here to match it.
 */
const NO_VISION_BODY = { error: { message: 'Invalid content type. image_url is only supported by certain models.', type: 'invalid_request_error', code: 'unsupported_content' } };

/** Thrown inside streamStep to stop writing once the socket has been killed on purpose. */
const DROPPED = Symbol('dropped');

/** Stream one scripted step as chat-completion chunks, the way a real backend would. */
async function streamStep(res, step, model, { slowFirstByte = false, dropAfterChunks = null } = {}) {
  const id = `chatcmpl-mock-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  let sent = 0;
  const chunk = (delta, finish_reason = null) => {
    // The injected mid-stream drop: the reply is cut off with no finish_reason and no [DONE], by
    // destroying the socket rather than ending the response, so the client sees a broken
    // connection and not a short but well-formed reply.
    if (dropAfterChunks !== null && sent >= dropAfterChunks) {
      res.destroy();
      throw DROPPED;
    }
    sent += 1;
    sse(res, { ...base, choices: [{ index: 0, delta, finish_reason }] });
  };

  // A slow conversation holds its first byte, so the run is demonstrably still in flight while the
  // test switches tabs and starts the other chat.
  if (slowFirstByte) await sleep(FIRST_BYTE_MS);
  // A step may hold the stream open before saying anything, the way a model that thinks first does.
  // Nothing has been written yet at this point, so the panel is genuinely waiting on a first byte.
  if (step.firstByteDelay) await sleep(step.firstByteDelay);

  chunk({ role: 'assistant' });

  // Text goes out in small pieces so the panel visibly streams, as it does with a real model.
  for (const piece of (step.text ?? '').match(/\S+\s*/g) ?? []) {
    chunk({ content: piece });
    await sleep(12);
  }

  const calls = step.calls ?? [];
  calls.forEach((call, index) => {
    // resolveArgs substitutes anything the script could not know at authoring time — today only the
    // edit-a-mod flow's live mod id, which is a UUID minted at install.
    const args = JSON.stringify(resolveArgs(call.args ?? {}));
    // The adapter accumulates name and arguments across deltas, so split them to exercise that.
    chunk({ tool_calls: [{ index, id: `call_${index}_${Date.now()}`, type: 'function', function: { name: call.name, arguments: '' } }] });
    for (const part of chunkString(args, 96)) {
      chunk({ tool_calls: [{ index, function: { arguments: part } }] });
    }
  });

  chunk({}, calls.length ? 'tool_calls' : 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

function chunkString(s, size) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

/**
 * Validate a body and log anything wrong with it, tagged with the script it belongs to so a failure
 * message says which conversation produced it.
 */
function recordViolations(body, messages) {
  const problems = validateChatRequest(body);
  if (!problems.length) return;
  const script = isSummaryRequest(body) ? 'summary' : isTitleRequest(body) ? 'title' : (pickScript(messages).script.name ?? 'fallback');
  for (const p of problems) {
    violations.push({ at: Date.now(), script, kind: p.kind, detail: p.detail });
    console.error(`[mock-llm] INVALID REQUEST (${script}): ${p.kind} — ${p.detail}`);
  }
}

const server = http.createServer(async (req, res) => {
  // The extension calls this from a page origin, so CORS has to be permissive.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // Every request that was structurally invalid. The browser flows assert this is empty.
  if (url.pathname === '/__violations') {
    if (req.method === 'DELETE') {
      violations.length = 0;
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ violations }));
    return;
  }

  // The fault plan: see "Fault injection".
  if (url.pathname === '/__faults') {
    if (req.method === 'DELETE') {
      faults = [];
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST') {
      try {
        faults = parseFaults(JSON.parse(await readBody(req)).plan);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad fault plan' } }));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    // Infinity does not survive JSON, so an open-ended fault reports times: null.
    res.end(JSON.stringify({ plan: faults.map((f) => ({ ...f, times: Number.isFinite(f.times) ? f.times : null })) }));
    return;
  }

  /**
   * The live mod id the edit-a-mod flow's `open_mod` call should carry.
   *
   * A mod's id is a UUID minted at install, so a static script cannot hold one. The flow installs
   * the mod, reads the id out of chrome.storage, and POSTs it here before sending the message that
   * runs the script. Nothing else in the mock needs this, which is why it is one endpoint and one
   * variable rather than a general templating mechanism.
   */
  if (url.pathname === '/__editmod') {
    if (req.method === 'POST') {
      try {
        setEditModId(String(JSON.parse(await readBody(req)).modId ?? ''));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad mod id' } }));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ modId: editModId }));
    return;
  }

  // The recorded request log, for the isolation flow's cross-conversation assertions.
  if (url.pathname === '/__requests') {
    if (req.method === 'DELETE') {
      requests.length = 0;
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requests }));
    return;
  }

  // A library for the dashboard flow's @require assertion: it needs a real, fetchable dependency to
  // prove that editing a mod's header to add an @require actually fetches and stores the body.
  // The query string decides what the library defines, so one route serves two different versions.
  if (url.pathname === '/__require.js') {
    const name = url.searchParams.get('name') ?? 'usermodsTestLib';
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`window.${name} = () => ${JSON.stringify(name)};\n`);
    return;
  }

  // The wait flow's fixture page: content that arrives late, a class-only reveal, a pushState
  // route change and a region that mutates then settles. Served from here so the flow does not
  // depend on a live site behaving asynchronously on cue. The query string is ignored — the SPA
  // route change pushes ?step=2 onto this same path, and the page must still render there.
  if (url.pathname === '/__fixture/async.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(ASYNC_FIXTURE);
    return;
  }

  /**
   * The @require library the edit-a-mod flow's fixture userscript loads.
   *
   * It is served rather than pointed at a dead URL because installing a userscript FETCHES its
   * dependencies — a @require that will not load is an install failure, by design. Serving a real
   * one also makes the round-trip assertion stronger: the flow can check that the fetched body is
   * still attached to the mod after an edit, not merely that the @require line survived.
   */
  if (url.pathname === '/__fixture/kingfisher-lib.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end('window.__kingfisherLib = { version: 1 };\n');
    return;
  }

  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'demo' }, { id: 'demo-mini' }] }));
    return;
  }

  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad json' } }));
      return;
    }
    const messages = body.messages ?? [];
    // Validate BEFORE answering, and answer anyway: a mock that refuses an invalid history would
    // stall the flow at the first breakage and hide every later one. The flows read /__violations
    // at the end and fail there, with the whole list.
    recordViolations(body, messages);

    // Fault injection, decided before anything is written. The request is recorded either way.
    const kind = isSummaryRequest(body) ? 'summary' : isTitleRequest(body) ? 'title' : (pickScript(messages).script.name ?? 'fallback');
    // Collected once and reused: the fault decision needs to know whether a picture is on the wire,
    // and every recorded request carries the same summary so a flow can count what was sent.
    const collected = collectImages(messages);
    const fault = takeFault(kind, collected.images.length > 0);
    if (fault && fault.kind !== 'drop') {
      requests.push({
        at: Date.now(),
        script: kind,
        fault: fault.kind,
        messages: stripImageData(messages),
        images: collected.images,
        hasImages: collected.images.length > 0,
      });
      if (process.env.MOCK_LLM_VERBOSE) console.error(`[mock-llm] FAULT ${fault.kind} on ${kind} (${collected.images.length} image parts)`);
      if (fault.kind === 'refuse') {
        req.socket.destroy();
        return;
      }
      if (fault.kind === 'no-vision') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(NO_VISION_BODY));
        return;
      }
      res.writeHead(fault.status, {
        'content-type': 'application/json',
        ...(fault.retryAfter !== undefined ? { 'retry-after': String(fault.retryAfter), 'access-control-expose-headers': 'retry-after' } : {}),
      });
      res.end(JSON.stringify({ error: { message: `injected ${fault.status}`, type: 'server_error' } }));
      return;
    }
    const dropAfterChunks = fault ? fault.afterChunks : null;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // The title call is a one-shot, tool-free request; it never takes a step out of a script. It
    // is still recorded, because the isolation flow's "no chat's text entered another chat's model
    // conversation" assertion has to hold for the title call too.
    if (isSummaryRequest(body)) {
      requests.push({ at: Date.now(), script: 'summary', messages: stripImageData(messages), images: collected.images, hasImages: collected.images.length > 0 });
      if (process.env.MOCK_LLM_VERBOSE) console.error('[mock-llm] compaction summary');
      await streamStep(res, { text: SUMMARY_REPLY, calls: [] }, body.model ?? 'demo');
      return;
    }
    if (isTitleRequest(body)) {
      requests.push({ at: Date.now(), script: 'title', messages: stripImageData(messages), images: collected.images, hasImages: collected.images.length > 0 });
      if (process.env.MOCK_LLM_VERBOSE) console.error(`[mock-llm] title -> ${TITLE_REPLY}`);
      await streamStep(res, { text: TITLE_REPLY, calls: [] }, body.model ?? 'demo');
      return;
    }
    const { script, from } = pickScript(messages);
    const step = stepFor(script, messages, from);
    // Recorded before anything is streamed, so a hung run still leaves its evidence behind. The
    // images are summarised rather than copied: the flow needs their count, type, size, dimensions
    // and position, and a megabyte of base64 per request would make /__requests unusable.
    requests.push({
      at: Date.now(),
      script: script.name ?? 'fallback',
      ...(fault ? { fault: fault.kind } : {}),
      messages: stripImageData(messages),
      images: collected.images,
      // A plain boolean beside the detail, so a flow can assert "this request carried no picture"
      // without reasoning about an empty array it might have failed to collect.
      hasImages: collected.images.length > 0,
    });
    if (process.env.MOCK_LLM_VERBOSE) {
      console.error(`[mock-llm] ${script.name ?? 'fallback'} step ${script.steps.indexOf(step)}: ${(step.calls ?? []).map((c) => c.name).join(', ') || 'text only'}`);
    }
    try {
      await streamStep(res, step, body.model ?? 'demo', { slowFirstByte: !!script.slowFirstByte, dropAfterChunks });
    } catch (e) {
      if (e !== DROPPED) throw e;
      if (process.env.MOCK_LLM_VERBOSE) console.error(`[mock-llm] FAULT drop on ${script.name ?? 'fallback'}`);
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
});

// Only listen when this file is the program. screenshots.mjs imports it for SLOW_MARKER and
// FAST_MARKER — the markers must be defined in exactly one place, or the assertions could drift
// away from what the server actually streams — and an import must not bind a port.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.MOCK_LLM_PORT ?? process.argv[2] ?? 8791);
  server.listen(port, '127.0.0.1', () => {
    // screenshots.mjs waits for this line before launching the browser.
    console.log(`mock-llm listening on http://127.0.0.1:${port}/v1`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
