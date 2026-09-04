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

/** How often to persist positionSeconds while a track is playing - frequent enough that a crash/force-quit loses very little progress, infrequent enough not to hammer the store on every ~200ms poll tick. */
const POSITION_PERSIST_INTERVAL_MS = 5000;

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
}: UsePlaybackPersistenceOptions): {
  isRestoring: boolean;
  persistPlaybackPatch: (patch: Partial<PlaybackState>) => void;
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
  const persistPlaybackPatch = useCallback(
    (patch: Partial<PlaybackState>) => {
      playbackStateRef.current = { ...playbackStateRef.current, ...patch };
      void libraryStore.putPlaybackState(playbackStateRef.current);
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
