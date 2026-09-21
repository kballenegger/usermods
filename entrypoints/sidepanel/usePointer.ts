import { useEffect, useState } from 'react';

/**
 * What kind of device is driving this surface, watched rather than read once.
 *
 * The answer can change while the UI is open: attaching a mouse to an iPad flips the pointer query.
 * That is not common, but a layout that latched on mount would then be wrong with no way back short
 * of reopening the popup, and a popup is exactly the kind of window nobody thinks to reopen.
 *
 * The FIRST value matters as much as the updates, and more so in Safari's popover, which is sized
 * from the document it contains. `useState(read)` is a lazy initializer, so `matchMedia` is
 * evaluated synchronously during the first render rather than in an effect after it: the popup's
 * very first committed DOM already carries the right `data-layout`, and there is no frame in which
 * a Mac is drawn as a phone sheet. If this ever becomes `useState(fallback)` plus an effect, a Mac
 * gets one painted frame of `height: 100dvh` with no width, which is precisely the state Safari
 * would measure the popover from. Do not move the read into the effect.
 *
 * The width is deliberately absent. It used to be here, and popupLayout used it as a floor, and in
 * Safari's content-sized popover that was a deadlock — see the long note in lib/mobile.ts. Nothing
 * in the layout decision may depend on a measurement the layout itself produces, so this hook
 * reports the one property that is a genuine input.
 *
 * `matchMedia` is not present in the node tests, which never render React; the guard keeps this
 * importable there anyway.
 */
export interface PointerEnvironment {
  /** The primary pointer is a finger. True on iPhone and iPad, false on a Mac. */
  coarsePointer: boolean;
}

const COARSE = '(pointer: coarse)';

function read(): PointerEnvironment {
  const coarsePointer = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE).matches : false;
  return { coarsePointer };
}

export function usePointerEnvironment(): PointerEnvironment {
  const [env, setEnv] = useState<PointerEnvironment>(read);

  useEffect(() => {
    const query = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE) : null;
    if (!query) return;
    // No apply() on mount: the lazy initializer above already read this, and calling setState here
    // for a value that has not changed is how a first-frame flash gets reintroduced by accident.
    const apply = () => setEnv(read());
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  return env;
}
