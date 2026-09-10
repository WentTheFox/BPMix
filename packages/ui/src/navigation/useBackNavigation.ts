import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';
import type { BackNavigationActions, BackNavigationState } from './backNavigation';
import { handleBackNavigation } from './backNavigation';

/**
 * Wires the shared back-navigation priority (see handleBackNavigation) to
 * Android/Windows' hardware back button - see useBackNavigation.web.ts for
 * the same priority wired to the browser's back button instead, so both
 * apps close overlays in the same order regardless of platform.
 *
 * `extraHandler`, if given, is checked before the shared priority - for a
 * platform-only overlay the other app doesn't have at all (BPMix's Android
 * folder-picker screens), so that stays out of the shared logic instead of
 * needing a web no-op equivalent. Return true from it to mean "handled,
 * don't fall through to the shared priority."
 */
export function useBackNavigation(state: BackNavigationState, actions: BackNavigationActions, extraHandler?: () => boolean): void {
  // Refs, not the subscribe effect's own deps - state/actions/extraHandler
  // are fresh object/closure identities every render (the call sites don't
  // memoize them), and resubscribing BackHandler on every render would both
  // churn the listener array and risk missing a back press mid-swap.
  const stateRef = useRef(state);
  const actionsRef = useRef(actions);
  const extraHandlerRef = useRef(extraHandler);
  useEffect(() => {
    stateRef.current = state;
    actionsRef.current = actions;
    extraHandlerRef.current = extraHandler;
  });

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (extraHandlerRef.current?.()) return true;
      return handleBackNavigation(stateRef.current, actionsRef.current);
    });
    return () => subscription.remove();
  }, []);
}
