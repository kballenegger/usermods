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
  logs: string[];
}

/** `14 removed, 0 added, 2 attributes changed`, or null when nothing moved. */
export function formatDomEffect(dom: DomEffect | undefined): string | null {
  if (!dom) return null;
  if (!dom.added && !dom.removed && !dom.attributes) return null;
  return `${dom.removed} removed, ${dom.added} added, ${dom.attributes} attribute${dom.attributes === 1 ? '' : 's'} changed`;
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
  if (r.logs.length) lines.push('Console:', ...r.logs.slice(-50));
  return { text: lines.join('\n'), isError };
}
