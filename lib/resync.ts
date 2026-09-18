// What a GM value write should do to the mod's registration. Pure, so it is testable under node.

export type ResyncPlan =
  /** Nothing to do: the mod is gone, or it is off and not registered. */
  | 'none'
  /** Update only this mod's registered code, leaving every other script registered. */
  | 'one'
  /** Fall back to a full re-register: the mod should be registered but is not. */
  | 'full';

/**
 * A value write re-registers ONE mod. The old code re-ran the whole sync, which unregisters every
 * script and registers them all again — slower, and a window in which no mod is registered at all.
 * Install, delete and toggle still do a full sync, because those change which scripts exist.
 */
export function resyncPlan(mod: { enabled: boolean } | undefined | null, isRegistered: boolean): ResyncPlan {
  if (!mod) return isRegistered ? 'full' : 'none'; // deleted: let the full sync drop its registration
  if (!mod.enabled) return isRegistered ? 'full' : 'none';
  return isRegistered ? 'one' : 'full';
}
