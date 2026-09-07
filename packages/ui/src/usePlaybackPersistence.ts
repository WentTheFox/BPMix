import type {
  GrantedRoot,
  LibraryStore,
  PlaybackState,
  PlaylistPlayer,
  PlaylistPlayerState,
  PlaylistRecord,
  TrackRecord,
} from '@bpmix/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RestoringStepKey } from './restoringSteps';

/** How often to persist positionSeconds while a track is playing - frequent enough that a crash/force-quit loses very little progress, infrequent enough not to hammer the store on every ~200ms poll tick. */
const POSITION_PERSIST_INTERVAL_MS = 5000;

/** Debounce for persisting a rapidly-changing value (currently just volume, dragged via VolumeSlider) - see persistPlaybackPatch's `debounceMs` option. Long enough to coalesce a drag's whole burst of touch-move ticks into one write, short enough that a quick tap-to-set still saves within a beat of releasing. */
export const RAPID_PLAYBACK_PATCH_DEBOUNCE_MS = 400;

export interface RootWithLibrary {
  root: GrantedRoot;
  playlists: PlaylistRecord[];
  tracksById: Map<string, TrackRecord>;
}

interface UsePlaybackPersistenceOptions {
  libraryStore: LibraryStore;
  playlistPlayer: PlaylistPlayer;
  /** Same shape as each app's own library refresh - called once on mount to get the roots/playlists/tracks to restore against. */
  refresh: () => Promise<RootWithLibrary[]>;
  setPlayerState: (state: PlaylistPlayerState) => void;
  /** Points the caller's activeTracksById (a module-level map PlaylistPlayer's resolveTrack callback reads from) at the restored playlist's tracks. */
  setActiveTracksById: (tracksById: Map<string, TrackRecord>) => void;
  /** Switches the caller's screen state to the restored playlist once one was found. */
  onRestoreScreen: (root: GrantedRoot, playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>) => void;
  onError: (error: unknown) => void;
  /** Advances the caller's restoring checklist (see RestoringScreen/useRestoringProgress) to this step - `refresh` itself advances its own earlier steps directly. */
  onStepChange?: (step: RestoringStepKey) => void;
}

/**
 * Shared by both apps' App.tsx: persists playlist/track/position/loop/
 * shuffle/volume as they change (see persistPlaybackPatch/persistPositionIfDue),
 * and on mount restores the last playback state - loading the matching
 * playlist into PlaylistPlayer, seeking to the saved position, and leaving
 * it paused (never autoplaying on a fresh launch).
 *
 * isRestoring stays true for that whole restore window so a caller can hold
 * off rendering its normal library/playlist screens until the right one is
 * known - without that, the library screen would render first and only
 * jump to a restored playlist screen a beat later, reading as a flash
 * rather than landing directly on the right screen.
 */
export function usePlaybackPersistence({
  libraryStore,
  playlistPlayer,
  refresh,
  setPlayerState,
  setActiveTracksById,
  onRestoreScreen,
  onError,
  onStepChange,
}: UsePlaybackPersistenceOptions): {
  isRestoring: boolean;
  /**
   * `debounceMs` delays only the actual storage write (SQLite on Android,
   * IndexedDB on web) by that long, coalescing rapid-fire calls into one -
   * `playbackStateRef.current` (and so the in-memory state every other
   * call site's merge sees) is still updated immediately either way, only
   * the disk write is deferred. Needed for a caller like a slider's drag
   * handler that fires on every touch-move tick (VolumeButton/VolumeSlider
   * do, deliberately, so the audible volume itself updates with no lag) -
   * without this, that same rapid-fire rate hit the store on every tick
   * too, and the resulting I/O was visibly janking the drag itself
   * (confirmed on-device).
   */
  persistPlaybackPatch: (patch: Partial<PlaybackState>, options?: { debounceMs?: number }) => void;
  persistPositionIfDue: (state: PlaylistPlayerState) => void;
} {
  const [isRestoring, setIsRestoring] = useState(true);

  // Last known playback state, kept in sync with what's actually persisted -
  // lets every call site merge its own change onto the rest without an
  // async getPlaybackState() round trip first (and without a stale closure
  // clobbering a concurrent change, since this is a ref, not state).
  const playbackStateRef = useRef<PlaybackState>({
    playlistId: null,
    currentTrackFileId: null,
    positionSeconds: 0,
    loopMode: 'off',
    shuffleEnabled: false,
    volume: 1,
  });
  const persistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistPlaybackPatch = useCallback(
    (patch: Partial<PlaybackState>, options?: { debounceMs?: number }) => {
      playbackStateRef.current = { ...playbackStateRef.current, ...patch };
      if (persistDebounceRef.current) {
        clearTimeout(persistDebounceRef.current);
        persistDebounceRef.current = null;
      }
      if (options?.debounceMs) {
        persistDebounceRef.current = setTimeout(() => {
          void libraryStore.putPlaybackState(playbackStateRef.current);
        }, options.debounceMs);
      } else {
        void libraryStore.putPlaybackState(playbackStateRef.current);
      }
    },
    [libraryStore],
  );

  const lastPositionPersistAtRef = useRef(0);
  const persistPositionIfDue = useCallback(
    (state: PlaylistPlayerState) => {
      const now = Date.now();
      if (
        state.currentFileId &&
        (state.track.status === 'playing' || state.track.status === 'paused') &&
        now - lastPositionPersistAtRef.current >= POSITION_PERSIST_INTERVAL_MS
      ) {
        lastPositionPersistAtRef.current = now;
        persistPlaybackPatch({ positionSeconds: state.track.positionSeconds });
      }
    },
    [persistPlaybackPatch],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const withLibrary = await refresh();
      onStepChange?.('restoringPlayback');
      const stored = await libraryStore.getPlaybackState();
      if (cancelled || !stored) return;
      playbackStateRef.current = stored;
      if (!stored.playlistId || !stored.currentTrackFileId) return;
      for (const { root, playlists, tracksById } of withLibrary) {
        const playlist = playlists.find((p) => p.id === stored.playlistId);
        if (!playlist || !playlist.trackFileIds.includes(stored.currentTrackFileId)) continue;
        setActiveTracksById(tracksById);
        playlistPlayer.setShuffle(stored.shuffleEnabled);
        playlistPlayer.setLoopMode(stored.loopMode);
        onStepChange?.('loadingPlaylist');
        // loadPlaylist() (unlike setPlaylist()) decodes without starting
        // playback - restoring on launch shouldn't start audio before the
        // UI has even rendered controls to stop it with.
        await playlistPlayer.loadPlaylist(playlist.trackFileIds, stored.currentTrackFileId);
        if (cancelled) return;
        if (stored.positionSeconds > 0) playlistPlayer.seek(stored.positionSeconds);
        setPlayerState(playlistPlayer.getState());
        onRestoreScreen(root, playlist, tracksById);
        break;
      }
    })()
      .catch(onError)
      .finally(() => {
        if (!cancelled) setIsRestoring(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally run once on mount - refresh/playlistPlayer/setters are
    // stable module-level or memoized references in both callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  return { isRestoring, persistPlaybackPatch, persistPositionIfDue };
}
