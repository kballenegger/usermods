// test_mod as the model reads it: what a run as the saved mod reports, and how the proposal gate
// recognises the code that was tested.
//
// "Tested" used to mean "some run_script succeeded", which is satisfied by `1 + 1`. A mod lives or
// dies on things run_script never exercises: its header (world, grants, @require), its @run-at on a
// fresh load, and whether the page puts back what it removed. test_mod runs exactly that, and the
// gate compares what it ran with what is proposed.
//
// Pure: no chrome APIs. Tested under node (test/testmod.test.ts).

import { renderRunResult, type RunResult } from '../runscript.ts';
import type { Mod } from '../types';

/** What the two-second re-check found (lib/exec/testrun.ts recorderCheck). */
export interface PersistReport {
  /** Changes the script made during its first, synchronous run. */
  changes: number;
  /** How many of those the page had undone by the re-check. */
  undone: number;
  /** A few of them, named by element, for the model to act on. */
  examples: string[];
}

export interface TestModResult {
  /** The tab was reloaded and the script ran at its own @run-at on the new document. */
  fresh: boolean;
  runAt: Mod['runAt'];
  world: Mod['world'];
  requires: number;
  run: RunResult;
  /** Absent when the run failed (nothing to re-check); null when the re-check itself failed. */
  persisted?: PersistReport | null;
  /** Anything that makes this run less than the saved mod's, said plainly. */
  notes?: string[];
}

/**
 * The script as the gate compares it: header block dropped (the draft keeps and re-attaches it, so
 * the model's copy may or may not carry one), line endings and trailing whitespace normalised, and
 * leading/trailing blank lines trimmed. Anything else is a real difference.
 */
export function sourceKey(code: string): string {
  return code
    .replace(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/** The first line: how faithful this run was. The rest is run_script's own report. */
function howItRan(r: TestModResult): string {
  const deps = r.requires ? ` with ${r.requires} @require file${r.requires === 1 ? '' : 's'}` : '';
  if (r.fresh) return `Ran as the saved mod: tab reloaded, script ran at ${r.runAt} in the ${r.world} world${deps}.`;
  return `Ran as the saved mod on the already-loaded page (no reload), in the ${r.world} world${deps}. Earlier runs' changes are still on it and ${r.runAt} on a fresh load was not exercised.`;
}

function persistenceLine(p: PersistReport | null | undefined): string | null {
  if (p === undefined) return null;
  if (p === null) return '2s later: could not re-check the page.';
  if (!p.changes) return '2s later: nothing to re-check (no immediate DOM change; later ones are not tracked).';
  if (!p.undone) return `2s later: all ${p.changes} change${p.changes === 1 ? '' : 's'} still in place.`;
  const which = p.examples.length ? ` (${p.examples.join('; ')})` : '';
  return `2s later: the page had undone ${p.undone} of ${p.changes} change${p.changes === 1 ? '' : 's'}${which}. Re-apply ${p.undone === 1 ? 'it' : 'them'}, e.g. from a debounced MutationObserver.`;
}

/** What the model is told. Error when the run itself failed, as for run_script. */
export function renderTestResult(r: TestModResult): { text: string; isError: boolean } {
  const run = renderRunResult(r.run);
  const lines = [howItRan(r), ...(r.notes ?? []), run.text];
  const p = persistenceLine(r.persisted);
  if (p) lines.push(p);
  return { text: lines.join('\n'), isError: run.isError };
}

/** The status-line text while a test runs. */
export function describeTest(input: Record<string, unknown>): string {
  return input.reload === true ? 'reloading to test as a saved mod' : 'testing as a saved mod';
}
