// Serialising read-modify-write cycles over one chrome.storage key, and making a delete win.
//
// THE BUG THIS EXISTS FOR. Every writer of the chat index (lib/chats.ts) was an unserialised
// read-modify-write: read 'chats', find the record, mutate it, write the whole array back. Two of
// those overlapping is the classic lost update — but the case a user actually reported is worse
// than a lost update, because one of the writers is a DELETE:
//
//   touchChat:  read index  ──────────────────────────────────> write index (chat still in it)
//   deleteChat:      read index ─> write index (chat gone) ─> remove chat:<id>:*
//
// The delete lands first and is then overwritten by a write built from a snapshot taken BEFORE it.
// The chat is back in the index, pointing at per-chat keys that were just removed. That is exactly
// "I deleted something then I saw it back again": a background run's touchChat, a setChatArtifact
// from a proposal, or a transcript writer finishing after the delete resurrects the record.
//
// TWO RULES, because serialisation alone is not enough.
//
//   1. One queue per key. Every writer of a key runs through `withKey(key, fn)`, so no two
//      read-modify-write cycles for that key can interleave. This is the same shape as
//      mutateConnections (lib/connections.ts) and updateRuns (entrypoints/background.ts), which
//      both already had it; the chat index is what did not.
//
//   2. A tombstone per deleted id. Serialisation fixes writers that START after the delete. It
//      cannot fix one that started BEFORE it — that writer is holding a snapshot in which the chat
//      is alive, and when its turn comes it will write that snapshot back. So a delete records the
//      id, and every index write filters tombstoned ids out on its way to storage. A late write
//      for a deleted chat is dropped rather than obeyed.
//
// Tombstones live in memory, which is the right lifetime and not a compromise: they exist to beat
// writes that are already in flight in THIS context, and an in-flight write cannot outlive the
// context holding it. A worker restart takes both the tombstone and the pending write with it.
// They are capped and expire so a long-lived worker cannot accumulate them without bound.

/** The tail of each key's write chain. A key with no entry has nothing in flight. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `key`, after everything already queued for it.
 *
 * Exclusive against other callers of withKey for the same key, in this context — which is what the
 * chat index needs, because every one of its writers lives in the background service worker. It is
 * not a cross-context lock; chrome.storage offers nothing to build one from. Keys are independent:
 * queueing on 'chats' does not delay a write to 'runs'.
 *
 * A rejection propagates to the caller and does NOT poison the chain: the next waiter runs either
 * way, because one failed write must not wedge every later one.
 */
export function withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // The chain is the settled tail, so a rejection here is not re-thrown into the next waiter.
  const tail = run.catch(() => {});
  chains.set(key, tail);
  // Drop the entry once this is the last thing queued, so a browser session that touches thousands
  // of keys does not keep a promise per key alive forever.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** Is anything queued for this key right now? For tests and for measuring, not for deciding. */
export function isQueued(key: string): boolean {
  return chains.has(key);
}

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

/**
 * How long a tombstone is honoured. A write that was in flight when the delete happened is, at
 * worst, one storage round trip behind it; a minute is four orders of magnitude more than that and
 * still short enough that an id reused after a browser restart (it is a UUID, so it will not be)
 * could not be affected.
 */
export const TOMBSTONE_TTL_MS = 60_000;

/** The most tombstones kept. Past this the oldest go, since they are long past useful anyway. */
export const MAX_TOMBSTONES = 500;

/** id -> when it was deleted. Insertion-ordered, which is what makes the cap cheap. */
const tombstones = new Map<string, number>();

/** Record that `id` has been deleted, so late writes carrying it are dropped. */
export function tombstone(id: string, now: number = Date.now()): void {
  tombstones.delete(id); // re-insert at the end, keeping the map ordered by time
  tombstones.set(id, now);
  if (tombstones.size > MAX_TOMBSTONES) {
    const oldest = tombstones.keys().next();
    if (!oldest.done) tombstones.delete(oldest.value);
  }
}

/** Has `id` been deleted recently enough that a write naming it is stale? */
export function isTombstoned(id: string, now: number = Date.now()): boolean {
  const at = tombstones.get(id);
  if (at === undefined) return false;
  if (now - at > TOMBSTONE_TTL_MS) {
    tombstones.delete(id);
    return false;
  }
  return true;
}

/**
 * Drop every record whose id has been tombstoned. Called on the way into storage by each index
 * writer, so a snapshot taken before a delete cannot put the deleted chat back.
 */
export function dropTombstoned<T extends { id: string }>(records: T[], now: number = Date.now()): T[] {
  if (!tombstones.size) return records;
  const out = records.filter((r) => !isTombstoned(r.id, now));
  return out.length === records.length ? records : out;
}

/** Forget every tombstone. Tests only — nothing in the extension unpicks a delete. */
export function clearTombstones(): void {
  tombstones.clear();
}
