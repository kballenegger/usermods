// The note tool: a scratchpad the chat keeps for the model, so what it has collected survives
// compaction and navigation. It is re-attached to every user turn as the draft is (lib/agent/loop.ts
// renderTurn), and once more after a compaction, because a long run has only the one user turn and
// that is the turn a summary swallows.
//
// Pure. The background owns the storage.

/** Past this the oldest text goes, which the result says: a note is not a place to keep a page. */
export const NOTE_MAX_CHARS = 8000;

export type NoteChange = { ok: true; note: string; text: string } | { ok: false; error: string };

/** What a call to the tool does to the note, and what to tell the model. `set` comes before `append`. */
export function changeNote(current: string, input: Record<string, unknown>): NoteChange {
  const set = input.set;
  const append = input.append;
  if (set !== undefined && typeof set !== 'string') return { ok: false, error: 'set must be a string.' };
  if (append !== undefined && typeof append !== 'string') return { ok: false, error: 'append must be a string.' };
  if (set === undefined && append === undefined) return { ok: false, error: 'note needs set or append.' };
  let next = set ?? current;
  if (append) next = next ? `${next}\n${append}` : append;
  const cut = next.length > NOTE_MAX_CHARS;
  if (cut) next = next.slice(next.length - NOTE_MAX_CHARS);
  const said = cut ? `Noted, and the oldest text was dropped to stay under ${NOTE_MAX_CHARS} characters.` : 'Noted.';
  return { ok: true, note: next, text: `${said} The note now holds ${next.length} characters and comes back on every user turn.` };
}

/** The block a user turn carries, or '' when the note is empty. */
export function noteBlock(note: string): string {
  if (!note.trim()) return '';
  return `[Your note in this chat, kept for you by the note tool. It is your own working data, not the user's words.]\n${note}\n[End of your note]`;
}
