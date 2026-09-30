// The agent loop's budgets and propose_mod's static checks.
//
// Both answer a complaint about how the agent behaves rather than a crash: the model made a dozen
// inspection calls before acting, and the turn could end with no proposal and no explanation. The
// fixes are counters and messages, so testing them means asserting exact wording — if a nudge's
// text drifts, the scripted mock in scripts/mock-llm.mjs stops matching it too.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FULL_READ_CHARS,
  MAX_ITERATIONS,
  MIN_READ_COST,
  NO_READS,
  READ_BUDGET,
  countReads,
  readBudgetNudge,
  readCost,
  wrapUpNudge,
  type ReadCall,
  type ReadTally,
} from '../lib/agent/budget.ts';
import { askedForEverySite, checkProposal, type ProposalContext } from '../lib/agent/propose.ts';
import { durabilityLabel, durabilityOf, isGeneratedClass } from '../lib/snapshot.ts';

// ---------- the step cap ----------

test('the cap stays at 30 — the failure mode here is too many steps, not too few', () => {
  assert.equal(MAX_ITERATIONS, 30);
});

test('the wrap-up nudge fires once, with 5 steps left', () => {
  // i is 0-based, so remaining = 30 - i - 1. Five remain at i = 24.
  assert.equal(wrapUpNudge(23), null);
  assert.equal(wrapUpNudge(25), null);
  assert.equal(wrapUpNudge(29), null);
  const nudge = wrapUpNudge(24);
  assert.equal(
    nudge,
    '[5 steps left in this turn. Do not start new investigation. Finish: propose the mod, report the result, or say what is blocking you.]',
  );
});

test('the wrap-up nudge follows a smaller cap, so the two numbers cannot drift apart', () => {
  assert.equal(wrapUpNudge(4, 10), '[5 steps left in this turn. Do not start new investigation. Finish: propose the mod, report the result, or say what is blocking you.]');
  assert.equal(wrapUpNudge(5, 10), null);
});

// ---------- the read budget ----------

const T = (units: number, calls = Math.ceil(units)): ReadTally => ({ units, calls });

test('reads accumulate across iterations', () => {
  let n = NO_READS;
  n = countReads(n, ['get_page']);
  assert.deepEqual(n, { units: 1, calls: 1 });
  n = countReads(n, ['find_elements', 'get_styles']);
  assert.deepEqual(n, { units: 3, calls: 3 });
  n = countReads(n, ['screenshot']);
  assert.deepEqual(n, { units: 4, calls: 4 });
});

test('running or proposing resets the count', () => {
  assert.deepEqual(countReads(T(9), ['run_script']), NO_READS);
  assert.deepEqual(countReads(T(9), ['propose_mod']), NO_READS);
  // Even when the batch also contains reads: looking at the result of a run is the right move.
  assert.deepEqual(countReads(T(9), ['run_script', 'find_elements']), NO_READS);
});

test('an unknown tool is neither a read nor an act', () => {
  assert.deepEqual(countReads(T(2), ['something_else']), T(2));
});

test('the nudge fires when the count first passes the budget, and names the count', () => {
  assert.equal(READ_BUDGET, 3);
  assert.equal(readBudgetNudge(T(1), T(0)), null);
  assert.equal(readBudgetNudge(T(3), T(2)), null);
  assert.equal(
    readBudgetNudge(T(4), T(3)),
    '[You have made 4 page reads without running or proposing anything. Stop reading: answer the user if you already can, try the change with run_script or test_mod if one is wanted, or ask the user one question.]',
  );
});

test('the nudge does not repeat itself on every later step', () => {
  assert.equal(readBudgetNudge(T(5), T(4)), null);
  assert.equal(readBudgetNudge(T(9), T(8)), null);
});

test('after an act resets the count, the nudge can fire again', () => {
  // Walk a whole turn: four reads (nudged), a run_script (reset), four more reads (nudged again).
  let reads = NO_READS;
  const fired: number[] = [];
  const step = (names: string[]) => {
    const before = reads;
    reads = countReads(reads, names);
    if (readBudgetNudge(reads, before)) fired.push(reads.calls);
  };
  for (let i = 0; i < 4; i++) step(['get_page']);
  step(['run_script']);
  for (let i = 0; i < 4; i++) step(['find_elements']);
  assert.deepEqual(fired, [4, 4]);
});

// ---------- the read budget charges by size ----------

test('a read costs its size over FULL_READ_CHARS, between a quarter and one whole read', () => {
  assert.equal(FULL_READ_CHARS, 6000);
  assert.equal(MIN_READ_COST, 0.25);
  assert.equal(readCost({ name: 'get_page', chars: 18_000 }), 1, 'a long read is one read, not three');
  assert.equal(readCost({ name: 'get_page', chars: 6000 }), 1);
  assert.equal(readCost({ name: 'get_page', chars: 3000 }), 0.5);
  assert.equal(readCost({ name: 'find_elements', chars: 400 }), 0.25, 'a round trip is never free');
  assert.equal(readCost({ name: 'screenshot', chars: 0, image: true }), 1);
  assert.equal(readCost('get_styles'), 1, 'an unknown size is charged as a whole read');
  assert.equal(readCost({ name: 'run_script', chars: 9000 }), 0);
  assert.equal(readCost({ name: 'wait_for', chars: 9000 }), 0);
});

test('small lookups do not push the model to stop reading, but full get_page calls still do', () => {
  // The audit's case: one page read, then a handful of cheap checks. No nudge.
  let reads = countReads(NO_READS, [{ name: 'get_page', chars: 15_000 }]);
  const walk = (calls: ReadCall[]) => {
    const before = reads;
    reads = countReads(reads, calls);
    return readBudgetNudge(reads, before);
  };
  for (let i = 0; i < 6; i++) assert.equal(walk([{ name: 'find_elements', chars: 500 }]), null, `lookup ${i + 1}`);
  assert.equal(walk([{ name: 'get_styles', chars: 300 }]), null);
  assert.equal(reads.calls, 8);
  assert.equal(reads.units, 2.75);

  // Four full get_page calls in a row are nudged on the fourth, exactly as the count used to.
  reads = NO_READS;
  const fired: number[] = [];
  for (let i = 0; i < 4; i++) if (walk([{ name: 'get_page', chars: 20_000 }])) fired.push(reads.calls);
  assert.deepEqual(fired, [4]);
});

test('a dozen small lookups with nothing acted on still earn the nudge', () => {
  let reads = NO_READS;
  let firedAt = 0;
  for (let i = 1; i <= 20 && !firedAt; i++) {
    const before = reads;
    reads = countReads(reads, [{ name: 'find_elements', chars: 200 }]);
    if (readBudgetNudge(reads, before)) firedAt = i;
  }
  assert.equal(firedAt, 13);
});

// ---------- propose_mod's checks ----------

const tested: ProposalContext = { testedSinceProposal: true, userText: 'hide the cookie banner' };
const untested: ProposalContext = { testedSinceProposal: false, userText: 'hide the cookie banner' };
const good = { code: 'document.querySelector(".banner")?.remove();', matches: ['*://*.example.com/*'] };

test('a tested, parseable, narrow proposal is accepted', () => {
  assert.equal(checkProposal(good, tested), null);
});

test('proposing without running anything is refused, and says what to do', () => {
  const msg = checkProposal(good, untested);
  assert.match(msg ?? '', /^Test the script with test_mod before proposing it,/);
  assert.match(msg ?? '', /untested_reason/);
});

test('untested_reason bypasses the test check and only the test check', () => {
  assert.equal(checkProposal({ ...good, untestedReason: 'the page redirects on load' }, untested), null);
  // It does not excuse code that cannot parse.
  const msg = checkProposal({ code: 'const a = ;', matches: good.matches, untestedReason: 'why not' }, untested);
  assert.match(msg ?? '', /does not parse/);
});

test('code that does not parse is refused with the position, not silently proposed', () => {
  const msg = checkProposal({ code: 'document.querySelector(".x"\n.remove();', matches: good.matches }, tested);
  assert.match(msg ?? '', /does not parse/);
  assert.match(msg ?? '', /line \d+, column \d+/);
});

test('constructs the isolated world blocks are refused by name', () => {
  for (const [code, what] of [
    ['eval("1+1");', /eval\(\)/],
    ['const f = new Function("return 1");', /new Function\(\)/],
    ['document.write("<p>hi</p>");', /document\.write\(\)/],
    ['btn.setAttribute("onclick", "doThing()");', /inline event-handler attribute/],
    ['el.innerHTML = \'<button onclick="go()">go</button>\';', /inline event-handler attribute/],
  ] as const) {
    const msg = checkProposal({ code, matches: good.matches }, tested);
    assert.match(msg ?? '', what, `expected ${code} to be refused`);
  }
});

test('addEventListener is not mistaken for an inline handler', () => {
  assert.equal(checkProposal({ code: 'btn.addEventListener("click", go);', matches: good.matches }, tested), null);
  // Nor is a variable called `evaluate`, or a property named eval-ish.
  assert.equal(checkProposal({ code: 'const evaluated = score.evaluate;', matches: good.matches }, tested), null);
});

test('an every-site match pattern is refused unless the user asked for every site', () => {
  for (const m of ['<all_urls>', '*://*/*']) {
    const msg = checkProposal({ code: good.code, matches: [m] }, tested);
    assert.match(msg ?? '', /every site/);
    assert.match(msg ?? '', /Narrow it/);
  }
});

test('the user asking for every site allows it', () => {
  const ctx: ProposalContext = { testedSinceProposal: true, userText: 'block this popup on every site' };
  assert.equal(checkProposal({ code: good.code, matches: ['<all_urls>'] }, ctx), null);
});

test('askedForEverySite reads the phrasings a user actually uses, and not near misses', () => {
  for (const s of ['on every site', 'all sites please', 'do this everywhere', 'every website', 'all websites'])
    assert.equal(askedForEverySite(s), true, s);
  for (const s of ['on this site', 'every page of this site', 'hide the sidebar'])
    assert.equal(askedForEverySite(s), false, s);
});

test('a broad pattern among narrow ones is still caught', () => {
  const msg = checkProposal({ code: good.code, matches: ['*://*.example.com/*', '*://*/*'] }, tested);
  assert.match(msg ?? '', /every site/);
});

// ---------- selector durability ----------

test('generated class names are recognized across the common build tools', () => {
  for (const c of ['css-1a2b3c', 'sc-abc123', 'jsx-123', '_hash_12ab', 'styles_button__3kF9d', 'x1n2onr6', 'item-1234'])
    assert.equal(isGeneratedClass(c), true, c);
});

test('hand-written class names are not flagged, including ones with a digit', () => {
  for (const c of ['sidebar', 'nav-main', 'vector-toc-pinned-container', 'titleline', 'mw-page-container', 'btn', 'col-md-6', 'h2'])
    assert.equal(isGeneratedClass(c), false, c);
});

test('each selector shape gets the label the prompt tells the model to read', () => {
  assert.equal(durabilityLabel('#main-nav'), '[stable: id]');
  assert.equal(durabilityLabel('div[data-testid="row"]'), '[stable: data-attr]');
  assert.equal(durabilityLabel('button[role="tab"]'), '[stable: role+text]');
  assert.equal(durabilityLabel('div.css-1x2y3z > p'), '[fragile: generated class]');
  assert.equal(durabilityLabel('div.sidebar > p:nth-of-type(3)'), '[fragile: positional]');
  assert.equal(durabilityLabel('nav.site-header'), '[stable: named class]');
  assert.equal(durabilityLabel('div > p'), '[fragile: positional]');
});

test('a generated class outranks a positional suffix, because it is the reason the selector will break first', () => {
  assert.deepEqual(durabilityOf('div.css-1x2y3z > p:nth-of-type(2)'), { kind: 'fragile', reason: 'generated class' });
});

test('an id anywhere in the chain counts as stable', () => {
  assert.equal(durabilityLabel('#hnmain > tbody'), '[stable: id]');
});
