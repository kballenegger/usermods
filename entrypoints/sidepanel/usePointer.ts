import { useEffect, useState } from 'react';

/**
 * What kind of device is driving this surface, watched rather than read once.
 *
 * Both answers can change while the UI is open. Attaching a mouse to an iPad flips the pointer
 * query; dragging a window edge changes the width. Neither is common, but a layout that latched on
 * mount would then be wrong with no way back short of reopening the popup, and a popup is exactly
 * the kind of window nobody thinks to reopen.
 *
 * `matchMedia` is not present in the node tests, which never render React; the guard keeps this
 * importable there anyway.
 */
export interface PointerEnvironment {
  /** The primary pointer is a finger. True on iPhone and iPad, false on a Mac. */
  coarsePointer: boolean;
  /** Viewport width in CSS pixels. */
  width: number;
}

const COARSE = '(pointer: coarse)';

function read(): PointerEnvironment {
  const coarsePointer = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE).matches : false;
  return { coarsePointer, width: window.innerWidth };
}

export function usePointerEnvironment(): PointerEnvironment {
  const [env, setEnv] = useState<PointerEnvironment>(read);

  useEffect(() => {
    const apply = () => setEnv(read());
    apply();
    window.addEventListener('resize', apply);
    const query = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE) : null;
    query?.addEventListener('change', apply);
    return () => {
      window.removeEventListener('resize', apply);
      query?.removeEventListener('change', apply);
    };
  }, []);

  return env;
}
