import { useEffect, useRef } from 'react';
import type { BackNavigationActions, BackNavigationState } from './backNavigation';
import { handleBackNavigation } from './backNavigation';

const HISTORY_STATE_MARKER = 'bpmix-nav';

/**
 * Web equivalent of useBackNavigation.ts's BackHandler wiring - see that
 * file's doc for the shared priority this drives. The browser's own back
 * button only fires `popstate` for a history entry this app pushed itself;
 * opening Now Playing/Settings/a playlist is a plain in-app state change
 * that doesn't do that on its own, so without this the browser back button
 * would just navigate away from the app instead of closing the topmost
 * overlay. `extraHandler` exists for signature parity with the native hook
 * (BPMix's Android-only folder-picker overlays) - web never has one of
 * those open, so it's unused here.
 *
 * Tracks how many of the three overlays (settings/nowPlaying/playlist) are
 * open as a single depth number and keeps that many extra history entries
 * pushed, so N browser back presses close N overlays one at a time in the
 * same priority order as handleBackNavigation, then a final press (nothing
 * left of ours to pop) leaves the page - the web equivalent of the mobile
 * app exiting once it's back on the Library start screen.
 */
export function useBackNavigation(state: BackNavigationState, actions: BackNavigationActions, _extraHandler?: () => boolean): void {
  const depth = (state.screenKind === 'playlist' ? 1 : 0) + (state.nowPlayingOpen ? 1 : 0) + (state.settingsOpen ? 1 : 0);
  const depthRef = useRef(0);
  const stateRef = useRef(state);
  const actionsRef = useRef(actions);
  // True for exactly the one popstate our own history.go() below triggers -
  // that entry is already accounted for (whatever closed the overlay called
  // its own setState first), so the resulting popstate must be swallowed
  // rather than closing a SECOND overlay on top of that.
  const ignoreNextPopStateRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
    actionsRef.current = actions;
  });

  useEffect(() => {
    const onPopState = () => {
      if (ignoreNextPopStateRef.current) {
        ignoreNextPopStateRef.current = false;
        return;
      }
      if (depthRef.current <= 0) return; // Not one of ours - e.g. genuinely leaving the page.
      depthRef.current -= 1;
      handleBackNavigation(stateRef.current, actionsRef.current);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const delta = depth - depthRef.current;
    if (delta > 0) {
      for (let i = 0; i < delta; i++) {
        window.history.pushState({ marker: HISTORY_STATE_MARKER }, '');
      }
      depthRef.current = depth;
    } else if (delta < 0) {
      // An overlay closed some other way (its own close button, not the
      // browser's back button) - pop the matching entries so the browser's
      // history depth doesn't outlive the in-app state it was tracking.
      ignoreNextPopStateRef.current = true;
      window.history.go(delta);
      depthRef.current = depth;
    }
  }, [depth]);
}
