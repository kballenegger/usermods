// lib/skillrun.ts: the machine on its own, then the run over a real Driver with the browser faked. The
// gate and the journal are the real ones, so what holds here is that a skill's run goes through them:
// a step on the never list is refused, a pending step is never replayed, a local skill alone gets a
// standing allowance, and an input's value is typed and reported nowhere else.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { Driver, type DescribeReply, type DriverDeps } from '../lib/agent/driver.ts';
import { answerFits, type Answer, type Question } from '../lib/agent/questions.ts';
import type { ActResult, ActStep } from '../lib/interact/actions.ts';
import type { Described } from '../lib/interact/describe.ts';
import { MAX_RUN_ACTIONS, STANDING_LABEL, initialRun, inputsInOrder, next, outputCsv, outputsNote, planStep, runSkill, runSummary, stepsKey, type RunCarry, type SkillRunDeps } from '../lib/skillrun.ts';
import { skillFromSource, type Skill, type SkillStep } from '../lib/skills.ts';
import type { AgentEventBody } from '../lib/types.ts';

const PAGE = 'https://forms.example.com/';
const FILE = (steps: string, front = 'inputs: {}\noutputs: {}') => `---
usermods-skill: 1
name: Thing
description: A thing.
version: 1.0.0
match:
  - "*://forms.example.com/*"
start: https://forms.example.com/
${front}
---

\`\`\`steps
${steps}
\`\`\`
`;

const asLocal = (steps: string, front?: string): Skill => skillFromSource(FILE(steps, front), { origin: 'local', id: 's1' });
const asImported = (steps: string, front?: string): Skill => skillFromSource(FILE(steps, front), { origin: 'imported', id: 's2' });

function described(role: string, name: string, extra: Partial<Described> = {}): Described {
  return { role, name, tag: role, pageUrl: PAGE, fingerprint: { role, name, tag: role }, ...extra } as Described;
}

const okResult = (d: Described, clicks?: number): ActResult => ({ ok: true, text: `did ${d.name}`, described: d, delta: { dom: { added: 0, removed: 0, attributes: 0 }, urlBefore: PAGE, urlAfter: PAGE, newOperable: [] }, ...(clicks ? { clicks } : {}) });

interface Harness {
  log: string[];
  performed: ActStep[];
  questions: Question[];
  rows: Array<{ i: number; state: string; text: string }>;
  notes: string[];
  kept: string[];
  carry: RunCarry[];
  deps: SkillRunDeps;
  events: AgentEventBody[];
}

/** A page where every target reads as what the step names it, unless `read` says otherwise. */
function harness(init: { read?: (s: ActStep) => DescribeReply; answers?: Array<Answer | null>; perform?: (s: ActStep) => ActResult | Promise<ActResult>; values?: string[] } = {}): Harness {
  const h: Harness = { log: [], performed: [], questions: [], rows: [], notes: [], kept: [], carry: [], deps: null as unknown as SkillRunDeps, events: [] };
  const answers = [...(init.answers ?? [])];
  const read =
    init.read ??
    ((s: ActStep): DescribeReply => {
      if (s.do === 'go') return { ok: true, signature: 'go', described: { ...described('', ''), go: { kind: 'url', href: new URL(s.text!, PAGE).href, path: new URL(s.text!, PAGE).pathname, host: new URL(s.text!, PAGE).host } } };
      const t = s.target && 'role' in s.target ? s.target : { role: 'button', name: 'Thing' };
      return { ok: true, signature: 'sig', described: described(t.role, t.name) };
    });
  const deps: DriverDeps = {
    describe: async (s) => read(s),
    perform: async (_id, s) => {
      h.log.push(`perform:${s.do}`);
      h.performed.push(s);
      if (init.perform) return init.perform(s);
      const r = read(s);
      return okResult(r.ok ? r.described : described('', ''));
    },
    cancel: () => {},
    outline: async () => {},
    bar: async (b) => {
      if (b) h.log.push(`bar:${b.status}`);
      return { up: true };
    },
    raiseAgain: async () => ({ up: true }),
    ask: async (q) => {
      h.questions.push(q);
      const a = answers.shift();
      if (a === undefined) throw new Error(`no answer for ${q.kind}`);
      if (a) assert.ok(answerFits(q, a), `${JSON.stringify(a)} does not fit ${q.kind}`);
      return a;
    },
    pageUrl: async () => PAGE,
    tabActive: async () => true,
    whenActive: async () => {},
    goBackTo: async () => {},
    settled: async () => {},
    wait: async () => ({ matched: true, elapsedMs: 5 }),
    journalWrite: async (j) => void h.log.push(`write:${j.kind}:${j.label}`),
    journalClear: async (n) => void h.log.push(`clear:${n ?? '-'}`),
    loadAllowances: async () => ({ site: true, actions: ['click button "from the chat"'] }),
    allowSite: async () => {},
    allowAction: async () => void h.log.push('allow-action-in-chat'),
    chatSites: async () => [],
    askEveryStep: async () => false,
    emit: (e) => void h.events.push(e),
    newId: () => `id${h.log.length}${Math.random()}`,
    now: () => 1000,
    sleep: async () => {},
  };
  const driver = new Driver(deps);
  h.deps = {
    driver: { runStep: (s, o, sig) => driver.runStep(s, o, sig), ask: (q, sig) => driver.ask(q, sig), guard: (sig) => driver.guard(sig), announce: (b, a, sig) => driver.announce(b, a, sig), handoff: (t, spec, sig) => driver.handoff(t, spec, sig), didYourself: () => driver.didYourself() },
    wait: async () => ({ matched: true, elapsedMs: 5 }),
    read: async () => ({ ok: true, values: init.values ?? [] }),
    atStep: async (i) => void h.log.push(`at:${i}`),
    pastStep: async (i) => void h.log.push(`past:${i}`),
    carry: async (c) => void h.carry.push(c),
    keepAllowance: async (k) => void h.kept.push(k),
    row: (i, r) => void h.rows.push({ i, state: r.state, text: r.text }),
    note: (t) => void h.notes.push(t),
    newId: () => `id${Math.random()}`,
  };
  return h;
}

const go = (skill: Skill, h: Harness, opts: Partial<Parameters<typeof runSkill>[2]> = {}, signal = new AbortController().signal) => runSkill(skill, h.deps, { carry: { inputs: {}, outputs: {} }, ...opts }, signal);

const CLICK = '- click: button "Go on"\n  at: { css: "#g" }';
const SUBMIT = '- click: button "Delete it"\n  at: { css: "#d" }\n  why: tidy up';

// ---------- the machine ----------

test('the machine: a clean run goes step by step and finishes', () => {
  let s = initialRun(2, { walking: false });
  let r = next(s, { type: 'begin' });
  assert.deepEqual(r.effect, { do: 'step', index: 0 });
  r = next(r.state, { type: 'done', actions: 1 });
  assert.deepEqual(r.effect, { do: 'step', index: 1 });
  r = next(r.state, { type: 'done', actions: 1 });
  assert.deepEqual(r.effect, { do: 'finish', outcome: { kind: 'finished', walked: false } });
  assert.equal(r.state.ran, 2);
  s = r.state;
  assert.equal(s.actions, 2);
});

test('the machine: a broken step waits; try again stays on it, continue from goes past it and costs the walk', () => {
  const s = initialRun(3, { walking: true });
  const broken = next(s, { type: 'broken', message: 'gone' });
  assert.deepEqual(broken.effect, { do: 'ask-broken', index: 0, message: 'gone' });
  assert.deepEqual(next(broken.state, { type: 'try-again' }).effect, { do: 'step', index: 0 });
  const on = next(broken.state, { type: 'continue-from' });
  assert.deepEqual(on.effect, { do: 'step', index: 1 });
  assert.equal(on.state.walkIntact, false);
  assert.equal(on.state.ran, 0, 'a step done by hand did not run');
});

test('the machine: a pending step asks first, and nothing runs until it is answered', () => {
  const s = initialRun(3, { from: 1, walking: false });
  const r = next(s, { type: 'begin', pending: 'click button "Pay"' });
  assert.deepEqual(r.effect, { do: 'ask-pending', index: 1, label: 'click button "Pay"' });
  assert.deepEqual(next(r.state, { type: 'it-did' }).effect, { do: 'step', index: 2 });
  assert.deepEqual(next(r.state, { type: 'do-again' }).effect, { do: 'step', index: 1 });
});

test('the machine: refused and declined end the run, Stop ends it, and the ceiling pauses', () => {
  const s = initialRun(2, { walking: false, maxActions: 3 });
  assert.equal(next(s, { type: 'refused', message: 'x' }).effect.do, 'finish');
  assert.deepEqual(next(s, { type: 'declined', label: 'y' }).effect, { do: 'finish', outcome: { kind: 'declined', at: 0, label: 'y' } });
  assert.deepEqual(next(s, { type: 'stopped' }).effect, { do: 'finish', outcome: { kind: 'stopped', at: 0 } });
  const r = next(s, { type: 'done', actions: 3 });
  assert.deepEqual(r.effect, { do: 'ask-ceiling', actions: 3 });
  const go2 = next(r.state, { type: 'carry-on' });
  assert.deepEqual(go2.effect, { do: 'step', index: 1 });
  assert.equal(MAX_RUN_ACTIONS, 500);
});

test('the machine: a complete walk says so, and a resumed one does not', () => {
  const walked = next(initialRun(1, { walking: true }), { type: 'done', actions: 1 });
  assert.deepEqual(walked.effect, { do: 'finish', outcome: { kind: 'finished', walked: true } });
  const resumed = next(initialRun(2, { from: 1, walking: true }), { type: 'done', actions: 1 });
  assert.deepEqual(resumed.effect, { do: 'finish', outcome: { kind: 'finished', walked: false } });
  const rest = next(initialRun(2, { walking: true }), { type: 'walk-rest' });
  assert.equal(rest.state.walking, false);
  assert.equal(rest.state.walkIntact, true, 'run the rest still finishes the walk');
});

// ---------- planning a step ----------

test('a step becomes the act tool’s step, with the fingerprint for its target and the input in its text', () => {
  const at = { css: '#m', in: 'form "F"' };
  const fill: SkillStep = { verb: 'fill', value: '$m', target: 'textbox "Merchant"', at };
  assert.deepEqual(planStep(fill, { m: 'Cafe' }, PAGE), { kind: 'act', step: { do: 'fill', target: { at, role: 'textbox', name: 'Merchant' }, text: 'Cafe' } });
  assert.deepEqual(planStep(fill, {}, PAGE), { kind: 'needs-input', name: 'm' });
  assert.deepEqual(planStep({ ...fill, when: '$m' }, {}, PAGE), { kind: 'skip', why: 'no m' });
  assert.deepEqual(planStep({ verb: 'fill', value: 'always', target: 'textbox', at }, {}, PAGE), { kind: 'act', step: { do: 'fill', target: { at, role: 'textbox', name: '' }, text: 'always' } });
  assert.deepEqual(planStep({ verb: 'go', to: '/a?b=1' }, {}, PAGE), { kind: 'act', step: { do: 'go', text: 'https://forms.example.com/a?b=1' } });
  assert.deepEqual(planStep({ verb: 'go', to: 'back' }, {}, PAGE), { kind: 'act', step: { do: 'go', text: 'back' } });
  assert.deepEqual(planStep({ verb: 'check', target: 'checkbox "X"', at, checked: false }, {}, PAGE), { kind: 'act', step: { do: 'check', target: { at, role: 'checkbox', name: 'X' }, text: 'false' } });
  assert.equal(planStep({ verb: 'click', target: 'not a target!', at }, {}, PAGE).kind, 'bad');
});

// ---------- a run, through the real gate ----------

test('a run goes through the journal: written with the step, cleared with where it carries on from', async () => {
  const h = harness();
  const r = await go(asLocal(CLICK), h);
  assert.equal(r.outcome.kind, 'finished');
  const i = h.log.indexOf('perform:click');
  assert.ok(h.log[i - 1]!.startsWith('write:skill:click button "Go on"'), h.log.join(' | '));
  assert.equal(h.log[i + 1], 'clear:1');
  assert.ok(h.log.includes('at:0'));
  assert.ok(h.log.includes('bar:usermods is running Thing · 1 of 1'), h.log.join(' | '));
});

test('with no question to ask and no model anywhere, the run does its steps and says so', async () => {
  const h = harness();
  const r = await go(asLocal(`${CLICK}\n${CLICK.replace('Go on', 'And on').replace('#g', '#h')}`), h);
  assert.deepEqual(h.performed.map((s) => s.do), ['click', 'click']);
  assert.equal(h.questions.length, 0);
  assert.equal(r.ran, 2);
  assert.match(r.label, /on the page · Thing · 2 steps/);
  assert.deepEqual(h.rows.filter((x) => x.state === 'done').map((x) => x.text), ['1/2 · clicked "Go on"', '2/2 · clicked "And on"']);
});

test('the gate decides from the live element, whatever the file says it is', async () => {
  // The file says Save. The page reads Delete. The driver asks by the live name.
  const h = harness({ read: () => ({ ok: true, signature: 's', described: described('button', 'Delete everything') }), answers: [{ kind: 'decline' }] });
  const r = await go(asLocal('- click: button "Save"\n  at: { css: "#s" }'), h);
  assert.equal(h.questions[0]!.kind, 'allow');
  assert.match((h.questions[0] as Extract<Question, { kind: 'allow' }>).headline, /Delete everything/);
  assert.equal(h.performed.length, 0, 'declined, nothing happened');
  assert.equal(r.outcome.kind, 'declined');
});

test('a consequential step asks every run, labels the skill’s words, and a stranger’s skill is offered no standing allowance', async () => {
  const h = harness({ answers: [{ kind: 'allow' }] });
  await go({ ...asImported(SUBMIT), walked: true }, h);
  const q = h.questions[0] as Extract<Question, { kind: 'allow' }>;
  assert.equal(q.kind, 'allow');
  assert.equal(q.stepOf, 'step 1 of 1 of Thing');
  assert.equal(q.skillSays, 'tidy up');
  assert.match(q.because!, /delete/);
  assert.equal(q.every, undefined);
});

test('only a local skill is offered Do not ask again, and what it keeps is its own, not the chat’s', async () => {
  const h = harness({ answers: [{ kind: 'allow', every: true }] });
  await go(asLocal(SUBMIT), h);
  const q = h.questions[0] as Extract<Question, { kind: 'allow' }>;
  assert.equal(q.every?.label, STANDING_LABEL);
  assert.deepEqual(h.kept, ['click button "delete it"']);
  assert.ok(!h.log.includes('allow-action-in-chat'), 'not written to the chat');

  const again = harness();
  await go({ ...asLocal(SUBMIT), allowedSteps: h.kept }, again);
  assert.equal(again.questions.length, 0, 'the second run does not ask');
  assert.equal(again.performed.length, 1);

  const stranger = harness({ answers: [{ kind: 'decline' }] });
  await go({ ...asImported(SUBMIT), walked: true, allowedSteps: h.kept }, stranger);
  assert.equal(stranger.questions.length, 1, 'an allowance on a record that may not hold one does nothing');
});

test('a skill does not inherit what the chat allowed a model', async () => {
  // The fake allowances hold `click button "from the chat"`, and this reads as exactly that.
  const hh = harness({ read: () => ({ ok: true, signature: 's', described: described('button', 'From the chat', { form: { method: 'post' }, submits: true }) }), answers: [{ kind: 'decline' }] });
  await go({ ...asImported('- click: button "From the chat"\n  at: { css: "#x" }'), walked: true }, hh);
  assert.equal(hh.questions.length, 1, 'the chat’s allowance does not reach a skill');
});

test('the never list holds: a step that types into a password field is refused, and the run stops', async () => {
  const h = harness({ read: () => ({ ok: true, signature: 's', described: described('textbox', 'Password', { field: 'password' }) }) });
  const forced: Skill = { ...asLocal(CLICK), steps: [{ verb: 'fill', value: 'hunter2', target: 'textbox "Password"', at: { css: '#p' } }, { verb: 'click', target: 'button "After"', at: { css: '#a' } }] };
  const r = await go(forced, h);
  assert.equal(r.outcome.kind, 'refused');
  assert.equal((r.outcome as { message: string }).message, 'step 1 was refused: it types into a password field');
  assert.equal(h.performed.length, 0);
  assert.ok(!h.log.some((l) => l.startsWith('write:')), 'nothing even journalled');
});

test('a go off the site is refused by the gate, wherever the file says it goes', async () => {
  const h = harness();
  const forced: Skill = { ...asLocal(CLICK), steps: [{ verb: 'go', to: 'https://evil.test/' }] };
  // The run is pinned to forms.example.com by its first step's page.
  const r = await go(forced, h);
  assert.equal(r.outcome.kind, 'refused');
  assert.equal(h.performed.length, 0);
});

test('a broken step stops until the user says: try again re-reads it, continue from goes on and is the user’s', async () => {
  let reads = 0;
  const h = harness({
    read: (s) => {
      if (s.target && 'role' in s.target && s.target.name === 'Gone' && ++reads < 3) return { ok: false, code: 'broken', broken: 'none', message: 'could not find button "Gone" (0 matches)' };
      return { ok: true, signature: 's', described: described('button', s.target && 'role' in s.target ? s.target.name : 'x') };
    },
    answers: [{ kind: 'try-again' }, { kind: 'try-again' }],
  });
  await go(asLocal('- click: button "Gone"\n  at: { css: "#g" }'), h);
  assert.deepEqual(h.questions.map((q) => q.kind), ['skill-broken', 'skill-broken']);
  assert.match((h.questions[0] as Extract<Question, { kind: 'skill-broken' }>).message, /could not find button "Gone"/);
  assert.equal(h.performed.length, 1, 'the third read found it');

  const hand = harness({ read: () => ({ ok: false, code: 'broken', message: 'nope' }), answers: [{ kind: 'continue-from' }] });
  const r = await go(asLocal(`${CLICK}\n- wait: { ms: 1 }`), hand);
  assert.equal(r.outcome.kind, 'finished');
  assert.equal(hand.performed.length, 0, 'the step did not run; the user did it');
  assert.ok(hand.log.includes('past:1'));
  assert.match(hand.notes.join(), /you did this step: click button "Go on"/);
});

test('a pending step on resume: IT DID goes past it and nothing replays it', async () => {
  const h = harness({ answers: [{ kind: 'it-did' }] });
  const r = await go(asLocal(`${CLICK}\n${CLICK.replace('Go on', 'Next').replace('#g', '#n')}`), h, { pending: 'click button "Go on"', from: 0 });
  assert.equal(h.questions[0]!.kind, 'did-happen');
  assert.deepEqual(h.performed.map((s) => s.target && 'role' in s.target && s.target.name), ['Next']);
  assert.equal(r.outcome.kind, 'finished');
  assert.ok(h.log.indexOf('past:1') < h.log.indexOf('perform:click'), 'the journal is cleared before anything else runs');
});

test('a pending step on resume: DO IT AGAIN sends it back through the gate, and Stop runs nothing', async () => {
  const again = harness({ answers: [{ kind: 'do-again' }, { kind: 'allow' }] });
  await go(asLocal(SUBMIT), again, { pending: 'click button "Delete it"', from: 0 });
  assert.deepEqual(again.questions.map((q) => q.kind), ['did-happen', 'allow'], 'the gate asks again');
  assert.equal(again.performed.length, 1);

  const stop = harness({ answers: [null] });
  const r = await go(asLocal(CLICK), stop, { pending: 'x', from: 0 });
  assert.equal(stop.performed.length, 0);
  assert.equal(r.outcome.kind, 'stopped');
});

test('the walk shows every step from the live read, RUN THE REST ends it, and consequential steps still ask', async () => {
  const skill = asImported(`${CLICK}\n- wait: { ms: 1 }\n${CLICK.replace('Go on', 'Next').replace('#g', '#n')}\n${SUBMIT}`);
  assert.equal(skill.walked, false);
  const h = harness({ answers: [{ kind: 'next' }, { kind: 'rest' }, { kind: 'allow' }] });
  const r = await go(skill, h);
  assert.deepEqual(h.questions.map((q) => q.kind), ['walk', 'walk', 'allow']);
  const first = h.questions[0] as Extract<Question, { kind: 'walk' }>;
  assert.equal(first.headline, 'click button "Go on"');
  assert.deepEqual([first.n, first.total], [1, 4]);
  assert.equal(h.performed.length, 3);
  assert.deepEqual(r.outcome, { kind: 'finished', walked: true });
});

test('a walk the user stopped is not a walk', async () => {
  const h = harness({ answers: [{ kind: 'next' }, null] });
  const r = await go(asImported(`${CLICK}\n${CLICK.replace('Go on', 'Next').replace('#g', '#n')}`), h);
  assert.equal(r.outcome.kind, 'stopped');
  assert.equal(h.performed.length, 1);
});

test('an input is typed into its field and appears in no row, no journal line and no bar', async () => {
  const skill = asLocal('- fill: $merchant\n  into: textbox "Merchant"\n  at: { css: "#m" }', 'inputs:\n  merchant: { label: Merchant }\noutputs: {}');
  const h = harness();
  await go(skill, h, { carry: { inputs: { merchant: 'SECRET-VALUE' }, outputs: {} } });
  assert.equal(h.performed[0]!.text, 'SECRET-VALUE');
  const said = JSON.stringify([h.log, h.rows, h.notes, h.events]);
  assert.doesNotMatch(said, /SECRET-VALUE/);
});

test('an input the card did not get is asked for when the step is reached, and kept for the rest of the run', async () => {
  const skill = asLocal('- fill: $note\n  into: textbox "Note"\n  at: { css: "#n" }', 'inputs:\n  note: { label: Note, optional: true }\noutputs: {}');
  const h = harness({ answers: [{ kind: 'input', value: 'typed now' }] });
  await go(skill, h);
  assert.equal(h.questions[0]!.kind, 'skill-input');
  assert.equal(h.performed[0]!.text, 'typed now');
  assert.equal(h.carry.at(-1)!.inputs.note, 'typed now');
});

test('when: $input skips the step with the input empty', async () => {
  const skill = asLocal('- fill: $note\n  into: textbox "Note"\n  at: { css: "#n" }\n  when: $note', 'inputs:\n  note: { label: Note, optional: true }\noutputs: {}');
  const h = harness();
  const r = await go(skill, h);
  assert.equal(h.performed.length, 0);
  assert.equal(r.ran, 0);
  assert.match(h.rows[0]!.text, /skipped · no note/);
});

test('a read fills its output, the card carries it, a read that finds nothing is a broken step', async () => {
  const skill = asLocal('- read: links\n  from: a.x\n  take: href\n  each: true', 'inputs: {}\noutputs:\n  links: { label: Links, list: true }');
  const h = harness({ values: ['a', 'b'] });
  const r = await go(skill, h);
  assert.deepEqual(r.outputs, [{ name: 'links', label: 'Links', list: true, values: ['a', 'b'] }]);
  assert.match(h.rows[0]!.text, /read 2 Links/);

  const none = harness({ answers: [{ kind: 'continue-from' }] });
  none.deps.read = async () => ({ ok: false, message: 'could not find a.x (0 matches)' });
  await go(skill, none);
  assert.equal(none.questions[0]!.kind, 'skill-broken');
});

test('what a resumed run had read before it died is on the card too', async () => {
  const skill = asLocal('- read: links\n  from: a.x\n  take: href\n  each: true', 'inputs: {}\noutputs:\n  links: { label: Links, list: true }');
  const h = harness({ values: ['b'] });
  const r = await go(skill, h, { carry: { inputs: {}, outputs: { links: ['a'] } } });
  assert.deepEqual(r.outputs[0]!.values, ['a', 'b']);
});

test('the ceiling pauses at its number and goes on when told', async () => {
  const skill = asLocal(`${CLICK}\n${CLICK.replace('Go on', 'Next').replace('#g', '#n')}`);
  const h = harness({ answers: [{ kind: 'carry-on' }], perform: (s) => okResult(described('button', s.do), 5) });
  await go(skill, h, { maxActions: 5 });
  assert.equal(h.questions[0]!.kind, 'skill-ceiling');
  assert.equal(h.performed.length, 2);
});

test('Stop before a step means it does not run', async () => {
  const ac = new AbortController();
  ac.abort();
  const h = harness();
  const r = await go(asLocal(CLICK), h, {}, ac.signal);
  assert.equal(h.performed.length, 0);
  assert.equal(r.outcome.kind, 'stopped');
});

// ---------- words ----------

test('the run card’s line is computed from the steps', () => {
  const skill = asLocal(`- fill: $a\n  into: textbox "A"\n  at: { css: "#a" }\n${CLICK}\n- read: o\n  from: a\n  take: text\n- ask: Press it.`, 'inputs:\n  a: { label: A }\noutputs:\n  o: { label: O }');
  assert.equal(runSummary(skill, ['forms.example.com']), '4 steps on forms.example.com · fills 1 field · 1 click · reads 1 list · one step is yours');
});

test('Copy as CSV quotes what it has to, and the note says what was read', () => {
  assert.equal(outputCsv({ name: 'links', values: ['a', 'b,c', 'say "hi"'] }), 'links\na\n"b,c"\n"say ""hi"""');
  assert.equal(outputsNote('Thing', [{ name: 'links', label: 'Links', list: true, values: ['a', 'b'] }]), 'Outputs of Thing:\nLinks: a, b');
});

test('the steps’ key changes with the steps and not with anything else', () => {
  const a = asLocal(CLICK);
  assert.equal(stepsKey(a.steps), stepsKey(asLocal(CLICK).steps));
  assert.notEqual(stepsKey(a.steps), stepsKey(asLocal(SUBMIT).steps));
});

test('an answer a skill’s question did not offer is no answer', () => {
  const walk: Question = { kind: 'walk', id: 'q', skill: 's', n: 1, total: 2, headline: 'h' };
  assert.ok(answerFits(walk, { kind: 'next' }));
  assert.ok(answerFits(walk, { kind: 'rest' }));
  assert.ok(!answerFits(walk, { kind: 'allow' }));
  const broken: Question = { kind: 'skill-broken', id: 'q', skill: 's', n: 1, total: 2, message: 'm' };
  assert.ok(answerFits(broken, { kind: 'continue-from' }));
  assert.ok(!answerFits(broken, { kind: 'it-did' }));
  const did: Question = { kind: 'did-happen', id: 'q', skill: 's', n: 1, total: 2, label: 'l' };
  assert.ok(answerFits(did, { kind: 'do-again' }));
  assert.ok(!answerFits(did, { kind: 'allow', standing: true }));
  const allow: Question = { kind: 'allow', id: 'q', host: 'h', headline: 'x', firstOnSite: false };
  assert.ok(!answerFits(allow, { kind: 'allow', every: true }), 'no every on offer, so none taken');
  assert.ok(answerFits({ kind: 'skill-input', id: 'q', skill: 's', n: 1, label: 'l' }, { kind: 'input', value: 'v' }));
  assert.ok(!answerFits({ kind: 'skill-ceiling', id: 'q', skill: 's', actions: 500 }, { kind: 'next' }));
});

test('the card asks for inputs in the order the steps use them, whatever order storage kept the map in', () => {
  const skill = asLocal('- fill: $merchant\n  into: textbox "M"\n  at: { css: "#m" }\n- fill: $amount\n  into: textbox "A"\n  at: { css: "#a" }', 'inputs:\n  merchant: { label: M }\n  amount: { label: A }\noutputs: {}');
  const sorted = { ...skill, inputs: { amount: skill.inputs.amount!, merchant: skill.inputs.merchant! } };
  assert.deepEqual(inputsInOrder(sorted).map(([k]) => k), ['merchant', 'amount']);
});
