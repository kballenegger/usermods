// The context budget field: what a typed number becomes, and WHEN that rule is allowed to run.
//   npm test
//
// User report: "The context number inside the settings is a bit bugged. You have a minimum default
// but when I'm editing, it enforces it so it's a bit tricky for me to change the context window
// limit."
//
// The rule itself was never wrong — a floor of 10,000 is right, since below it compaction's own
// summary plus the turns it keeps is already most of the budget. What was wrong is that it ran on
// every keystroke, inside onChange, so it clamped the PREFIXES of the number being typed. These
// tests pin both halves: the rule (commitContextBudget), and the fact that the screen applies it on
// commit rather than on change.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MIN_CONTEXT_BUDGET, commitContextBudget } from '../lib/settings.ts';
import { DEFAULT_CONTEXT_BUDGET } from '../lib/types.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('a number at or above the floor is stored as typed', () => {
  assert.equal(commitContextBudget('50000'), 50_000);
  assert.equal(commitContextBudget('10000'), MIN_CONTEXT_BUDGET);
  assert.equal(commitContextBudget('200000'), 200_000);
});

test('a number below the floor is raised to it — once the user has finished typing it', () => {
  // The clamp is still the rule. It is only ever applied to a number the user is done with.
  assert.equal(commitContextBudget('500'), MIN_CONTEXT_BUDGET);
  assert.equal(commitContextBudget('0'), MIN_CONTEXT_BUDGET);
  assert.equal(commitContextBudget('-4000'), MIN_CONTEXT_BUDGET);
});

test('an empty field asks for the default back, not for zero', () => {
  // Selecting everything and deleting it is how someone says "never mind". Reading that as 0 and
  // then clamping to the floor would silently store a budget they did not ask for.
  assert.equal(commitContextBudget(''), DEFAULT_CONTEXT_BUDGET);
  assert.equal(commitContextBudget('   '), DEFAULT_CONTEXT_BUDGET);
});

test('text that is not a number keeps whatever was already stored', () => {
  // A number input can still hand over '' or a lone '-' mid-edit on some browsers, and a paste can
  // put anything in it. None of those is a budget, so none of them changes one.
  assert.equal(commitContextBudget('abc', 64_000), 64_000);
  assert.equal(commitContextBudget('-', 64_000), 64_000);
  assert.equal(commitContextBudget('NaN', 64_000), 64_000);
});

test('a fractional budget is rounded rather than stored as a fraction', () => {
  assert.equal(commitContextBudget('50000.6'), 50_001);
  assert.equal(commitContextBudget('1e5'), 100_000);
});

// ---------------------------------------------------------------------------
// The report itself: every prefix of a number you are typing
// ---------------------------------------------------------------------------

test('typing 50000 one key at a time never rewrites the field under the cursor', () => {
  // THE BUG, as a test. The old field clamped inside onChange, so to reach 50000 the user typed
  // "5" — which became 10000 — and from there every further keystroke appended to the wrong
  // number. The prefixes are exactly what must NOT be clamped; only the final value is.
  const typed = '50000';
  const prefixes = Array.from({ length: typed.length }, (_, i) => typed.slice(0, i + 1));
  assert.deepEqual(prefixes, ['5', '50', '500', '5000', '50000']);

  // What the OLD code did to each prefix, for the record: four of the five were rewritten.
  const oldBehaviour = prefixes.map((p) => Math.max(10_000, Number(p) || DEFAULT_CONTEXT_BUDGET));
  assert.deepEqual(oldBehaviour, [10_000, 10_000, 10_000, 10_000, 50_000]);

  // The new field commits once, at the end, and gets what the user typed.
  assert.equal(commitContextBudget(typed), 50_000);
});

test('the same holds for a budget the user means to be below the floor', () => {
  // Someone typing 8000 is told the floor exists by getting 10000, once, when they are done — not
  // by having the field jump while they are still typing.
  assert.equal(commitContextBudget('8000'), MIN_CONTEXT_BUDGET);
});

// ---------------------------------------------------------------------------
// Where the rule is allowed to run
// ---------------------------------------------------------------------------
//
// The rule being correct is not the fix; the fix is that the screen stopped applying it on every
// keystroke. A unit test of the pure function cannot see that, and the regression would be one
// careless edit away — so the shape of the field is pinned here too.

test('the Settings field commits the budget on blur, not on change', () => {
  const src = fs.readFileSync(path.join(ROOT, 'entrypoints', 'sidepanel', 'SettingsView.tsx'), 'utf8');
  const field = src.slice(src.indexOf('Context budget (tokens)'), src.indexOf('Side panel opens'));
  assert.ok(field.includes('onBlur={commitBudget}'), 'the context budget must be committed on blur');
  assert.ok(/onChange=\{\(e\) => setBudget\(e\.target\.value\)\}/.test(field), 'onChange must only record the text');
  assert.equal(
    /onChange=\{[^}]*Math\.max/.test(field),
    false,
    'the floor is being applied inside onChange again — that is the bug the user reported',
  );
  assert.equal(
    /onChange=\{[^}]*contextBudget/.test(field),
    false,
    'onChange must not write contextBudget; a half-typed number is not a value to store',
  );
});

test('the floor the screen shows is the floor the rule applies', () => {
  // The help text names a number. If the two ever drift, the screen is lying about what it will do.
  const src = fs.readFileSync(path.join(ROOT, 'entrypoints', 'sidepanel', 'SettingsView.tsx'), 'utf8');
  assert.ok(src.includes('MIN_CONTEXT_BUDGET'), 'the field should state the floor from the constant, not a literal');
  assert.equal(MIN_CONTEXT_BUDGET.toLocaleString('en-US'), '10,000');
});
