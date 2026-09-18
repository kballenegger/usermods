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
// A consequence, since propose_mod started refusing untested scripts: every script here proposes
// with `untested_reason`, because in this profile a mod genuinely cannot be run first. That is the
// honest state and the proposal card says so. It is also the only reason the captured screenshots
// carry a "not tested on this page" line; a real session with the user-scripts toggle on runs the
// script and shows no such line.

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
// Protocol
// ---------------------------------------------------------------------------

/** Concatenate a chat-completions message's content into plain text. */
function messageText(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  return '';
}

function pickScript(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  const text = firstUser ? messageText(firstUser) : '';
  return SCRIPTS.find((s) => s.match.test(text)) ?? FALLBACK;
}

/** The step index is how many assistant turns have already happened in this conversation. */
function stepFor(script, messages) {
  const turns = messages.filter((m) => m.role === 'assistant').length;
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
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // The title call is a one-shot, tool-free request; it never takes a step out of a script. It
    // is still recorded, because the isolation flow's "no chat's text entered another chat's model
    // conversation" assertion has to hold for the title call too.
    if (isTitleRequest(body)) {
      requests.push({ at: Date.now(), script: 'title', messages });
      if (process.env.MOCK_LLM_VERBOSE) console.log(`[mock-llm] title -> ${TITLE_REPLY}`);
      await streamStep(res, { text: TITLE_REPLY, calls: [] }, body.model ?? 'demo');
      return;
    }
    const script = pickScript(messages);
    const step = stepFor(script, messages);
    // Recorded before anything is streamed, so a hung run still leaves its evidence behind.
    requests.push({ at: Date.now(), script: script.name ?? 'fallback', messages });
    if (process.env.MOCK_LLM_VERBOSE) {
      console.log(`[mock-llm] ${script.name ?? 'fallback'} step ${script.steps.indexOf(step)}: ${(step.calls ?? []).map((c) => c.name).join(', ') || 'text only'}`);
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
