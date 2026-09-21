/**
 * The decisions the compact (iPhone and iPad) chat shell makes, as pure functions.
 *
 * On a phone the popup is the whole product and the screen is small, so the compact shell is
 * content-first: a slim top bar, the transcript, a one-row composer. Everything else is one tap
 * away in a bottom sheet. Which sheet is up, which rows of the transcript fold together, what the
 * one button beside the message box does and what the draft pill says are all decisions, not
 * styling, so they live here where node can test them (test/compactshell.test.ts) rather than in
 * the components, where only a screenshot would.
 *
 * Nothing in here knows about React or the DOM, and nothing in here runs for the side panel or the
 * Mac popover: those keep the layout they had.
 */
// The .ts extensions are load-bearing: these are VALUE imports, and `npm test` runs this file
// through node's type stripping, which resolves nothing it is not told (see lib/transcript.ts).
import { currentVersion, type Artifact } from './artifact.ts';
import { toolDotState, toolRowTitle, type ToolDotState } from './transcript.ts';
import type { ChatItem } from './types';

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/**
 * The bottom sheets the chat view can raise.
 *
 *  - 'chat'    this site's chats, and what you do to the current one
 *  - 'add'     what "+" offers: point at an element, attach an image, the model, a new chat
 *  - 'model'   the model picker, as its own sheet
 *  - 'draft'   the full draft panel: versions, diff, Try, Export, rename, roll back, detach
 *  - 'editmod' the installed-mod picker behind "Edit a mod…"
 */
export type ChatSheet = 'chat' | 'add' | 'model' | 'draft' | 'editmod';

export type SheetEvent =
  | { type: 'open'; sheet: ChatSheet }
  | { type: 'close' }
  /** The user picked something that ends the sheet's job: a chat, a model, a mod, an action. */
  | { type: 'done' }
  /** The visible chat changed underneath whatever is open. */
  | { type: 'chat-changed' };

/**
 * Which sheet is up after an event. One at a time: a sheet is modal, and a sheet opened from a
 * sheet ("+" then Model, the chat sheet then Edit a mod…) REPLACES it rather than stacking, so
 * closing always lands back on the chat and never on a sheet you had finished with.
 *
 * The draft sheet cannot open without a draft, and it closes if the draft goes away while it is
 * up (a chat switch, a run in another tab deleting it): a sheet with nothing in it is a dead end.
 */
export function nextSheet(current: ChatSheet | null, event: SheetEvent, ctx: { hasDraft: boolean }): ChatSheet | null {
  let next: ChatSheet | null;
  switch (event.type) {
    case 'open':
      next = event.sheet;
      break;
    case 'close':
    case 'done':
      next = null;
      break;
    case 'chat-changed':
      // The model sheet is about "this chat's model" and the draft sheet about this chat's draft;
      // both would now be showing the previous chat's. The rest are not about a chat at all.
      next = current === 'model' || current === 'draft' || current === 'chat' ? null : current;
      break;
  }
  if (next === 'draft' && !ctx.hasDraft) return null;
  return next;
}

// ---------------------------------------------------------------------------
// The one button beside the message box
// ---------------------------------------------------------------------------

/**
 * The panel shows Stop AND Queue while a run is going. One row has room for one button, so the
 * spot is shared: with nothing typed it stops the run, and the moment there is something to send
 * it queues it. Stop is never out of reach while typing, because the activity line above the
 * composer carries its own Stop for as long as the run lasts.
 */
export type SendMode = 'send' | 'queue' | 'stop';

export function sendMode(state: { busy: boolean; hasContent: boolean }): SendMode {
  if (!state.busy) return 'send';
  return state.hasContent ? 'queue' : 'stop';
}

export const SEND_LABEL: Record<SendMode, string> = {
  send: 'Send',
  queue: 'Queue message',
  stop: 'Stop',
};

// ---------------------------------------------------------------------------
// Folding tool rows
// ---------------------------------------------------------------------------

/** A run of consecutive tool rows at least this long folds into one "N steps" line. */
export const FOLD_AT = 3;

export type TranscriptBlock =
  /** One transcript row, drawn as it always is. */
  | { kind: 'item'; index: number }
  /** A run of tool rows, drawn as one disclosure. `indices` are positions in the item list. */
  | { kind: 'steps'; indices: number[] };

/**
 * Group the transcript for a phone.
 *
 * A turn that took seven tool calls is seven rows nobody reads on a 390px screen, between the
 * message and the answer to it. Runs of FOLD_AT or more consecutive tool rows become one line that
 * opens to show them; shorter runs stay as they are, since folding two rows behind a tap saves
 * nothing. Only ADJACENT tool rows fold: anything else between them (prose, a model change) is
 * something the model said or did in between, and hiding the order would misreport the run.
 */
export function foldToolRows(items: readonly ChatItem[], foldAt: number = FOLD_AT): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= foldAt) blocks.push({ kind: 'steps', indices: run });
    else for (const index of run) blocks.push({ kind: 'item', index });
    run = [];
  };
  items.forEach((it, index) => {
    if (it.kind === 'tool') {
      run.push(index);
      return;
    }
    flush();
    blocks.push({ kind: 'item', index });
  });
  flush();
  return blocks;
}

export interface StepsSummary {
  /** "4 steps", and what is worth knowing without opening it. */
  label: string;
  /** The dot: the worst thing in the run, so a failure is never folded out of sight. */
  state: ToolDotState;
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/**
 * What a folded run says on its one line.
 *
 * While a step is still running the line names it, because that is the step the user is waiting
 * on. A failure is counted on the line and colours the dot, so folding can never hide that
 * something went wrong. Otherwise it is just the count.
 */
export function stepsSummary(tools: readonly ToolItem[]): StepsSummary {
  const states = tools.map(toolDotState);
  const count = `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`;
  const runningAt = states.lastIndexOf('running');
  if (runningAt !== -1) {
    const t = tools[runningAt]!;
    return { label: `${count} · ${toolRowTitle(t.name, t.input)}`, state: 'running' };
  }
  const failed = states.filter((s) => s === 'error').length;
  if (failed) return { label: `${count} · ${failed} failed`, state: 'error' };
  const waiting = states.filter((s) => s === 'waiting').length;
  if (waiting) return { label: `${count} · ${waiting} timed out`, state: 'waiting' };
  return { label: count, state: 'ok' };
}

// ---------------------------------------------------------------------------
// The draft pill
// ---------------------------------------------------------------------------

export interface DraftPill {
  name: string;
  /** "v2" */
  version: string;
  /**
   * What the draft IS right now, in a word:
   *  - 'editing'  it is an edit of an installed mod, and saving writes over that mod
   *  - 'saved'    the mod this chat created holds exactly this version
   *  - 'unsaved'  this chat's mod exists but holds an older version
   *  - 'draft'    never saved
   */
  status: 'editing' | 'saved' | 'unsaved' | 'draft';
  /** The pill's primary action, in the panel's words for it. */
  action: 'Save' | 'Update';
  /** True when pressing the action would change nothing: the mod already holds this version. */
  upToDate: boolean;
  /** The whole pill as one sentence, for the accessible name of the part that opens the sheet. */
  label: string;
}

/**
 * The draft panel and the "EDITING <mod>" line, as one line.
 *
 * `editingModName` is resolved by the caller from the live mod list, exactly as the full panel
 * does: a draft linked to a mod that has since been deleted is not editing anything.
 */
export function draftPill(artifact: Artifact, editingModName: string): DraftPill | null {
  const current = currentVersion(artifact);
  if (!current) return null;
  const upToDate = !!artifact.linkedModId && artifact.savedVersion === current.n;
  const status: DraftPill['status'] = upToDate ? 'saved' : editingModName ? 'editing' : artifact.linkedModId ? 'unsaved' : 'draft';
  const action = artifact.linkedModId ? 'Update' : 'Save';
  const version = `v${current.n}`;
  const what =
    status === 'editing'
      ? `editing the installed mod “${editingModName}”`
      : status === 'saved'
        ? 'saved'
        : status === 'unsaved'
          ? 'not saved to its mod yet'
          : 'not saved yet';
  return { name: current.name, version, status, action, upToDate, label: `Draft: ${current.name}, ${version}, ${what}. Show the draft` };
}

// ---------------------------------------------------------------------------
// The tablet popover
// ---------------------------------------------------------------------------

/** No real window the system hands the popup is smaller than this; anything under it is noise. */
export const POPOVER_FLOOR = { width: 320, height: 420 };

/**
 * Growth smaller than this is not adopted. A system-sized sheet differs from the document by a
 * lot; a popover that came out a few pixels larger than its content (a border, a rounding) differs
 * by a little, and chasing that would grow the popover a few pixels at a time for ever.
 */
export const POPOVER_GROW_STEP = 48;

/**
 * The size the compact document should be on an iPad, once there is a viewport worth trusting.
 *
 * An iPad shows the popup as a popover sized FROM the document, the way a Mac does, so the
 * document states a size before React mounts (entrypoints/popup/popup-size.css). That is a guess
 * made with no measurements, and two things can make it wrong: Safari may clamp the popover
 * smaller than asked (a short landscape screen), or the iPad may present the popup as a sheet
 * instead (Split View, Slide Over, a narrow Stage Manager window), which has a size of its own.
 * Either way the viewport ends up different from the document, and the composer falls off the
 * bottom or the sheet overflows sideways.
 *
 * So after mount the document ADOPTS the viewport the system settled on. That is not the circular
 * dependency the pre-mount rule exists to avoid, because it never replaces a size with nothing:
 *
 *  - a measurement under the floor (the popover has not been sized yet, or has collapsed) is
 *    ignored and the size the document already has stands;
 *  - a smaller viewport is adopted, so the document shrinks to fit a clamped popover or a narrow
 *    sheet and the composer stays on screen;
 *  - a larger viewport is adopted only when it is larger by a real margin, which is a sheet the
 *    system sized, and never when it is a popover a few pixels bigger than what it wraps.
 *
 * In a content-sized popover the viewport IS the document's size, and adopting it is a fixed point.
 */
export function tabletPopupSize(viewport: { width: number; height: number }, current: { width: number; height: number }): { width: number; height: number } {
  const adopt = (measured: number, now: number, floor: number) => {
    if (!Number.isFinite(measured) || measured < floor) return now;
    const rounded = Math.round(measured);
    if (rounded > now && rounded - now < POPOVER_GROW_STEP) return now;
    return rounded;
  };
  return {
    width: adopt(viewport.width, current.width, POPOVER_FLOOR.width),
    height: adopt(viewport.height, current.height, POPOVER_FLOOR.height),
  };
}
