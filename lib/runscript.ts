// Source-level preparation of the code run_script injects, and the reading of what comes back.
//
// Why a parser. The tool description promises "returns the value of the last expression", but the
// code is injected as the BODY of an async function, where only an explicit `return` yields a
// value. `1 + 1` and `document.querySelectorAll('.ad').forEach((e) => e.remove())` both reported
// `Result: undefined`, which the model cannot tell apart from a script that never ran — and that
// ambiguity is one reason it re-inspects the page instead of acting.
//
// We cannot fix this inside the page: the user-script world forbids eval and new Function, so the
// completion value cannot be recovered at runtime. But the code travels to the page as TEXT, so
// the background can rewrite it before injection: parse, and if the last statement is an
// expression statement, turn it into a `return`. Everything else (declarations, loops, an explicit
// return, top-level await) is left exactly as written.
//
// Nothing here touches a browser API, so it is all unit-testable under node.

import { parse, type Options } from 'acorn';

/** Acorn is called with the loosest settings that still accept a user-script body. */
const PARSE_OPTIONS: Options = {
  ecmaVersion: 'latest',
  // The code becomes an async function body, so top-level await and top-level return are legal
  // there even though they are not in a script. `allowAwaitOutsideFunction` covers await;
  // `allowReturnOutsideFunction` covers an explicit `return` the model wrote.
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: false,
  sourceType: 'script',
};

export interface PrepareOk {
  ok: true;
  /** The code to inject: identical to the input unless a trailing expression became a return. */
  code: string;
  /** True when a trailing expression statement was rewritten into `return`. */
  rewritten: boolean;
}

export interface PrepareError {
  ok: false;
  /** A message shaped for the model: what is wrong, and where. */
  message: string;
  line: number;
  column: number;
}

export type PrepareResult = PrepareOk | PrepareError;

interface AcornSyntaxError extends SyntaxError {
  pos?: number;
  loc?: { line: number; column: number };
}

/**
 * Parse `code` and, when its last statement is a bare expression, rewrite that statement into
 * `return <expr>;` so the injected async function body yields the completion value.
 *
 * The rewrite is textual and minimal — a `return ` inserted at the statement's start offset, and a
 * `;` appended if the statement had none — so line numbers before the last statement are
 * unchanged and every character the model wrote survives verbatim. That matters for FIX 2's stack
 * mapping, which assumes our transformation does not move earlier lines.
 */
export function prepareRunScript(code: string): PrepareResult {
  let program;
  try {
    program = parse(code, PARSE_OPTIONS);
  } catch (e) {
    const se = e as AcornSyntaxError;
    const line = se.loc?.line ?? 1;
    const column = (se.loc?.column ?? 0) + 1;
    // Acorn appends "(line:col)" to its message; drop it so we can state the position our way.
    const bare = String(se.message ?? e).replace(/\s*\(\d+:\d+\)\s*$/, '');
    return {
      ok: false,
      message: `Syntax error at line ${line}, column ${column}: ${bare}`,
      line,
      column,
    };
  }

  const body = program.body;
  const last = body[body.length - 1];
  if (!last || last.type !== 'ExpressionStatement') return { ok: true, code, rewritten: false };

  // `last.end` covers the statement including its semicolon when it has one. Anything after it is
  // trailing trivia (whitespace, a comment) and is kept, so the model's own comments survive.
  const before = code.slice(0, last.start);
  const stmt = code.slice(last.start, last.end);
  const after = code.slice(last.end);
  const needsSemi = !stmt.trimEnd().endsWith(';');
  return {
    ok: true,
    code: `${before}return ${stmt}${needsSemi ? ';' : ''}${after}`,
    rewritten: true,
  };
}

/** True when `code` parses as a user-script body. Used by propose_mod's static checks. */
export function parseError(code: string): PrepareError | null {
  const r = prepareRunScript(code);
  return r.ok ? null : r;
}

// ---------------------------------------------------------------------------
// Reading the result back
// ---------------------------------------------------------------------------

/** What the DOM did while the script ran, as counted by the wrapper's MutationObserver. */
export interface DomEffect {
  added: number;
  removed: number;
  attributes: number;
  /**
   * Which nodes, by name (lib/exec/wrap.ts `__name`: tag, then #id or up to two classes), with how
   * many of each. Attribute entries also carry the attribute names. At most 20 names per kind are
   * tallied in the page; nodes past that are still in the counts above.
   */
  targets?: {
    added: Array<[string, number]>;
    removed: Array<[string, number]>;
    attributes: Array<[string, string[], number]>;
  };
}

/**
 * An uncaught error or rejection from one of the script's own callbacks (a timer, an observer, a
 * listener), already described for the model: `TypeError: x is null (line 12)`.
 */
export interface CallbackError {
  text: string;
  count: number;
}

/**
 * How a run ended. The four outcomes are deliberately distinct, because "timed out" used to stand
 * in for all of them and told the model nothing it could act on.
 */
export type RunOutcome =
  | { kind: 'ok'; result?: string; returnedValue: boolean; dom?: DomEffect }
  | { kind: 'threw'; error: string }
  /** The page navigated or unloaded mid-run, so the wrapper's message never arrived. */
  | { kind: 'navigated'; url: string }
  /** userScripts.execute itself rejected — nothing ran. */
  | { kind: 'injection-failed'; reason: string }
  | { kind: 'timeout'; seconds: number };

export interface RunResult {
  outcome: RunOutcome;
  /** The last LOG_KEEP console lines. */
  logs: string[];
  /** How many console lines there were in all, when the wrapper said; more than logs.length means some were dropped. */
  logCount?: number;
  /** Uncaught errors from the script's callbacks while the run was being measured. */
  callbackErrors?: CallbackError[];
}

/** Names shown per kind in the DOM summary. Five, collapsed by name, is about 40 tokens at most. */
const DOM_NAMES_SHOWN = 5;

/**
 * ` (div.modal-backdrop, li ×12, +3 more)`, or '' when there is nothing to name. Most frequent
 * first; "+N more" counts the changes not covered by the names shown, so it stays true even when
 * the page tallied only the first 20 names.
 */
function namedTargets(entries: Array<[string, number]> | undefined, total: number, label: (e: [string, number], i: number) => string): string {
  if (!entries?.length || !total) return '';
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => b.e[1] - a.e[1] || a.i - b.i);
  const shown = sorted.slice(0, DOM_NAMES_SHOWN);
  const covered = shown.reduce((n, { e }) => n + e[1], 0);
  const parts = shown.map(({ e, i }) => label(e, i));
  if (total > covered) parts.push(`+${total - covered} more`);
  return ` (${parts.join(', ')})`;
}

/**
 * `2 removed (div.modal-backdrop, div#newsletter), 1 added (div.modal), 2 attributes changed
 * (body[class,style])`, or null when nothing moved.
 *
 * The names are what let the model see a site put back what its script removed: the same name under
 * "removed" and "added" in one run. Repeated names collapse into `name ×N`; attribute entries list
 * the attributes instead, since an element restyled sixty times is one fact, not sixty.
 */
export function formatDomEffect(dom: DomEffect | undefined): string | null {
  if (!dom) return null;
  if (!dom.added && !dom.removed && !dom.attributes) return null;
  const t = dom.targets;
  const nodes = (e: [string, number]) => (e[1] > 1 ? `${e[0]} ×${e[1]}` : e[0]);
  const attrs = t?.attributes ?? [];
  const removed = namedTargets(t?.removed, dom.removed, nodes);
  const added = namedTargets(t?.added, dom.added, nodes);
  const changed = namedTargets(
    attrs.map(([name, , n]) => [name, n]),
    dom.attributes,
    ([name], i) => (attrs[i]![1].length ? `${name}[${attrs[i]![1].join(',')}]` : name),
  );
  return `${dom.removed} removed${removed}, ${dom.added} added${added}, ${dom.attributes} attribute${dom.attributes === 1 ? '' : 's'} changed${changed}`;
}

/**
 * Trim a thrown stack down to the user's own frames and map its line numbers back to the code the
 * model wrote.
 *
 * The injected text is `<wrapper preamble>\n<the model's code>\n<wrapper epilogue>`, so a frame
 * reported at line L in the injected source is at line L - offset in the model's code. Frames
 * outside that range are wrapper internals and are dropped: showing them invites the model to
 * "fix" code it never wrote.
 */
export function mapStack(stack: string, codeLineOffset: number, codeLines: number): string {
  const lines = stack.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // The message line (no "at ") always survives.
    if (!/^\s*at\s/.test(line)) {
      out.push(line);
      continue;
    }
    const trimmed = line.trimEnd();
    const m = trimmed.match(/:(\d+):(\d+)(\)?)$/);
    if (!m) {
      out.push(trimmed);
      continue;
    }
    const mapped = Number(m[1]) - codeLineOffset;
    if (mapped < 1 || mapped > codeLines) continue; // a wrapper frame
    out.push(trimmed.slice(0, m.index) + `:${mapped}:${m[2]}${m[3]}`);
  }
  // Drop a trailing run of nothing so the output does not end in blank lines.
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out.join('\n');
}

/** Where a run's code sits in what was injected, so its frames can be mapped back. */
export interface RunSource {
  /** The run's `//# sourceURL` (lib/exec/wrap.ts). */
  sourceName: string;
  lineOffset: number;
  codeLines: number;
}

/** A callback error as the wrapper reports it, before it is described. */
export interface RawCallbackError {
  message?: unknown;
  stack?: unknown;
  count?: unknown;
}

/**
 * `TypeError: x is null (line 12)`: the message, and the first frame in the model's own code mapped
 * back to the line it wrote. Chrome writes frames as `at f (file:12:3)`, Safari as `f@file:12:3`;
 * both are matched by the file name. A frame outside the model's lines is the wrapper's, and is
 * skipped, as mapStack does.
 */
export function describeCallbackError(e: RawCallbackError, src: RunSource): CallbackError {
  const message = typeof e.message === 'string' && e.message ? e.message : 'Uncaught error';
  const stack = typeof e.stack === 'string' ? e.stack : '';
  const count = typeof e.count === 'number' && e.count > 0 ? e.count : 1;
  const escaped = src.sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let line: number | null = null;
  for (const m of stack.matchAll(new RegExp(`${escaped}:(\\d+):\\d+`, 'g'))) {
    const mapped = Number(m[1]) - src.lineOffset;
    if (mapped >= 1 && mapped <= src.codeLines) {
      line = mapped;
      break;
    }
  }
  return { text: line == null ? message : `${message} (line ${line})`, count };
}

/** Callback errors shown in one line; the rest are counted. */
const CALLBACK_ERRORS_SHOWN = 3;

/** `TypeError: x is null (line 12) ×40; Error: y (line 3); +2 more`. */
export function formatCallbackErrors(errors: CallbackError[]): string {
  const shown = errors.slice(0, CALLBACK_ERRORS_SHOWN).map((e) => (e.count > 1 ? `${e.text} ×${e.count}` : e.text));
  if (errors.length > CALLBACK_ERRORS_SHOWN) shown.push(`+${errors.length - CALLBACK_ERRORS_SHOWN} more`);
  return shown.join('; ');
}

// ---------------------------------------------------------------------------
// Late errors: thrown by a run's callbacks after the run reported
// ---------------------------------------------------------------------------

/** One buffered late error, with the run it came from. */
export interface LateError extends CallbackError {
  runId: string;
}

/** Distinct late errors kept per tab between tool results. */
export const LATE_KEEP = 5;

/**
 * Fold a late report into a tab's buffer. Each report counts only what happened since the page's
 * previous report, so a repeat adds to the count, and the count shown is what happened since the
 * model's last tool result. New errors past LATE_KEEP are dropped: five distinct failures are
 * already more than the model will fix in one step.
 */
export function mergeLateErrors(buffer: LateError[], runId: string, errors: CallbackError[]): LateError[] {
  const out = buffer.map((e) => ({ ...e }));
  for (const e of errors) {
    const same = out.find((b) => b.runId === runId && b.text === e.text);
    if (same) same.count += e.count;
    else if (out.length < LATE_KEEP) out.push({ runId, text: e.text, count: e.count });
  }
  return out;
}

/**
 * The line prepended to the next tool result for the tab, or null when there is nothing to say.
 * Line numbers are in the code of the run that threw; an error from a run before the latest one says
 * so, because "line 12" would otherwise be read against the script the model just wrote.
 */
export function renderLateErrors(buffer: LateError[], latestRunId: string | null): string | null {
  const errors = buffer.filter((e) => e.count > 0);
  if (!errors.length) return null;
  const described = errors.map((e) => ({ text: e.runId === latestRunId ? e.text : `${e.text} [earlier run]`, count: e.count }));
  return `[Uncaught in your run_script callbacks since the last result: ${formatCallbackErrors(described)}]`;
}

/** Render a finished run as the text the model sees. Pure, so the loop's wording is testable. */
export function renderRunResult(r: RunResult): { text: string; isError: boolean } {
  const lines: string[] = [];
  let isError = false;
  const o = r.outcome;
  switch (o.kind) {
    case 'ok': {
      if (o.returnedValue) lines.push(`Result: ${o.result}`);
      else lines.push('Completed. No return value.');
      const dom = formatDomEffect(o.dom);
      if (dom) lines[lines.length - 1] += ` DOM: ${dom}.`;
      else if (!o.returnedValue) lines[lines.length - 1] += ' DOM: nothing changed.';
      break;
    }
    case 'threw':
      lines.push(`Error: ${o.error}`);
      isError = true;
      break;
    case 'navigated':
      lines.push(
        `The page navigated to ${o.url} while the script was running; the script's result was lost. If you caused the navigation, that is expected — check the new page rather than re-running.`,
      );
      break;
    case 'injection-failed':
      lines.push(`The script could not be injected, so nothing ran: ${o.reason}`);
      isError = true;
      break;
    case 'timeout':
      lines.push(
        `No result after ${o.seconds}s; the script may still be running or is waiting on something. Nothing was rolled back — check the page state before running it again.`,
      );
      isError = true;
      break;
  }
  if (r.callbackErrors?.length) lines.push(`Uncaught in its callbacks: ${formatCallbackErrors(r.callbackErrors)}`);
  if (r.logs.length) {
    const kept = r.logs.slice(-50);
    const total = Math.max(r.logCount ?? 0, r.logs.length);
    lines.push(total > kept.length ? `Console (last ${kept.length} of ${total} lines):` : 'Console:', ...kept);
  }
  return { text: lines.join('\n'), isError };
}
