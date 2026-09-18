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
//   GET  /__requests           -> {requests: [{at, script, messages}, ...]}  every body received,
//        DELETE /__requests    in order; the isolation flow reads this back to prove that one
//                              chat's user text never entered another chat's model conversation.
//                              DELETE empties the log.
//   GET  /__violations        -> {violations: [{at, kind, detail, script}, ...]}  every request
//        DELETE /__violations  that was structurally invalid. See "Validation" below.
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

  return out;
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

/** Stream one scripted step as chat-completion chunks, the way a real backend would. */
async function streamStep(res, step, model, { slowFirstByte = false } = {}) {
  const id = `chatcmpl-mock-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const chunk = (delta, finish_reason = null) => sse(res, { ...base, choices: [{ index: 0, delta, finish_reason }] });

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
    const args = JSON.stringify(call.args ?? {});
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
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
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
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // The title call is a one-shot, tool-free request; it never takes a step out of a script. It
    // is still recorded, because the isolation flow's "no chat's text entered another chat's model
    // conversation" assertion has to hold for the title call too.
    if (isSummaryRequest(body)) {
      requests.push({ at: Date.now(), script: 'summary', messages });
      if (process.env.MOCK_LLM_VERBOSE) console.error('[mock-llm] compaction summary');
      await streamStep(res, { text: SUMMARY_REPLY, calls: [] }, body.model ?? 'demo');
      return;
    }
    if (isTitleRequest(body)) {
      requests.push({ at: Date.now(), script: 'title', messages });
      if (process.env.MOCK_LLM_VERBOSE) console.error(`[mock-llm] title -> ${TITLE_REPLY}`);
      await streamStep(res, { text: TITLE_REPLY, calls: [] }, body.model ?? 'demo');
      return;
    }
    const { script, from } = pickScript(messages);
    const step = stepFor(script, messages, from);
    // Recorded before anything is streamed, so a hung run still leaves its evidence behind.
    requests.push({ at: Date.now(), script: script.name ?? 'fallback', messages });
    if (process.env.MOCK_LLM_VERBOSE) {
      console.error(`[mock-llm] ${script.name ?? 'fallback'} step ${script.steps.indexOf(step)}: ${(step.calls ?? []).map((c) => c.name).join(', ') || 'text only'}`);
    }
    await streamStep(res, step, body.model ?? 'demo', { slowFirstByte: !!script.slowFirstByte });
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
