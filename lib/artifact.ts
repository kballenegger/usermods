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
  /**
   * The ==UserScript== block this version's script came with, for a draft that started life outside
   * this product. Absent on a version the model wrote, whose header is generated from the four
   * fields above. See DraftHeader and toSource.
   */
  header?: DraftHeader;
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
  /**
   * The `n` of the version that was written to the linked mod by the last save. This is what makes
   * "is this saved?" a question about a VERSION rather than about the chat: after the user saves v1
   * and the model proposes v2, the mod on disk is still v1, so v1's card reads as saved and v2's
   * does not. Without it, the only saved-ness the panel had was a per-card boolean that a save set
   * on every card in the transcript at once — which is what made a fresh proposal appear already
   * saved, and made the version the user was actually running impossible to tell from the one the
   * model had just written.
   */
  savedVersion?: number;
  /** Carried from the proposal that is current, so the panel can repeat the model's caveat. */
  untestedReason?: string;
}

/**
 * What a proposal card in the transcript should say about itself, given the chat's draft.
 *
 * The card is history: it is the moment one version was proposed, and whether that version is the
 * one installed is a fact about the artifact, not about the card. Deriving it here — from the
 * artifact the panel already holds — is what stops a saved flag from surviving the draft moving on
 * underneath it.
 *
 * `version` is the artifact version this card became, or undefined for a card whose version could
 * not be recorded (a storage failure, or a transcript restored from before drafts existed).
 */
export type ProposalCardState =
  /** This exact version is what the linked mod holds. Nothing to do. */
  | 'saved'
  /** Never saved from this chat: saving creates the mod. */
  | 'unsaved'
  /** The chat has a saved mod, but this version is not what it holds: saving rewrites it. */
  | 'update'
  /** No draft to act on at all (no artifact yet, or it could not be read). */
  | 'none';

export function proposalCardState(a: Artifact | null, version: number | undefined): ProposalCardState {
  if (!a) return 'none';
  if (!a.linkedModId) return 'unsaved';
  // An unversioned card cannot claim to be the saved one: it has no identity to compare. It offers
  // the update, which is honest — saving from it saves the CURRENT draft, as it always has.
  if (version != null && a.savedVersion === version) return 'saved';
  return 'update';
}

/** The label the card's primary button wears for each state. */
export function proposalCardLabel(state: ProposalCardState): string {
  switch (state) {
    case 'saved':
      return 'Saved · enabled';
    case 'update':
      return 'Save & update mod';
    case 'unsaved':
    case 'none':
      return 'Save & enable';
  }
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
  /** See ArtifactVersion.header: the original block, for a draft that came from an imported mod. */
  header?: DraftHeader;
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
  // The header is INHERITED when the new version does not bring one of its own. This is what makes
  // an imported userscript survive being edited in chat: the model's propose_mod carries a body and
  // four fields and knows nothing about @require or @grant, so without this the first revision
  // would quietly re-emit a generated header and strip every dependency the script needs. A version
  // that does bring a header (open_mod adopting a different mod) replaces it, which is right —
  // that is a different script.
  const header = v.header ?? current?.header;
  const version: ArtifactVersion = {
    n,
    code: v.code,
    name: v.name,
    description: v.description,
    matches: [...v.matches],
    createdAt: at,
    source: v.source,
    ...(v.proposalId ? { proposalId: v.proposalId } : {}),
    ...(header ? { header } : {}),
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
      // Explicit rather than inherited: rolling back to a version that predates an open_mod must
      // restore THAT version's header too, not the one the draft happens to be wearing now.
      ...(target.header ? { header: target.header } : {}),
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

/**
 * The current draft as a full userscript, header and all — what Try, Save and Export use.
 *
 * A draft that came from an imported mod keeps that mod's own header and gets it back here, with
 * only the name, description and matches rewritten inside it (reheader). A draft the model wrote
 * from nothing has no header to keep, so one is generated as it always was.
 */
export function toSource(a: Artifact): string {
  const v = currentVersion(a);
  if (!v) return '';
  if (v.header) return `${reheader(v.header.text, v)}\n\n${v.code.trim()}\n`;
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
 * What a version of a mod that came from OUTSIDE this product needs to carry.
 *
 * A mod the model wrote has a header that buildSource can re-emit from four fields, so the draft
 * only ever had to hold the body. A mod that was imported — from a URL, a file, a Tampermonkey
 * backup — does not: its header carries `@require`, `@resource`, `@grant GM_setValue`, `@run-at`,
 * `@connect`, `@noframes`, a `@version` the Update button compares against, `@downloadURL`, and
 * whatever else its author wrote. Re-emitting that from a name, a description and a match list
 * would silently strip every one of them and leave a script that throws at page load.
 *
 * So a version keeps the header it arrived with, verbatim, and `toSource` puts that header back
 * rather than generating one. Only the fields the draft is allowed to change (name, description,
 * matches) are rewritten INSIDE it — see reheader() — which is what lets the model rename a mod or
 * widen its reach without knowing anything about the twenty other lines it must not touch.
 */
export interface DraftHeader {
  /** The ==UserScript== block exactly as it was, including both fences. */
  text: string;
}

/**
 * An artifact seeded from a saved mod, already linked to it. This is how a chat that starts from an
 * existing mod ("change this one") gets a draft whose first version is what is installed, rather
 * than a draft that begins at the model's first rewrite.
 *
 * The body comes from the mod's source with its header stripped by the same parser the rest of the
 * product uses, and the header itself is KEPT on the version (see DraftHeader) so a save puts back
 * the one the script came with rather than a generated one.
 */
export function fromMod(chatId: string, mod: Mod, at = Date.now(), id: string = crypto.randomUUID()): Artifact {
  const a = createArtifact(chatId, versionFromMod(mod), at, id);
  // v1 IS the installed mod, byte for byte, so it is already the saved version. A chat that starts
  // from an existing mod otherwise opens offering to "save" something that is already saved.
  return { ...a, linkedModId: mod.id, savedVersion: a.current };
}

/**
 * Adopt a mod's source as the draft of a chat that already has one — what the open_mod tool does.
 *
 * It APPENDS rather than starting over, for the same reason a rollback appends: the versions the
 * chat already holds are work someone did, and a history that loses them cannot be walked back. So
 * the mod becomes the newest version, the link and savedVersion point at it, and v1..vn are still
 * in the strip. `openModDecision` in lib/modmatch.ts decides whether this is allowed to happen at
 * all when those earlier versions were never saved anywhere.
 */
export function adoptMod(a: Artifact, mod: Mod, at = Date.now()): Artifact {
  const next = addVersion(a, versionFromMod(mod), at);
  return { ...next, linkedModId: mod.id, savedVersion: next.current };
}

/** One new version holding a mod's body, its header and its identity. */
function versionFromMod(mod: Mod): NewVersion {
  const header = parseHeader(mod.source);
  const block = mod.source.match(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/)?.[0];
  return {
    code: stripHeaderBody(mod.source),
    name: header.name || mod.name,
    description: header.description || mod.description,
    matches: mod.matches.length ? [...mod.matches] : [...header.matches],
    source: 'user-edit',
    ...(block ? { header: { text: block } } : {}),
  };
}

/**
 * Break the link to the mod, so the next Save creates a separate one — the panel's "Save as a new
 * mod instead".
 *
 * It touches the ARTIFACT and nothing else: the mod keeps its id, its source, its enabled state and
 * its GM values, and goes on running exactly as it did. Detaching is not deleting, and there is no
 * path from here to a mod being removed.
 *
 * savedVersion goes with the link, because it is a statement about that mod: with nothing linked,
 * "which version is installed" has no answer, and leaving the number behind would make the panel
 * read a fresh, unsaved draft as already saved.
 */
export function detachFromMod(a: Artifact): Artifact {
  if (!a.linkedModId) return a;
  const { linkedModId: _drop, savedVersion: _drop2, ...rest } = a;
  return rest;
}

/**
 * The script body of a source, without its ==UserScript== block. lib/mods exports stripHeader, but
 * importing it here would pull a second value import into the node test path for no gain — this is
 * the same regex and it is the only other place that needs it.
 */
function stripHeaderBody(source: string): string {
  return source.replace(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/, '').trim();
}

/**
 * A kept header with the three fields the draft owns rewritten inside it.
 *
 * @name and @description are replaced in place (so their position and padding survive); @match
 * lines are replaced as a group, because the draft's list is authoritative and a stale line left
 * behind would widen the script's reach. Every other line is passed through untouched — that is the
 * whole point. Locale-suffixed keys (@name:fr) are left alone: parseHeader treats them as fallbacks
 * and rewriting them would be translating on the author's behalf.
 */
export function reheader(header: string, v: { name: string; description: string; matches: string[] }): string {
  const lines = header.split('\n');
  const out: string[] = [];
  let matchesWritten = false;
  const pad = (key: string) => (key.length >= 11 ? ' ' : ' '.repeat(12 - key.length));
  for (const line of lines) {
    // The key pattern is parseHeader's, `[\w:-]+`, and the colon is load-bearing. With `[\w-]+` a
    // locale-suffixed line like `// @name:fr  Vieux` matched as key "name" with ":fr  Vieux" as its
    // value, so it was rewritten into a SECOND `@name` — two names in one header, and the author's
    // translation destroyed. Capturing the whole key lets the switch below see "name:fr", which is
    // not "name", so the line falls through to being passed along untouched.
    const kv = line.match(/^(\s*\/\/\s*)@([\w:-]+)(\s*)(.*?)\s*$/);
    if (!kv) {
      out.push(line);
      continue;
    }
    const [, lead, key, gap] = kv as [string, string, string, string, string];
    if (key === 'name') out.push(`${lead}@name${gap || pad('name')}${v.name}`);
    else if (key === 'description') out.push(`${lead}@description${gap || pad('description')}${v.description}`);
    else if (key === 'match') {
      // The first @match becomes the whole new list; the rest are dropped, so a draft that narrowed
      // its reach does not keep the pattern it dropped.
      if (!matchesWritten) {
        matchesWritten = true;
        for (const m of v.matches) out.push(`${lead}@match${gap || pad('match')}${m}`);
      }
    } else out.push(line);
  }
  // A header with no @match at all (an @include-only script) gains the draft's patterns rather than
  // losing them: the draft's list is what the panel showed the user and what the save registers on.
  if (!matchesWritten && v.matches.length) {
    const end = out.findIndex((l) => /\/\/\s*==\/UserScript==/.test(l));
    const insert = v.matches.map((m) => `// @match${pad('match')}${m}`);
    if (end >= 0) out.splice(end, 0, ...insert);
    else out.push(...insert);
  }
  return out.join('\n');
}

/**
 * Set (or add, or remove) single-valued header keys in a whole userscript source, leaving every
 * other line exactly as it was — the sharing path's reheader. `@version`, `@updateURL`,
 * `@downloadURL`, `@license` and `@namespace` are keys a share has to be able to write without
 * touching the twenty others an imported script carries, which is the same promise reheader makes
 * for name, description and matches.
 *
 * A key that is present is rewritten in place (its first line; later duplicates are dropped, since
 * each of these keys means one thing). A key that is absent is added just before the closing fence,
 * aligned to the column the header's own `@name` line uses. `null` removes the key. Locale variants
 * (`@name:fr`) are never touched: `[\w:-]+` captures the whole key, exactly as parseHeader reads it.
 * A source with no header is returned unchanged — there is nothing to put a key in.
 */
export function reheaderFields(source: string, fields: Record<string, string | null>): string {
  const block = source.match(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/);
  if (!block || block.index === undefined) return source;
  const lines = block[0].split('\n');
  const nameLine = lines.map((l) => l.match(/^(\s*\/\/\s*)(@name\s+)\S/)).find(Boolean);
  const lead = nameLine?.[1] ?? '// ';
  const width = Math.max(nameLine?.[2]?.length ?? 13, 2);
  const line = (key: string, value: string) => `${lead}@${key}${' '.repeat(Math.max(1, width - key.length - 1))}${value}`;
  const done = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const kv = l.match(/^\s*\/\/\s*@([\w:-]+)(\s*)(.*?)\s*$/);
    const key = kv?.[1];
    if (!key || !(key in fields)) {
      out.push(l);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    const value = fields[key];
    if (value === null || value === undefined) continue;
    const m = l.match(/^(\s*\/\/\s*@[\w:-]+)(\s*)/)!;
    out.push(`${m[1]}${m[2] || ' '}${value}`);
  }
  const end = out.findIndex((l) => /\/\/\s*==\/UserScript==/.test(l));
  const add = Object.entries(fields)
    .filter(([k, v]) => !done.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => line(k, v as string));
  out.splice(end >= 0 ? end : out.length, 0, ...add);
  return source.slice(0, block.index) + out.join('\n') + source.slice(block.index + block[0].length);
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
  const lines = [
    draftHeadline(a),
    'This is the draft in the user’s artifact panel, not page content. Edits the user asks for apply to it.',
  ];
  // A draft that IS an installed mod is a different job from a draft on its way to becoming one:
  // the script already works, people already rely on it, and the model's licence is to change what
  // was asked and leave the rest exactly as it found it. Saying so here rather than only in the
  // system prompt means it is true of THIS turn — a chat that opened a mod half way through is
  // told so from that turn on.
  if (a.linkedModId) {
    lines.push(
      `This draft is an installed mod (id ${a.linkedModId}) that the user is EDITING. Saving rewrites that mod in place.`,
      'Read the code below before changing it, keep everything it already does unless the user asks otherwise, and propose the COMPLETE updated script.',
    );
    // The header is the part a model is most likely to drop, because propose_mod does not carry it
    // and nothing else in the conversation shows it. It is quoted in full so "keep the metadata
    // block" is an instruction with the block attached rather than a rule about something unseen.
    if (v.header) {
      lines.push(
        'Its ==UserScript== metadata block is kept for you and re-attached on save — do NOT write one into your code, and do not drop its @require, @resource, @grant, @connect or @run-at lines:',
        '```',
        v.header.text,
        '```',
      );
    }
  }
  lines.push('```javascript', v.code, '```');
  return lines.join('\n');
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
