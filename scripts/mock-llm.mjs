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

import http from 'node:http';

// ---------------------------------------------------------------------------
// Scripted conversations
// ---------------------------------------------------------------------------

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
];

/** A fallback so an unscripted message still produces something sane instead of hanging. */
const FALLBACK = {
  steps: [{ text: 'This mock server has no script for that message. See scripts/mock-llm.mjs.', calls: [] }],
};

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

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** Stream one scripted step as chat-completion chunks, the way a real backend would. */
async function streamStep(res, step, model) {
  const id = `chatcmpl-mock-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const chunk = (delta, finish_reason = null) => sse(res, { ...base, choices: [{ index: 0, delta, finish_reason }] });

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
    const script = pickScript(messages);
    const step = stepFor(script, messages);
    if (process.env.MOCK_LLM_VERBOSE) {
      console.log(`[mock-llm] ${script.name ?? 'fallback'} step ${script.steps.indexOf(step)}: ${(step.calls ?? []).map((c) => c.name).join(', ') || 'text only'}`);
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    await streamStep(res, step, body.model ?? 'demo');
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
});

const port = Number(process.env.MOCK_LLM_PORT ?? process.argv[2] ?? 8791);
server.listen(port, '127.0.0.1', () => {
  // screenshots.mjs waits for this line before launching the browser.
  console.log(`mock-llm listening on http://127.0.0.1:${port}/v1`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
