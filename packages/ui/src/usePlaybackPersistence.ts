import { persistPositionIfDue, playbackPatched, restorePlayback, userTookOver } from '@bpmix/core';
import type { PlaybackState, PlaylistPlayerState, RootWithLibrary } from '@bpmix/core';
import { useCallback, useEffect } from 'react';
import { useAppDispatch, useAppSelector } from './store/hooks';

// Moved to @bpmix/core with the library slice; re-exported so existing imports keep working.
export type { RootWithLibrary };

export interface PlaybackPersistence {
  /**
   * True for the whole startup restore window, so a caller can hold off
   * rendering its normal library/playlist screens until the right one is
   * known - without that, the library screen would render first and only jump
   * to a restored playlist screen a beat later, reading as a flash.
   */
  isRestoring: boolean;
  /**
   * Merges a change into the persisted playback state and writes it.
   * `debounceMs` delays only the write, coalescing rapid-fire calls (a
   * slider's drag) into one - the merged state updates immediately either way.
   */
  persistPlaybackPatch: (patch: Partial<PlaybackState>, options?: { debounceMs?: number }) => void;
  /** Persists the position at most every few seconds; call on every ticker tick. */
  persistPositionIfDue: (state: PlaylistPlayerState) => void;
  /**
   * Call from every manual transport action as soon as the user does anything
   * that starts/changes playback. The startup restore is a slow chain that
   * can still be in flight seconds after the screen is interactive; without
   * this, a user who taps a track early watches their choice overwritten by
   * last session's (see RestoreState.userTookOver).
   */
  notifyUserTookOver: () => void;
}

/**
 * Starts the startup playback restore once on mount (see restorePlayback in
 * @bpmix/core - the ordering and race guards live there) and exposes the
 * persistence functions. Persistence itself is the store's `persistence`
 * slice plus its listener; this is a thin view over it.
 */
export function usePlaybackPersistence(): PlaybackPersistence {
  const dispatch = useAppDispatch();
  const isRestoring = useAppSelector((state) => state.restore.isRestoring);

  useEffect(() => {
    let cancelled = false;
    void dispatch(restorePlayback({ isCancelled: () => cancelled }));
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const persistPlaybackPatch = useCallback(
    (patch: Partial<PlaybackState>, options?: { debounceMs?: number }) => void dispatch(playbackPatched({ patch, debounceMs: options?.debounceMs })),
    [dispatch],
  );
  const persistPosition = useCallback((state: PlaylistPlayerState) => dispatch(persistPositionIfDue(state)), [dispatch]);
  const notifyUserTookOver = useCallback(() => void dispatch(userTookOver()), [dispatch]);

  return { isRestoring, persistPlaybackPatch, persistPositionIfDue: persistPosition, notifyUserTookOver };
}
