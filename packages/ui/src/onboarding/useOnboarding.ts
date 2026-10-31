import type { LibraryStore } from '@bpmix/core';
import { useCallback, useEffect, useState } from 'react';

const ONBOARDING_DONE_KEY = 'onboarding.done';

export interface UseOnboardingOptions {
  store: LibraryStore;
  /** Whether a BPMix server can be connected to on this platform: true, false, or null while that is still being found out (the web app asks the server hosting it). */
  serverAvailable: boolean | null;
  /** The library's folders have been read from storage, so "no folders" really means none. */
  rootsLoaded: boolean;
  hasRoots: boolean;
  serverActive: boolean;
}

export interface UseOnboardingResult {
  /** The first-run screen should be showing. */
  visible: boolean;
  /** Dismisses it for good (the person chose to use folders on this device, or signed in). */
  finish: () => void;
}

/**
 * First-run onboarding: shown once, on a fresh install where a server could be connected to and nothing
 * is set up yet. Anyone who already has folders added, or is already signed in, is marked as done without
 * ever seeing it, so upgrading never interrupts an existing library.
 */
export function useOnboarding({ store, serverAvailable, rootsLoaded, hasRoots, serverActive }: UseOnboardingOptions): UseOnboardingResult {
  // null until the stored answer has been read.
  const [done, setDone] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void store.getSetting(ONBOARDING_DONE_KEY).then(
      (value) => !cancelled && setDone(value === 'true'),
      () => !cancelled && setDone(true),
    );
    return () => {
      cancelled = true;
    };
  }, [store]);

  const finish = useCallback(() => {
    setDone(true);
    void store.putSetting(ONBOARDING_DONE_KEY, 'true').catch(() => undefined);
  }, [store]);

  const alreadySetUp = rootsLoaded && (hasRoots || serverActive);
  useEffect(() => {
    if (done === false && alreadySetUp) finish();
  }, [done, alreadySetUp, finish]);

  return { visible: done === false && serverAvailable === true && rootsLoaded && !alreadySetUp, finish };
}
