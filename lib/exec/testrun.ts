/**
 * test_mod's page-side half: the code strings that run a draft the way its saved mod would, and the
 * rules that keep a temporary registration from ever outliving the test that made it.
 *
 * Three things live here, all pure so node can check them (test/testmod.test.ts):
 *
 *  - **The reserved id and the cleanup rule.** A reload test on Chrome registers the draft with
 *    chrome.userScripts under an id starting TEST_RUN_PREFIX, reloads, and unregisters it. A leak
 *    would run an unsaved script on every visit, so there are three independent locks: the `finally`
 *    that unregisters, a sweep of every reserved id at worker start (a worker killed mid-test never
 *    reaches its `finally`), and `guardOnce`, which makes the registered code itself inert anywhere
 *    but the one tab and the one load it was armed for.
 *  - **The page-world report path.** A MAIN-world script (`@grant none`, `unsafeWindow`) has no
 *    `chrome.runtime`, so the one-off wrapper's result had nowhere to go and the run waited out its
 *    timeout. The wrapper's 'bridge' transport calls a `__usermodsReport` function in scope; in the
 *    page world that function fires a DOM event, and a relay in the isolated world forwards it.
 *  - **The recorder.** "Is the change still there two seconds later" needs to know what the change
 *    WAS. The recorder watches the DOM only while the script's synchronous first run executes, which
 *    is the one window in which no page script can interleave, so everything it sees is the mod's.
 *    The check, run later, asks whether the page put any of it back.
 */

import { modMatchesUrl, matchPatternForUrl } from '../mods.ts';
import type { Mod } from '../types';
import type { ExecEngine } from './engine.ts';
import { wrapForExecution, type ReportTransport } from './wrap.ts';

/** Every temporary registration's id starts with this; no saved mod's id can (they are UUIDs). */
export const TEST_RUN_PREFIX = 'usermods-test.';

/** How long an armed test may wait for its page load before the registered code refuses to run. */
export const TEST_RUN_TTL_MS = 60_000;

/** The sessionStorage key that marks the one tab a Chrome reload test is armed for. */
export const TEST_MARKER_KEY = 'usermods-test-run';

export const testRunId = (runId: string) => `${TEST_RUN_PREFIX}${runId}`;
export const isTestRunId = (id: string) => id.startsWith(TEST_RUN_PREFIX);

/**
 * Which registered ids must go: every reserved id that no test in this worker is running.
 *
 * At worker start `active` is empty, so everything reserved goes. That is the sweep that covers a
 * worker killed between register and unregister, which no `finally` can.
 */
export function testRunsToSweep(registered: readonly string[], active: ReadonlySet<string> = new Set()): string[] {
  return registered.filter((id) => isTestRunId(id) && !active.has(id));
}

/**
 * Chrome's lock on a registered test: run only in the tab carrying this run's marker, only once,
 * and only before `expiresAt`.
 *
 * chrome.userScripts cannot target a tab, so the registration matches every page the mod does. The
 * marker is set in sessionStorage, which belongs to one tab (and survives its reload), and the code
 * removes it as it runs. Any other tab, a second load, or a registration that somehow leaked finds
 * no marker and does nothing. Kept to the first line so the wrapper's line offset still holds.
 */
export function guardOnce(code: string, runId: string, expiresAt: number): string {
  const key = JSON.stringify(TEST_MARKER_KEY);
  return `(() => { let __go = false; try { __go = Date.now() < ${expiresAt} && sessionStorage.getItem(${key}) === ${JSON.stringify(runId)}; if (__go) sessionStorage.removeItem(${key}); } catch (e) {} if (!__go) return; ${code}\n})();`;
}

/** Code that arms the current document's tab for `runId`. Run in the tab before it reloads. */
export function markerCode(runId: string): string {
  return `sessionStorage.setItem(${JSON.stringify(TEST_MARKER_KEY)}, ${JSON.stringify(runId)}); 'armed';`;
}

/** Code that disarms the tab, for a test that ended without its load consuming the marker. */
export function unmarkerCode(runId: string): string {
  const key = JSON.stringify(TEST_MARKER_KEY);
  return `try { if (sessionStorage.getItem(${key}) === ${JSON.stringify(runId)}) sessionStorage.removeItem(${key}); } catch (e) {} 'disarmed';`;
}

// ---------------------------------------------------------------------------
// Where the saved mod would run
// ---------------------------------------------------------------------------

/**
 * Would this engine run the mod on `url`? Asked before a test, so the model is told when the saved
 * mod would NOT run on the page it is testing on, rather than a test quietly proving nothing.
 *
 * Each engine's own answer. The content-script engine matches with lib/mods modMatchesUrl, so that
 * is the truth there. Chrome's matcher differs in two ways that matter here: `*.example.com` also
 * covers the bare `example.com` (modMatchesUrl deliberately does not; see test/editmod.test.ts),
 * and a pattern without a port matches every port. Every draft-less test relies on both.
 */
export function engineRunsModOn(mod: Pick<Mod, 'matches' | 'includeGlobs' | 'excludeMatches' | 'excludeGlobs'>, url: string, engine: ExecEngine): boolean {
  if (modMatchesUrl(mod as Mod, url)) return true;
  if (engine !== 'user-scripts') return false;
  const bare = (ps: string[]) => ps.flatMap((p) => [p, p.replace(/^([^:]+:\/\/)\*\./, '$1')]);
  let portless = url;
  try {
    const u = new URL(url);
    u.port = '';
    portless = u.href;
  } catch {
    /* not a URL; matched as given */
  }
  return modMatchesUrl({ ...mod, matches: bare(mod.matches), excludeMatches: bare(mod.excludeMatches) } as Mod, portless);
}

/**
 * Patterns that cover this page, for testing a draft whose own patterns do not: the site-wide
 * pattern a new draft defaults to, plus the exact host. Chrome refuses a port in a registered
 * pattern (and ignores the port when matching), while the content-script matcher compares the host
 * text literally and so needs it.
 */
export function patternsForPage(url: string, engine: ExecEngine): string[] {
  const site = matchPatternForUrl(url);
  try {
    const u = new URL(url);
    const exact = `*://${engine === 'user-scripts' ? u.hostname : u.host}/*`;
    return exact === site ? [site] : [site, exact];
  } catch {
    return [site];
  }
}

// ---------------------------------------------------------------------------
// Page-world reporting
// ---------------------------------------------------------------------------

export const reportEvent = (runId: string) => `usermods-run-${runId}`;

/**
 * Wrap already-wrapped (transport 'bridge') code so that, in the page world, its report becomes a
 * DOM event. One line of prefix, so line numbers in a thrown stack are unchanged.
 */
export function inPageWorld(wrapped: string, runId: string): string {
  return `{ const __usermodsReport = (m) => { try { document.dispatchEvent(new CustomEvent(${JSON.stringify(reportEvent(runId))}, { detail: JSON.stringify(m) })); } catch (e) {} }; ${wrapped}\n}`;
}

/**
 * The isolated-world half: hear the page-world event once and pass it on the way this engine
 * reports a run. Only strings cross between worlds, which is why the detail is JSON.
 */
export function relayCode(runId: string, transport: ReportTransport): string {
  const send = transport === 'bridge' ? '__usermodsReport(m)' : 'chrome.runtime.sendMessage(m)';
  return `document.addEventListener(${JSON.stringify(reportEvent(runId))}, (e) => { try { const m = JSON.parse(e.detail); ${send}; } catch (err) {} }, { once: true });`;
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/*
 * The three functions below are injected as SOURCE (Function.prototype.toString), so each must be
 * self-contained: no imports, no module-level names, no helpers. The parameters are typed `any`
 * because they are page objects this file cannot describe, and the types vanish in the injected
 * text either way.
 */

/** Start watching. Returns null where there is nothing to watch (no documentElement yet). */
function recorderStart(): any {
  try {
    const records: any[] = [];
    const obs = new MutationObserver((r) => {
      for (const x of r) records.push(x);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true });
    return { obs, records };
  } catch (e) {
    return null;
  }
}

/**
 * Stop watching and keep what the script changed, as element signatures (for removed nodes, which
 * the page may re-create as new nodes) and node references (for added nodes and attribute edits).
 * Net-zero edits and nodes that only moved are dropped; each list is capped.
 */
function recorderSeal(rec: any, key: string): void {
  if (!rec) return;
  let records: any[];
  try {
    records = rec.records.concat(rec.obs.takeRecords());
    rec.obs.disconnect();
  } catch (e) {
    return;
  }
  const sig = (el: any) => {
    let sel = el.localName || 'node';
    try {
      if (el.id) sel += '#' + CSS.escape(el.id);
      else if (el.classList && el.classList.length) sel += Array.from(el.classList as string[]).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
    } catch (e) {}
    return { sel, text: String(el.textContent || '').trim().slice(0, 60) };
  };
  const removed: any[] = [];
  const added: any[] = [];
  const addedSet = new Set();
  const firstOld = new Map();
  for (const r of records) {
    if (r.type === 'childList') {
      for (const n of r.removedNodes) if (n.nodeType === 1 && !n.isConnected && removed.length < 30) removed.push(sig(n));
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.isConnected && !addedSet.has(n) && added.length < 30) {
          addedSet.add(n);
          added.push({ node: n, ...sig(n) });
        }
      }
    } else if (r.type === 'attributes' && r.target.nodeType === 1) {
      let byName = firstOld.get(r.target);
      if (!byName) firstOld.set(r.target, (byName = new Map()));
      if (!byName.has(r.attributeName)) byName.set(r.attributeName, r.oldValue);
    }
  }
  const attrs: any[] = [];
  for (const [node, byName] of firstOld) {
    if (addedSet.has(node) || !node.isConnected) continue;
    for (const [name, old] of byName) {
      const now = node.getAttribute(name);
      if (now !== old && attrs.length < 30) attrs.push({ node, name, value: now, ...sig(node) });
    }
  }
  (globalThis as any)[key] = { removed, added, attrs };
}

/** Later: how much of what was sealed has the page put back. Returns a plain object. */
function recorderCheck(key: string): any {
  const s = (globalThis as any)[key];
  if (!s) return { missing: true };
  try {
    delete (globalThis as any)[key];
  } catch (e) {}
  const shown = (el: any) => {
    try {
      return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : el.getClientRects().length > 0;
    } catch (e) {
      return true;
    }
  };
  const back = (r: any) => {
    try {
      return Array.from(document.querySelectorAll(r.sel)).some((el) => shown(el) && String(el.textContent || '').trim().slice(0, 60) === r.text);
    } catch (e) {
      return false;
    }
  };
  const undone: string[] = [];
  for (const r of s.removed) if (back(r)) undone.push(r.sel + ' is back');
  for (const a of s.added) if (!a.node.isConnected) undone.push('the added ' + a.sel + ' was removed');
  for (const t of s.attrs) {
    if (!t.node.isConnected) {
      if (back(t)) undone.push(t.sel + ' was re-rendered without the change');
    } else if (t.node.getAttribute(t.name) !== t.value) undone.push(t.name + ' on ' + t.sel + ' was reset');
  }
  return { changes: s.removed.length + s.added.length + s.attrs.length, undone: undone.length, examples: undone.slice(0, 3) };
}

export const recorderKey = (runId: string) => `__usermodsTest_${runId.replace(/[^\w]/g, '')}`;

/**
 * Everything a test injects, before the one-off wrapper goes around it: the recorder, then the mod's
 * registered code (GM shim, @require units, body), then the seal, which runs even if the mod threw.
 */
export function withRecorder(registered: string, key: string): string {
  return `const __umRec = (${recorderStart.toString()})();\ntry {\n${registered}\n} finally { (${recorderSeal.toString()})(__umRec, ${JSON.stringify(key)}); }`;
}

/** The code that answers "is it still there", as a one-off run's return value. */
export function checkCode(key: string): string {
  return `return (${recorderCheck.toString()})(${JSON.stringify(key)});`;
}

/** What a test run's code is, plus what mapStack needs to report a throw at the model's own line. */
export interface ComposedTest {
  code: string;
  /** Subtract from a stack line in the injected code to get the line in the script body. */
  lineOffset: number;
  bodyLines: number;
  /** The run's `//# sourceURL`, which names its frames in a stack (lib/exec/wrap.ts). */
  sourceName: string;
}

/**
 * The whole injected text for a test run, and how to map a thrown line back to the body.
 *
 * `registered` is the engine's registered code for the mod (lib/gm.ts buildRegisteredCode), which
 * contains the body verbatim after its header. The body is found by its LAST occurrence, because
 * the body unit is evaluated after every @require unit.
 */
export function composeTest(registered: string, body: string, runId: string, transport: ReportTransport, world: 'USER_SCRIPT' | 'MAIN'): ComposedTest {
  const inner = withRecorder(registered, recorderKey(runId));
  const trimmed = body.trim();
  const at = trimmed ? inner.lastIndexOf(trimmed) : -1;
  const bodyStartLine = at < 0 ? 1 : inner.slice(0, at).split('\n').length;
  // A page-world script reports through the DOM-event bridge, whatever this engine's own transport.
  const pageWorld = world === 'MAIN';
  const { wrapped, lineOffset, sourceName } = wrapForExecution(inner, runId, pageWorld ? 'bridge' : transport);
  return {
    code: pageWorld ? inPageWorld(wrapped, runId) : wrapped,
    lineOffset: lineOffset + bodyStartLine - 1,
    bodyLines: trimmed ? trimmed.split('\n').length : 0,
    sourceName,
  };
}
