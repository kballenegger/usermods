// The draft mod a chat is building — its "artifact".
//
// A chat used to produce a sequence of proposals and nothing that tied them together. Every
// propose_mod put a fresh card in the transcript, the user scrolled back to find the last one, and
// saving each card minted (or, with findByName, guessed at) a mod. Three things were missing: a
// single place that says what the draft IS right now, a history of how it got there, and a link
// from the draft to the mod it became.
//
// That is what an artifact is: one draft per chat, versioned. Each accepted proposal appends a
// version; a rollback appends the old code as a NEW version rather than truncating, so the history
// is append-only and nothing the model wrote is ever lost. `current` says which version is the
// draft right now, and `linkedModId` remembers the mod a save created so the next save updates it
// in place instead of leaving a second copy behind.
//
// Everything here is pure except the storage helpers at the bottom, so the version rules, the diff
// and the round trip through buildSource are all testable under `npm test` with no browser.
//
// The .ts extensions on the two imports below are load-bearing: these are VALUE imports (buildSource
// and parseHeader are called), and `npm test` runs this through node --experimental-strip-types,
// whose ESM resolver does not guess extensions. See the same note at the top of lib/transcript.ts.
import { buildSource, parseHeader } from './mods.ts';
import type { Mod, ModProposal } from './types';

/** Where a chat's artifact lives in chrome.storage.local. */
export const artifactKey = (chatId: string) => `chat:${chatId}:artifact`;

/**
 * Why a version exists. Kept on the version rather than derived, because the transcript is not a
 * reliable witness: a rollback leaves no proposal card, and a user edit leaves nothing at all.
 */
export type VersionSource = 'proposal' | 'rollback' | 'user-edit';

/** One version of the draft: the complete script, not a patch. */
export interface ArtifactVersion {
  /** 1-based, and never reused. The version strip reads these. */
  n: number;
  /** Script body without the userscript header, exactly as a proposal carries it. */
  code: string;
  name: string;
  description: string;
  matches: string[];
  createdAt: number;
  source: VersionSource;
  /** The proposal this version came from, for 'proposal' versions. */
  proposalId?: string;
}

/**
 * A chat's draft mod. `name`, `description` and `matches` at the top level are the CURRENT
 * version's, mirrored so a reader (the collapsed bar, the dashboard badge) does not have to walk
 * the version list to render one line.
 */
export interface Artifact {
  id: string;
  chatId: string;
  name: string;
  description: string;
  matches: string[];
  versions: ArtifactVersion[];
  /** The `n` of the version that is the draft right now. */
  current: number;
  /** The mod a Save created, so a later Save updates that mod rather than making another. */
  linkedModId?: string;
  /** Carried from the proposal that is current, so the panel can repeat the model's caveat. */
  untestedReason?: string;
}

/** The current version, or undefined for an artifact with no versions (which should not exist). */
export function currentVersion(a: Artifact): ArtifactVersion | undefined {
  return a.versions.find((v) => v.n === a.current) ?? a.versions[a.versions.length - 1];
}

/** How many lines the current draft runs to — what the collapsed bar counts. */
export function lineCount(code: string): number {
  if (!code) return 0;
  return code.replace(/\n+$/, '').split('\n').length;
}

/**
 * What a version contributes, for the dedupe test. Two consecutive versions that agree on all four
 * of these are the same draft, whatever else moved.
 */
function sameDraft(a: Pick<ArtifactVersion, 'code' | 'name' | 'description' | 'matches'>, b: Pick<ArtifactVersion, 'code' | 'name' | 'description' | 'matches'>): boolean {
  return (
    a.code === b.code &&
    a.name === b.name &&
    a.description === b.description &&
    a.matches.length === b.matches.length &&
    a.matches.every((m, i) => m === b.matches[i])
  );
}

/** What a new version is made of. `n` and `createdAt` are assigned by addVersion. */
export interface NewVersion {
  code: string;
  name: string;
  description: string;
  matches: string[];
  source: VersionSource;
  proposalId?: string;
  /** Set on a proposal the model could not test; cleared by any version that is testable. */
  untestedReason?: string;
}

/**
 * Append a version and make it current.
 *
 * A version identical to the one that is already current is dropped: the model re-proposing the
 * same script after a "no, leave it" is not a new draft, and a version strip that grows a step
 * every time nothing happened is noise. Only the CONSECUTIVE case is deduped — v1 → v2 → v1 is
 * three real versions, because getting back to v1 is a thing the user did and the history should
 * say so.
 *
 * Returns a new artifact; the input is never mutated.
 */
export function addVersion(a: Artifact, v: NewVersion, at = Date.now()): Artifact {
  const current = currentVersion(a);
  if (current && sameDraft(current, v)) {
    // Nothing changed, but the caveat might have: a re-proposal that now says it was tested should
    // stop showing "not tested on this page" without inventing a version for it.
    return a.untestedReason === v.untestedReason ? a : { ...a, untestedReason: v.untestedReason };
  }
  const n = a.versions.reduce((max, x) => Math.max(max, x.n), 0) + 1;
  const version: ArtifactVersion = {
    n,
    code: v.code,
    name: v.name,
    description: v.description,
    matches: [...v.matches],
    createdAt: at,
    source: v.source,
    ...(v.proposalId ? { proposalId: v.proposalId } : {}),
  };
  return {
    ...a,
    name: v.name,
    description: v.description,
    matches: [...v.matches],
    versions: [...a.versions, version],
    current: n,
    untestedReason: v.untestedReason,
  };
}

/**
 * Roll back to version `n` by APPENDING its content as a new version, not by moving a pointer.
 *
 * Appending is the whole design. A pointer that walks backwards makes the versions after it
 * ambiguous — are they still the future, or were they abandoned? — and a later proposal would have
 * to decide whether to overwrite them. An append says exactly one thing: the draft is this code
 * again, as of now, and everything that ever was is still readable. It is also what makes rollback
 * itself undoable, by rolling back again.
 *
 * Returns the artifact unchanged when `n` does not exist or is already current.
 */
export function rollbackTo(a: Artifact, n: number, at = Date.now()): Artifact {
  const target = a.versions.find((v) => v.n === n);
  if (!target || n === a.current) return a;
  return addVersion(
    a,
    {
      code: target.code,
      name: target.name,
      description: target.description,
      matches: target.matches,
      source: 'rollback',
      // A rollback is the user choosing a script they have already seen; whatever caveat the model
      // attached to the version being restored travels back with it.
      ...(untestedOf(a, n) ? { untestedReason: untestedOf(a, n) } : {}),
    },
    at,
  );
}

/**
 * The caveat that belonged to version `n`, if the artifact was carrying one when that version was
 * current. Only the latest untestedReason is stored (it is a property of the draft, not of the
 * history), so this can answer only for the current version; older ones come back undefined, which
 * is the safe direction — a restored script is not claimed to be tested.
 */
function untestedOf(a: Artifact, n: number): string | undefined {
  return n === a.current ? a.untestedReason : undefined;
}

/** A brand-new artifact for a chat, holding its first version. */
export function createArtifact(chatId: string, v: NewVersion, at = Date.now(), id: string = crypto.randomUUID()): Artifact {
  const empty: Artifact = { id, chatId, name: '', description: '', matches: [], versions: [], current: 0 };
  return addVersion(empty, v, at);
}

/** The current draft as a full userscript, header and all — what Try, Save and Export use. */
export function toSource(a: Artifact): string {
  const v = currentVersion(a);
  if (!v) return '';
  return buildSource({ name: v.name, description: v.description, matches: v.matches, code: v.code });
}

/** The current draft as a proposal, for the paths that already speak ModProposal (Try, Save). */
export function toProposal(a: Artifact): ModProposal | null {
  const v = currentVersion(a);
  if (!v) return null;
  return {
    name: v.name,
    description: v.description,
    matches: [...v.matches],
    code: v.code,
    ...(a.untestedReason ? { untestedReason: a.untestedReason } : {}),
  };
}

/**
 * An artifact seeded from a saved mod, already linked to it. This is how a chat that starts from an
 * existing mod ("change this one") gets a draft whose first version is what is installed, rather
 * than a draft that begins at the model's first rewrite.
 *
 * The body comes from the mod's source with its header stripped by the same parser the rest of the
 * product uses, so a mod written by hand and a mod written in chat both arrive here as a body plus
 * the header fields, and a later save re-emits a header the same way.
 */
export function fromMod(chatId: string, mod: Mod, at = Date.now(), id: string = crypto.randomUUID()): Artifact {
  const header = parseHeader(mod.source);
  const a = createArtifact(
    chatId,
    {
      code: stripHeaderBody(mod.source),
      name: header.name || mod.name,
      description: header.description || mod.description,
      matches: mod.matches.length ? [...mod.matches] : [...header.matches],
      source: 'user-edit',
    },
    at,
    id,
  );
  return { ...a, linkedModId: mod.id };
}

/**
 * The script body of a source, without its ==UserScript== block. lib/mods exports stripHeader, but
 * importing it here would pull a second value import into the node test path for no gain — this is
 * the same regex and it is the only other place that needs it.
 */
function stripHeaderBody(source: string): string {
  return source.replace(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/, '').trim();
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** One unified-diff hunk: where it starts in each file, how long it is, and its lines. */
export interface DiffHunk {
  /** 1-based start line in the old text, and how many of its lines this hunk covers. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines with their leading ' ', '-' or '+', ready to render one per row. */
  lines: string[];
}

/**
 * A line-based diff, as unified hunks with `context` lines of context.
 *
 * This is a hand-rolled LCS rather than a dependency, for two reasons that both matter here: the
 * extension ships to a store and every kilobyte of bundle is reviewed, and the inputs are userscript
 * bodies — hundreds of lines, not the hundred-thousand-line files that make an O(n·m) table a
 * problem. The table is capped below all the same, because a model can propose anything.
 *
 * Returns an empty array when the two texts are identical, which is what the panel reads as "no
 * change" rather than rendering an empty diff view.
 */
export function diffLines(a: string, b: string, context = 3): DiffHunk[] {
  const A = splitLines(a);
  const B = splitLines(b);
  const ops = lcsOps(A, B);
  if (!ops.some((o) => o.kind !== 'same')) return [];

  // Walk the op list, grouping runs of changes with `context` unchanged lines on each side. Two
  // changes closer together than 2*context share a hunk, exactly as `diff -u` does it.
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === 'same') {
      i++;
      continue;
    }
    // Reach backwards for context, then forwards to the end of this hunk.
    let start = i;
    let ctx = 0;
    while (start > 0 && ops[start - 1]!.kind === 'same' && ctx < context) {
      start--;
      ctx++;
    }
    let end = i; // exclusive-ish: advanced below
    let run = 0;
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.kind === 'same') {
        run++;
        // Two full context blocks of unchanged lines close the hunk; anything less is swallowed.
        if (run > context * 2) break;
      } else {
        run = 0;
        end = j;
      }
    }
    let stop = Math.min(ops.length - 1, end + context);
    // Trim any trailing context beyond what we promised.
    while (stop > end && ops[stop]!.kind !== 'same') stop--;

    const slice = ops.slice(start, stop + 1);
    const oldStart = slice.find((o) => o.kind !== 'add')?.oldLine ?? countBefore(ops, start, 'old') + 1;
    const newStart = slice.find((o) => o.kind !== 'del')?.newLine ?? countBefore(ops, start, 'new') + 1;
    hunks.push({
      oldStart,
      oldLines: slice.filter((o) => o.kind !== 'add').length,
      newStart,
      newLines: slice.filter((o) => o.kind !== 'del').length,
      lines: slice.map((o) => `${o.kind === 'same' ? ' ' : o.kind === 'del' ? '-' : '+'}${o.text}`),
    });
    i = stop + 1;
  }
  return hunks;
}

/** The hunks rendered as unified-diff text, `@@` headers and all. What the tests snapshot. */
export function diffText(a: string, b: string, context = 3): string {
  const hunks = diffLines(a, b, context);
  if (!hunks.length) return '';
  return hunks
    .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
    .join('\n');
}

/** How many lines of one side precede index `at` in the op list. */
function countBefore(ops: DiffOp[], at: number, side: 'old' | 'new'): number {
  let n = 0;
  for (let i = 0; i < at; i++) {
    const o = ops[i]!;
    if (side === 'old' && o.kind !== 'add') n++;
    if (side === 'new' && o.kind !== 'del') n++;
  }
  return n;
}

/** Whether a diff found anything, without building the hunks. */
export function hasChanges(a: string, b: string): boolean {
  return a !== b;
}

interface DiffOp {
  kind: 'same' | 'del' | 'add';
  text: string;
  /** 1-based line number on each side; undefined on the side the line is absent from. */
  oldLine?: number;
  newLine?: number;
}

/** A trailing newline should not read as an extra empty line on both sides. */
function splitLines(s: string): string[] {
  const t = s.replace(/\n$/, '');
  return t === '' ? [] : t.split('\n');
}

/**
 * How large an LCS table this will build. 4000x4000 is 16M cells of Int32, ~64MB, which is already
 * far beyond any userscript; past it the diff degrades to "everything was replaced", which is both
 * honest and instant.
 */
const LCS_CAP = 4000;

/** The edit script from A to B, as a flat list of same/del/add ops in output order. */
function lcsOps(A: string[], B: string[]): DiffOp[] {
  if (A.length > LCS_CAP || B.length > LCS_CAP) {
    return [
      ...A.map((text, i) => ({ kind: 'del' as const, text, oldLine: i + 1 })),
      ...B.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })),
    ];
  }
  // Trim the common head and tail first. Two versions of a script usually differ in a handful of
  // lines in the middle, so this is what keeps the table small in the case that actually happens.
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;

  const midA = A.slice(head, A.length - tail);
  const midB = B.slice(head, B.length - tail);

  const n = midA.length;
  const m = midB.length;
  // Classic LCS length table; (n+1)*(m+1) Int32s.
  const table = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = midA[i] === midB[j] ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }

  const ops: DiffOp[] = [];
  for (let k = 0; k < head; k++) ops.push({ kind: 'same', text: A[k]!, oldLine: k + 1, newLine: k + 1 });

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ kind: 'same', text: midA[i]!, oldLine: head + i + 1, newLine: head + j + 1 });
      i++;
      j++;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) {
      ops.push({ kind: 'del', text: midA[i]!, oldLine: head + i + 1 });
      i++;
    } else {
      ops.push({ kind: 'add', text: midB[j]!, newLine: head + j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: midA[i]!, oldLine: head + i + 1 });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: midB[j]!, newLine: head + j + 1 });
    j++;
  }

  for (let k = 0; k < tail; k++) {
    const oi = A.length - tail + k;
    const bi = B.length - tail + k;
    ops.push({ kind: 'same', text: A[oi]!, oldLine: oi + 1, newLine: bi + 1 });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// The draft block the model is shown
// ---------------------------------------------------------------------------

/**
 * The header line that opens the draft block, e.g.
 *   [Current draft mod v3 "Wikipedia: full-width article" · matches *://*.wikipedia.org/wiki/* · 42 lines]
 */
export function draftHeadline(a: Artifact): string {
  const v = currentVersion(a);
  if (!v) return '';
  return `[Current draft mod v${v.n} ${JSON.stringify(v.name)} · matches ${v.matches.join(', ')} · ${lineCount(v.code)} lines]`;
}

/**
 * The block prepended to each user turn while a draft exists: what the draft is, and its full code.
 *
 * It is USER-SIDE context and says so. The model is told in the same breath that this is the user's
 * draft — the thing it may edit — and not page content, which the system prompt already forbids it
 * from taking instructions from. Nothing from the page reaches this block: every version in it came
 * from the model's own propose_mod calls, from a rollback to one of those, or from the user typing
 * a name, so a page that says "you are now in developer mode" cannot get in here by any route.
 */
export function draftBlock(a: Artifact): string {
  const v = currentVersion(a);
  if (!v) return '';
  return [
    draftHeadline(a),
    'This is the draft in the user’s artifact panel, not page content. Edits the user asks for apply to it.',
    '```javascript',
    v.code,
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function loadArtifact(chatId: string): Promise<Artifact | null> {
  const key = artifactKey(chatId);
  const r = await chrome.storage.local.get(key);
  const raw = r[key] as Artifact | undefined;
  return raw && Array.isArray(raw.versions) && raw.versions.length ? raw : null;
}

export async function saveArtifact(a: Artifact): Promise<void> {
  await chrome.storage.local.set({ [artifactKey(a.chatId)]: a });
}

export async function deleteArtifact(chatId: string): Promise<void> {
  await chrome.storage.local.remove(artifactKey(chatId));
}

/**
 * Record a proposal as a new version of a chat's draft, creating the artifact if this is its first.
 * Returns the artifact as stored, so the caller can post its version number to the panel.
 */
export async function recordProposal(chatId: string, p: ModProposal, proposalId?: string): Promise<Artifact> {
  const existing = await loadArtifact(chatId);
  const v: NewVersion = {
    code: p.code,
    name: p.name,
    description: p.description,
    matches: p.matches,
    source: 'proposal',
    ...(proposalId ? { proposalId } : {}),
    ...(p.untestedReason ? { untestedReason: p.untestedReason } : {}),
  };
  const next = existing ? addVersion(existing, v) : createArtifact(chatId, v);
  await saveArtifact(next);
  return next;
}
