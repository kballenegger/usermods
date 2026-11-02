// lib/agent/driver.ts: the order around one step, with the browser faked and the gate real.
//
// What this holds down is the safety rules, each as something that can fail: a refused field is never
// performed, a declined step never reaches the page, the journal is written before the step and cleared
// with its result, a lost answer is not sent again, Stop reaches a step, the run holds still when the
// tab or the site is left, and an answer the question did not offer is no answer.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { Driver, knownUrls, parseActInput, pendingResumeNote, targetFrom, type DescribeReply, type DriverDeps } from '../lib/agent/driver.ts';
import { answerFits, type Answer, type Question } from '../lib/agent/questions.ts';
import type { ActResult, ActStep } from '../lib/interact/actions.ts';
import type { Described } from '../lib/interact/describe.ts';
import type { AgentEventBody, Msg } from '../lib/types.ts';

const PAGE = 'https://shop.example.com/cart';

function button(name: string, extra: Partial<Described> = {}): Described {
  return { role: 'button', name, tag: 'button', pageUrl: PAGE, fingerprint: { role: 'button', name, tag: 'button' }, ...extra } as Described;
}

const ok = (d: Described, extra: Partial<Extract<ActResult, { ok: true }>> = {}): Extract<ActResult, { ok: true }> => ({
  ok: true,
  text: `did ${d.name}`,
  described: d,
  delta: { dom: { added: 0, removed: 0, attributes: 0 }, urlBefore: d.pageUrl, urlAfter: d.pageUrl, newOperable: [] },
  ...extra,
});

interface World {
  deps: DriverDeps;
  log: string[];
  events: AgentEventBody[];
  questions: Question[];
  /** What the page reads as, per step. */
  read: (step: ActStep) => DescribeReply;
  perform: (step: ActStep) => Promise<ActResult>;
  answers: Array<Answer | null | ((q: Question) => Answer | null)>;
  url: string;
  active: boolean;
  allowed: { site: boolean; actions: string[] };
  standing: string[];
  chatSites: string[];
  barUp: boolean;
  askEvery: boolean;
  wakeActive?: () => void;
  time: number;
}

function world(init: Partial<Pick<World, 'read' | 'perform' | 'answers' | 'url' | 'active' | 'allowed' | 'chatSites' | 'barUp' | 'askEvery'>> = {}): World {
  const w: World = {
    log: [],
    events: [],
    questions: [],
    read: (step) => ({ ok: true, described: button(step.target && 'selector' in step.target ? step.target.selector : 'Thing'), signature: 'sig' }),
    perform: async (step) => ok(button(step.do)),
    answers: [],
    url: PAGE,
    active: true,
    allowed: { site: true, actions: [] },
    standing: [],
    chatSites: [],
    barUp: true,
    askEvery: false,
    time: 1000,
    ...init,
    deps: null as unknown as DriverDeps,
  };
  let id = 0;
  w.deps = {
    describe: async (step) => {
      w.log.push('describe');
      return w.read(step);
    },
    perform: async (_id, step, expect) => {
      assert.equal(expect, 'sig', 'the signature describe gave is what act hands back');
      w.log.push(`perform:${step.do}`);
      return w.perform(step);
    },
    cancel: () => w.log.push('cancel'),
    outline: async (t) => void w.log.push(t ? 'outline' : 'outline-clear'),
    bar: async (s) => {
      w.log.push(s ? `bar:${s.status}` : 'bar:off');
      return { up: w.barUp };
    },
    raiseAgain: async () => {
      w.log.push('bar:again');
      w.barUp = true;
      return { up: true };
    },
    ask: async (q) => {
      w.questions.push(q);
      w.log.push(`ask:${q.kind}`);
      const next = w.answers.shift();
      if (next === undefined) throw new Error(`no answer scripted for a ${q.kind} question`);
      return typeof next === 'function' ? next(q) : next;
    },
    pageUrl: async () => w.url,
    tabActive: async () => w.active,
    whenActive: (signal) =>
      new Promise((resolve) => {
        w.log.push('paused');
        w.wakeActive = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    goBackTo: async (url) => {
      w.log.push(`back:${url}`);
      w.url = url;
    },
    settled: async () => void w.log.push('settled'),
    wait: async () => ({ matched: true, elapsedMs: 1, detail: 'it holds' }),
    journalWrite: async (s) => void w.log.push(`journal:${s.kind}:${s.label}`),
    journalClear: async () => void w.log.push('journal-clear'),
    loadAllowances: async () => w.allowed,
    allowSite: async (h, standing) => {
      w.log.push(`allow-site:${h}:${standing}`);
      if (standing) w.standing.push(h);
      w.allowed = { ...w.allowed, site: true };
      w.chatSites.push(h);
    },
    allowAction: async (_h, key) => {
      w.log.push(`allow-action:${key}`);
      w.allowed = { ...w.allowed, actions: [...w.allowed.actions, key] };
    },
    chatSites: async () => w.chatSites,
    askEveryStep: async () => w.askEvery,
    emit: (e) => void w.events.push(e),
    newId: () => `id${++id}`,
    now: () => w.time,
    sleep: async () => {},
  };
  return w;
}

const NONE = new AbortController().signal;
const click = (selector: string, extra: Partial<ActStep> = {}): ActStep => ({ do: 'click', target: { selector }, ...extra });
const performed = (w: World) => w.log.filter((l) => l.startsWith('perform:'));

test('the journal is written before the step and cleared with its result, with no value in it', async () => {
  const w = world();
  const d = new Driver(w.deps);
  const out = await d.runStep({ do: 'fill', target: { selector: 'Email' }, text: 'secret-value' }, {}, NONE);
  assert.equal(out.kind, 'done');
  const at = (prefix: string) => w.log.findIndex((l) => l.startsWith(prefix));
  assert.ok(at('journal:act') < at('perform:'), 'written first');
  assert.ok(at('perform:') < at('journal-clear'), 'cleared with the result');
  assert.ok(at('describe') < at('journal:act'));
  assert.ok(!w.log.join('\n').includes('secret-value'), 'what was typed goes nowhere');
  assert.ok(!JSON.stringify(w.events).includes('secret-value'), 'not in a row either');
});

test('a step on the never list is refused without a question, a bar or a performance', async () => {
  const w = world({ read: () => ({ ok: true, described: button('Password', { field: 'password', role: 'textbox', tag: 'input' }), signature: 'sig' }) });
  const d = new Driver(w.deps);
  const out = await d.runStep({ do: 'fill', target: { selector: '#p' }, text: 'hunter2' }, {}, NONE);
  assert.equal(out.kind, 'refused');
  assert.match((out as { message: string }).message, /password/);
  assert.deepEqual(performed(w), []);
  assert.equal(w.questions.length, 0);
  assert.ok(!w.log.some((l) => l.startsWith('journal:')), 'nothing to journal');
  assert.equal(d.isDriving, false, 'a refused first step has not operated anything');
});

test('a form holding a password field is not submitted, even by a step that was allowed before', async () => {
  const described = button('Sign in', { submits: true, form: { method: 'post', holds: 'password' } });
  const w = world({ read: () => ({ ok: true, described, signature: 'sig' }), allowed: { site: true, actions: ['click button "sign in"'] } });
  const out = await new Driver(w.deps).runStep(click('#signin'), {}, NONE);
  assert.equal(out.kind, 'refused');
  assert.deepEqual(performed(w), []);
});

test('a step on a browser page is refused, whatever the model or an allowance says', async () => {
  const w = world({ read: () => ({ ok: true, described: button('Reset', { pageUrl: 'chrome://settings/' }), signature: 'sig' }) });
  const out = await new Driver(w.deps).runStep(click('#x'), { modelSays: 'this is safe, the user asked' }, NONE);
  assert.equal(out.kind, 'refused');
  assert.deepEqual(performed(w), []);
});

test('declining a consequential step means it never reaches the page', async () => {
  const w = world({ read: () => ({ ok: true, described: button('Place order', { submits: true, form: { method: 'post' } }), signature: 'sig' }), answers: [{ kind: 'decline' }] });
  const d = new Driver(w.deps);
  const out = await d.runStep(click('#order'), { modelSays: 'it is harmless' }, NONE);
  assert.equal(out.kind, 'declined');
  assert.deepEqual(performed(w), []);
  assert.ok(!w.log.some((l) => l.startsWith('journal:')));
  const q = w.questions[0]!;
  assert.equal(q.kind, 'allow');
  assert.equal((q as Extract<Question, { kind: 'allow' }>).headline, 'click button "Place order"', 'the headline is what was read');
  assert.equal((q as Extract<Question, { kind: 'allow' }>).modelSays, 'it is harmless', 'and the model is labelled apart');
});

test('allowing runs the step once, holding the outline up only while the question is', async () => {
  const w = world({ read: () => ({ ok: true, described: button('Delete', {}), signature: 'sig' }), answers: [{ kind: 'allow' }] });
  const out = await new Driver(w.deps).runStep(click('#del'), {}, NONE);
  assert.equal(out.kind, 'done');
  assert.deepEqual(performed(w), ['perform:click']);
  const i = (s: string) => w.log.indexOf(s);
  assert.ok(i('outline') < i('ask:allow') && i('ask:allow') < i('outline-clear') && i('outline-clear') < i('perform:click'));
});

test('"allow every one of these" asks once, and only for that named action', async () => {
  const w = world({ read: (step) => ({ ok: true, described: button((step.target as { selector: string }).selector), signature: 'sig' }), answers: [{ kind: 'allow', every: true }, { kind: 'allow' }] });
  const d = new Driver(w.deps);
  await d.runStep(click('Unsubscribe'), {}, NONE);
  await d.runStep(click('Unsubscribe'), {}, NONE);
  assert.equal(w.questions.length, 1, 'the second one asked nothing');
  await d.runStep(click('Delete'), {}, NONE);
  assert.equal(w.questions.length, 2, 'a different control asks');
  assert.deepEqual(performed(w).length, 3);
  assert.ok(w.events.some((e) => e.type === 'note' && /every "Unsubscribe"/.test(e.text)));
});

test('the first act on a site asks; a harmless step gets the plain card, and standing is the user’s box', async () => {
  const w = world({ allowed: { site: false, actions: [] }, answers: [{ kind: 'allow', standing: true }] });
  const d = new Driver(w.deps);
  await d.runStep(click('Next'), {}, NONE);
  assert.equal(w.questions[0]!.kind, 'operate');
  assert.deepEqual(w.standing, ['shop.example.com']);
  await d.runStep(click('Next'), {}, NONE);
  assert.equal(w.questions.length, 1, 'asked once');
});

test('declining the first question leaves the page as it was: no bar, not driving', async () => {
  const w = world({ allowed: { site: false, actions: [] }, answers: [{ kind: 'decline' }] });
  const d = new Driver(w.deps);
  const out = await d.runStep(click('Next'), {}, NONE);
  assert.equal(out.kind, 'declined');
  assert.equal(d.isDriving, false);
  assert.equal(w.log[w.log.length - 1], 'bar:off');
  assert.equal(await d.finish('model'), null, 'nothing to record');
});

test('when the first step is itself consequential one card asks both', async () => {
  const w = world({ allowed: { site: false, actions: [] }, read: () => ({ ok: true, described: button('Delete'), signature: 'sig' }), answers: [{ kind: 'allow' }] });
  await new Driver(w.deps).runStep(click('#x'), {}, NONE);
  assert.equal(w.questions.length, 1);
  const q = w.questions[0] as Extract<Question, { kind: 'allow' }>;
  assert.equal(q.kind, 'allow');
  assert.equal(q.firstOnSite, true);
  assert.ok(w.log.includes('allow-site:shop.example.com:false'));
});

test('Ask before every step makes everything ask, and nothing can answer it in advance', async () => {
  const w = world({ askEvery: true, answers: [{ kind: 'allow' }, { kind: 'decline' }] });
  const d = new Driver(w.deps);
  assert.equal((await d.runStep(click('Next'), {}, NONE)).kind, 'done');
  assert.equal((await d.runStep(click('Next'), {}, NONE)).kind, 'declined');
  assert.equal(w.questions.length, 2);
  assert.equal((w.questions[0] as { every?: unknown }).every, undefined, 'a forced question offers no "every"');
});

test('a forced step asks over every allowance', async () => {
  const w = world({ read: () => ({ ok: true, described: button('Delete'), signature: 'sig' }), allowed: { site: true, actions: ['click button "delete"'] }, answers: [{ kind: 'allow' }] });
  await new Driver(w.deps).runStep(click('#x'), { forceConfirm: true }, NONE);
  assert.equal(w.questions.length, 1);
});

test('a repeat asks once, with the count', async () => {
  const w = world({ read: () => ({ ok: true, described: button('Unsubscribe'), signature: 'sig' }), answers: [{ kind: 'allow' }], perform: async () => ok(button('Unsubscribe'), { clicks: 12 }) });
  const out = await new Driver(w.deps).runStep(click('#u', { repeat: 12 }), {}, NONE);
  assert.equal(w.questions.length, 1);
  assert.match((w.questions[0] as Extract<Question, { kind: 'allow' }>).headline, /up to 12 times/);
  assert.equal((out as { words: string }).words, 'clicked "Unsubscribe" ×12');
});

test('a lost answer is not sent again: the step counts as having probably happened', async () => {
  let sends = 0;
  const w = world({
    perform: async () => {
      sends++;
      throw new Error('The message channel closed before a response was received');
    },
  });
  const out = await new Driver(w.deps).runStep(click('#submit'), {}, NONE);
  assert.equal(sends, 1, 'sent once');
  assert.equal(out.kind, 'done');
  assert.match((out as { result: { text: string } }).result.text, /look at the page before repeating/);
  assert.ok(w.log.includes('settled') && w.log.includes('journal-clear'));
});

test('a refusal from the page itself counts, whatever the background decided', async () => {
  const w = world({ perform: async () => ({ ok: false, code: 'never', message: 'Refused: it types into a card field.' }) });
  assert.equal((await new Driver(w.deps).runStep(click('#x'), {}, NONE)).kind, 'refused');
  assert.ok(w.log.includes('journal-clear'));
});

test('Stop cancels a step in flight and the run does not wait out the step', async () => {
  const stop = new AbortController();
  const w = world({ perform: () => new Promise(() => {}) });
  const out = new Driver(w.deps).runStep(click('#slow', { repeat: 50 }), {}, stop.signal);
  await new Promise((r) => setTimeout(r, 10));
  const t = Date.now();
  stop.abort();
  assert.equal((await out).kind, 'stopped');
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t}ms`);
  assert.ok(w.log.includes('cancel'));
});

test('Stop before a step means it never starts', async () => {
  const stop = new AbortController();
  stop.abort();
  const w = world();
  assert.equal((await new Driver(w.deps).runStep(click('#x'), {}, stop.signal)).kind, 'stopped');
  assert.deepEqual(w.log, []);
});

test('Stop during a question ends the step, and nothing is performed', async () => {
  const stop = new AbortController();
  const w = world({ read: () => ({ ok: true, described: button('Delete'), signature: 'sig' }), answers: [null] });
  const out = await new Driver(w.deps).runStep(click('#x'), {}, stop.signal);
  assert.equal(out.kind, 'stopped');
  assert.deepEqual(performed(w), []);
});

// ---------------------------------------------------------------------------
// The pauses
// ---------------------------------------------------------------------------

test('a driving run pauses when its tab is left, and carries on when it is back', async () => {
  const w = world();
  const d = new Driver(w.deps);
  await d.runStep(click('A'), {}, NONE);
  w.active = false;
  const second = d.runStep(click('B'), {}, NONE);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(performed(w).length, 1, 'held');
  assert.ok(w.events.some((e) => e.type === 'status' && e.phase === 'waiting-user' && /you left the tab/.test(e.detail ?? '')));
  w.active = true;
  w.wakeActive!();
  assert.equal((await second).kind, 'done');
  assert.equal(performed(w).length, 2);
});

test('a run that has not operated the page does not pause: reading from another tab is as it was', async () => {
  const w = world({ active: false });
  await new Driver(w.deps).guard(NONE);
  assert.ok(!w.log.includes('paused'));
});

test('leaving the site stops the next tool until the user chooses; Go back goes back', async () => {
  const w = world({ answers: [{ kind: 'back' }] });
  const d = new Driver(w.deps);
  await d.runStep(click('A'), {}, NONE);
  w.url = 'https://evil.test/landing';
  await d.guard(NONE);
  const q = w.questions[0] as Extract<Question, { kind: 'left-site' }>;
  assert.equal(q.kind, 'left-site');
  assert.equal(q.to, 'evil.test');
  assert.equal(q.canContinue, false, 'no sibling, no Continue');
  assert.ok(w.log.includes(`back:${PAGE}`));
  assert.equal(w.url, PAGE);
});

test('a sibling host may be continued onto, once chosen, and it lasts', async () => {
  const w = world({ answers: [{ kind: 'continue' }] });
  const d = new Driver(w.deps);
  await d.runStep(click('A'), {}, NONE);
  w.url = 'https://account.example.com/login';
  await d.guard(NONE);
  const q = w.questions[0] as Extract<Question, { kind: 'left-site' }>;
  assert.equal(q.canContinue, true);
  await d.guard(NONE);
  assert.equal(w.questions.length, 1, 'not asked again');
  assert.deepEqual(w.chatSites, ['account.example.com'], 'and it lasts for the chat');
  const next = new Driver(w.deps);
  await next.runStep(click('B'), {}, NONE);
  w.url = 'https://shop.example.com/cart';
  await next.guard(NONE);
  assert.equal(w.questions.length, 1, 'a later run in the chat already holds it');
});

test('a sibling is nothing like an allowance for an unrelated host in the same chat', async () => {
  const w = world({ chatSites: ['other.test'], answers: [{ kind: 'back' }] });
  const d = new Driver(w.deps);
  await d.runStep(click('A'), {}, NONE);
  w.url = 'https://other.test/';
  await d.guard(NONE);
  assert.equal(w.questions.length, 1);
});

test('the rule on `go` is refusal: off the site is not a question', async () => {
  const w = world({ read: () => ({ ok: true, described: { ...button('x'), role: 'page', go: { kind: 'url', href: 'https://evil.test/', path: '/', host: 'evil.test' } }, signature: 'sig' }) });
  const out = await new Driver(w.deps).runStep({ do: 'go', text: 'https://evil.test/' }, {}, NONE);
  assert.equal(out.kind, 'refused');
  assert.deepEqual(performed(w), []);
});

test('www. is the same site', async () => {
  const w = world({ read: () => ({ ok: true, described: { ...button('x'), role: 'page', pageUrl: 'https://www.example.com/', go: { kind: 'url', href: 'https://example.com/a', path: '/a', host: 'example.com' } }, signature: 'sig' }), answers: [{ kind: 'allow' }] });
  w.url = 'https://www.example.com/';
  const out = await new Driver(w.deps).runStep({ do: 'go', text: 'https://example.com/a' }, {}, NONE);
  assert.equal(out.kind, 'done', 'an address not seen asks, and is not refused');
});

test('a go to an address already seen asks nothing', async () => {
  const href = 'https://shop.example.com/orders';
  const w = world({ read: () => ({ ok: true, described: { ...button('x'), role: 'page', go: { kind: 'url', href, path: '/orders', host: 'shop.example.com' } }, signature: 'sig' }) });
  const out = await new Driver(w.deps).runStep({ do: 'go', text: href }, { knownUrls: [href] }, NONE);
  assert.equal(out.kind, 'done');
  assert.equal(w.questions.length, 0);
});

test('a page that removed the bar pauses the run until the user answers, then it goes up again', async () => {
  const w = world({ barUp: false, answers: [{ kind: 'allow' }] });
  const out = await new Driver(w.deps).runStep(click('A'), {}, NONE);
  assert.equal(out.kind, 'done');
  assert.equal(w.questions[0]!.kind, 'bar-removed');
  const i = (s: string) => w.log.indexOf(s);
  assert.ok(i('bar:again') > -1 && i('bar:again') < i('perform:click'), 'answered before the step');
});

// ---------------------------------------------------------------------------
// Your turn
// ---------------------------------------------------------------------------

test('"I have done it" ends a handoff, and the bar offers it only then', async () => {
  const w = world({ answers: [{ kind: 'done' }] });
  const d = new Driver(w.deps);
  const out = await d.handoff('Sign in to shop.example.com', null, NONE);
  assert.equal(out.by, 'user');
  assert.ok(w.log.includes('bar:usermods · your turn: Sign in to shop.example.com'));
  assert.equal(w.log[w.log.length - 1], 'bar:off', 'a run that was not driving takes it down again');
  assert.ok(w.events.some((e) => e.type === 'note' && e.text === 'you did this step: Sign in to shop.example.com'));
});

test('a handoff ends by itself when its condition holds, without the user', async () => {
  const w = world({ answers: [() => new Promise(() => {}) as unknown as null] });
  w.deps.ask = (_q, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
  const spec = { condition: { kind: 'text', text: 'Your orders' }, timeoutMs: 20000 } as never;
  const out = await new Driver(w.deps).handoff('Sign in', spec, NONE);
  assert.equal(out.by, 'page');
});

test('a handoff outlives timeouts and pages that cannot be reached', async () => {
  const w = world();
  w.deps.ask = (_q, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
  const replies = [{ matched: false, elapsedMs: 20000 }, { matched: false, elapsedMs: 3, failure: 'The page could not be reached' }, { matched: true, elapsedMs: 1 }];
  w.deps.wait = async () => replies.shift()!;
  const spec = { condition: { kind: 'text', text: 'x' }, timeoutMs: 20000 } as never;
  assert.equal((await new Driver(w.deps).handoff('Sign in', spec, NONE)).by, 'page');
  assert.equal(replies.length, 0);
});

test('Stop ends a handoff', async () => {
  const stop = new AbortController();
  const w = world();
  w.deps.ask = (_q, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
  const out = new Driver(w.deps).handoff('Sign in', null, stop.signal);
  await new Promise((r) => setTimeout(r, 5));
  stop.abort();
  assert.equal((await out).by, 'stopped');
});

// ---------------------------------------------------------------------------
// The act tool
// ---------------------------------------------------------------------------

test('steps run in order and stop at the first that does not happen', async () => {
  const w = world({
    read: (step) => {
      const n = (step.target as { selector: string }).selector;
      return n === 'Broken' ? { ok: false, code: 'broken', message: 'No element matches Broken. Closest: button "Brokn"' } : { ok: true, described: button(n), signature: 'sig' };
    },
  });
  const r = await new Driver(w.deps).act({ steps: [click('A'), click('Broken'), click('C')], description: 'doing' }, { toolId: 't1', history: [] }, NONE);
  assert.equal(r.isError, true);
  assert.match(r.text, /Step 2 failed: No element matches Broken/);
  assert.match(r.text, /The step after it did not run/);
  assert.equal(performed(w).length, 1);
  const rows = w.events.filter((e): e is Extract<AgentEventBody, { type: 'act_step' }> => e.type === 'act_step');
  assert.deepEqual(rows.map((e) => [e.index, e.step.state]), [[0, 'running'], [0, 'done'], [1, 'failed']]);
});

test('a declined step in a call tells the model, who may go on, and names no way round', async () => {
  const w = world({ read: () => ({ ok: true, described: button('Delete'), signature: 'sig' }), answers: [{ kind: 'decline' }] });
  const r = await new Driver(w.deps).act({ steps: [click('X'), click('Y')], description: 'clean up' }, { toolId: 't1', history: [] }, NONE);
  assert.equal(r.isError, false);
  assert.match(r.text, /The user declined this step: click button "Delete"/);
  assert.match(r.text, /Do not try it another way/);
  const row = w.events.find((e) => e.type === 'act_step') as Extract<AgentEventBody, { type: 'act_step' }>;
  assert.equal(row.step.state, 'declined');
  assert.equal(row.step.text, 'not done · you declined: click button "Delete"');
});

test('then_wait runs only once every step has happened', async () => {
  const w = world();
  let waits = 0;
  w.deps.wait = async () => {
    waits++;
    return { matched: true, elapsedMs: 1, detail: 'there' };
  };
  const spec = { condition: { kind: 'text', text: 'done', gone: false }, timeoutMs: 1000 } as never;
  const r = await new Driver(w.deps).act({ steps: [click('A')], description: 'x', thenWait: spec }, { toolId: 't', history: [] }, NONE);
  assert.equal(waits, 1);
  assert.match(r.text, /then_wait:/);
});

test('the card holds what was recorded, and nothing when nothing was done', async () => {
  const w = world({ answers: [{ kind: 'done' }] });
  const d = new Driver(w.deps);
  assert.equal(await d.finish('model'), null);

  const w2 = world({
    read: (step) => ({ ok: true, described: button((step.target as { selector: string }).selector), signature: 'sig' }),
    perform: async (step) => ok(button('x'), step.do === 'click' ? { clicks: step.repeat ?? 1 } : {}),
    answers: [{ kind: 'allow' }, { kind: 'done' }],
  });
  const d2 = new Driver(w2.deps);
  await d2.runStep({ do: 'fill', target: { selector: 'Name' }, text: 'x' }, {}, NONE);
  await d2.runStep(click('Delete', { repeat: 3 }), {}, NONE);
  await d2.handoff('Sign in', null, NONE);
  assert.equal(await d2.beforeScript('tidy', 'code', NONE), true);
  await d2.afterScript();
  w2.time = 49_000;
  const card = (await d2.finish('stopped'))!;
  assert.equal(card.label, 'stopped by you · 4 actions');
  assert.equal(card.total, 4);
  assert.equal(card.where, 'shop.example.com · 1 page · 48s');
  assert.equal(card.counts, '3 clicks · 1 field · you allowed 1 · you did 1 yourself · 1 script ran');
  assert.equal(card.scripted, true);
  assert.deepEqual(card.actions, ['filled "Name"', 'clicked "Delete" ×3']);
  assert.equal(w2.log[w2.log.length - 1], 'bar:off', 'the bar comes down with the run');
});

test('a script with Ask before every step waits; declined, it writes no journal', async () => {
  const w = world({ askEvery: true, answers: [{ kind: 'decline' }, { kind: 'allow' }] });
  const d = new Driver(w.deps);
  assert.equal(await d.beforeScript('tidy', 'document.title = 1', NONE), false);
  assert.equal(w.questions[0]!.kind, 'script');
  assert.ok(!w.log.some((l) => l.startsWith('journal:')));
  assert.equal(await d.beforeScript('tidy', 'document.title = 1', NONE), true);
  assert.ok(w.log.includes('journal:script:run a script: tidy'));
});

test('a question the panel is not asked for is not an answer', () => {
  const allow: Question = { kind: 'allow', id: 'a', host: 'h', headline: 'x', firstOnSite: false };
  assert.equal(answerFits(allow, { kind: 'allow' }), true);
  assert.equal(answerFits(allow, { kind: 'allow', every: true }), false, '"every" that was not offered');
  assert.equal(answerFits(allow, { kind: 'allow', standing: true }), false, 'a standing allowance nobody asked about');
  assert.equal(answerFits(allow, { kind: 'done' }), false);
  const off: Question = { kind: 'left-site', id: 'b', from: 'a.com', to: 'evil.test', canContinue: false };
  assert.equal(answerFits(off, { kind: 'continue' }), false, 'a forged Continue onto an unrelated host');
  assert.equal(answerFits(off, { kind: 'back' }), true);
  const handoff: Question = { kind: 'handoff', id: 'c', text: 't' };
  assert.equal(answerFits(handoff, { kind: 'allow' }), false, 'I have done it is all a handoff takes');
});

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

test('act input is checked before anything happens', () => {
  const bad = (raw: Record<string, unknown>, re: RegExp) => {
    const r = parseActInput(raw);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, re);
  };
  const desc = { description: 'x' };
  bad({ ...desc }, /steps/);
  bad({ ...desc, steps: [] }, /steps/);
  bad({ ...desc, steps: Array(21).fill({ do: 'hover', target: 'a' }) }, /at most 20/);
  bad({ steps: [{ do: 'hover', target: 'a' }] }, /description/);
  bad({ ...desc, steps: [{ do: 'explode', target: 'a' }] }, /do must be one of/);
  bad({ ...desc, steps: [{ do: 'click' }] }, /needs a target/);
  bad({ ...desc, steps: [{ do: 'fill', target: 'a' }] }, /needs text/);
  bad({ ...desc, steps: [{ do: 'hover', target: 'a', repeat: 2 }] }, /only with click/);
  bad({ ...desc, steps: [{ do: 'click', target: 'a', repeat: 51 }] }, /1 to 50/);
  bad({ ...desc, steps: [{ do: 'hover', target: 'a' }], then_wait: { selector: 'a', url: 'b' } }, /then_wait/);
  const good = parseActInput({ ...desc, steps: [{ do: 'click', target: 'k3e14' }, { do: 'fill', target: '#a', text: 'b' }, { do: 'go', text: 'back' }, { do: 'press', text: 'Enter' }] });
  assert.ok(good.ok);
  assert.deepEqual(good.call.steps[0]!.target, { ref: 'k3e14' });
  assert.deepEqual(good.call.steps[1]!.target, { selector: '#a' });
  assert.equal(good.call.steps[2]!.target, undefined);
});

test('a target is a ref only when it reads as one', () => {
  assert.deepEqual(targetFrom(' k3e14 '), { ref: 'k3e14' });
  assert.deepEqual(targetFrom('.keep'), { selector: '.keep' });
});

test('known addresses are what the user typed and what was shown as a link', () => {
  const messages: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'go to https://shop.example.com/typed please' }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'x',
          content: [{ type: 'text', text: '- link "Next" [ref=k1e1] → /orders?page=2\n<a href="/about">about</a>' }],
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'I will go to https://shop.example.com/model-said' }] },
  ];
  const known = knownUrls(messages, PAGE);
  assert.ok(known.includes('https://shop.example.com/typed'));
  assert.ok(known.includes('https://shop.example.com/orders?page=2'));
  assert.ok(known.includes('https://shop.example.com/about'));
  assert.ok(!known.includes('https://shop.example.com/model-said'), 'the model saying an address does not make it known');
});

test('a resume is told the step may have happened, by name, and to look first', () => {
  const note = pendingResumeNote({ label: 'click button "Place order"' });
  assert.match(note, /click button "Place order"/);
  assert.match(note, /may or may not have happened/);
  assert.match(note, /Look at the page/);
});

// ---------- what a skill is made from ----------

test('the journal holds what was read and where the value is, never the value', async () => {
  const entries: Array<Record<string, unknown>> = [];
  const w = world({ read: () => ({ ok: true, described: button('Merchant', { role: 'textbox', fingerprint: { role: 'textbox', name: 'Merchant', tag: 'input', css: '#m', landmark: 'form "F"' } }), signature: 'sig' }) });
  w.deps.record = (e) => void entries.push(e as Record<string, unknown>);
  await new Driver(w.deps).act({ steps: [{ do: 'fill', target: { selector: '#m' }, text: 'TYPED-VALUE' }], description: 'enter it' }, { toolId: 'tool-1', history: [] }, new AbortController().signal);
  assert.equal(entries.length, 1);
  const e = entries[0]!;
  assert.equal(e.kind, 'act');
  assert.equal(e.role, 'textbox');
  assert.deepEqual(e.at, { css: '#m', in: 'form "F"' });
  assert.equal(e.why, 'enter it');
  assert.equal(e.toolId, 'tool-1');
  assert.equal(e.stepIndex, 0);
  assert.doesNotMatch(JSON.stringify(entries), /TYPED-VALUE/);
});

test('a declined step is journalled as dropped, and a run that has not touched the page records nothing', async () => {
  const entries: Array<Record<string, unknown>> = [];
  const w = world({ read: (s) => ({ ok: true, described: button(s.do === 'click' ? 'Delete' : 'Thing'), signature: 'sig' }), answers: [{ kind: 'decline' }] });
  w.deps.record = (e) => void entries.push(e as Record<string, unknown>);
  const d = new Driver(w.deps);
  await d.recordLook('h1', 1, false);
  assert.equal(entries.length, 0, 'a look before the first step is no part of a recording');
  await d.act({ steps: [{ do: 'hover', target: { selector: '#x' } }, { do: 'click', target: { selector: '#d' } }], description: 'try' }, { toolId: 't', history: [] }, new AbortController().signal);
  assert.deepEqual(entries.map((e) => e.kind), ['act', 'dropped']);
  await d.recordLook('h1', 1, false);
  assert.equal(entries.at(-1)!.kind, 'look');
});

test('the card offers SAVE AS SKILL for a run that acted, with the script note, and not for a run that did not', async () => {
  const w = world();
  const d = new Driver(w.deps);
  assert.equal(await d.finish('model'), null);
  const w2 = world();
  const d2 = new Driver(w2.deps);
  await d2.act({ steps: [{ do: 'click', target: { selector: '#x' } }], description: 'go' }, { toolId: 't', history: [] }, new AbortController().signal);
  await d2.beforeScript('tidy', 'code', new AbortController().signal);
  await d2.afterScript();
  const card = await d2.finish('model');
  assert.ok(card?.save?.run);
  assert.equal(card!.save!.note, 'this run used scripts; only its 1 act step can be saved');
});

test('a walked step asks from the live read, with the skill’s words labelled, and nothing happens first', async () => {
  const w = world({ answers: [{ kind: 'next' }] });
  const d = new Driver(w.deps);
  const outcome = await d.runStep({ do: 'click', target: { selector: 'Fine' } }, { skill: { name: 'S', n: 3, total: 7, says: 'do the thing' }, walk: { onRest: () => {} } }, new AbortController().signal);
  assert.equal(outcome.kind, 'done');
  const q = w.questions[0] as Extract<Question, { kind: 'walk' }>;
  assert.equal(q.kind, 'walk');
  assert.equal(q.headline, 'click button "Fine"');
  assert.equal(q.skillSays, 'do the thing');
  assert.ok(w.log.indexOf('ask:walk') < w.log.indexOf('perform:click'));
});

test('a lost answer clears the journal with the next step: a resume does not ask about what happened', async () => {
  const cleared: Array<number | undefined> = [];
  const w = world({ perform: async () => { throw new Error('the page went'); } });
  w.deps.journalClear = async (n) => void cleared.push(n);
  await new Driver(w.deps).runStep({ do: 'click', target: { selector: 'x' } }, { nextStep: 4 }, new AbortController().signal);
  assert.deepEqual(cleared, [4]);
  const failed = world({ perform: async () => ({ ok: false, code: 'hidden', message: 'no' }) as ActResult });
  const after: Array<number | undefined> = [];
  failed.deps.journalClear = async (n) => void after.push(n);
  await new Driver(failed.deps).runStep({ do: 'click', target: { selector: 'x' } }, { nextStep: 4 }, new AbortController().signal);
  assert.deepEqual(after, [undefined], 'a step that failed is still the step the run is on');
});

test('a question with no bar before it does not leave one saying usermods is waiting once it is answered', async () => {
  const w = world({ answers: [{ kind: 'decline' }] });
  const d = new Driver(w.deps);
  const answer = await d.ask({ kind: 'skill-ceiling', id: 'q', skill: 'S', actions: 1 }, new AbortController().signal);
  assert.ok(answer);
  assert.equal(d.barIsShowing, false, 'a screenshot would not hide it');
  assert.equal(w.log.at(-1), 'bar:off', 'the page is not left saying it');
});

test('a question over a bar that was up puts that bar back', async () => {
  const w = world({ answers: [{ kind: 'allow' }, { kind: 'carry-on' }], allowed: { site: true, actions: [] } });
  const d = new Driver(w.deps);
  const signal = new AbortController().signal;
  await d.runStep({ do: 'click', target: { selector: 'Thing' } }, {}, signal);
  w.log.length = 0;
  await d.ask({ kind: 'skill-ceiling', id: 'q', skill: 'S', actions: 1 }, signal);
  assert.ok(!w.log.includes('bar:off'));
  assert.match(w.log.at(-1)!, /^bar:usermods is driving/);
});
