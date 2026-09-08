import {
  ensureLyricsAssignment,
  loadRootLibrary,
  type FileAccess,
  type GrantedRoot,
  type LibraryStore,
  type LyricsScope,
  type PlaybackState,
  type PlaylistPlayer,
  type PlaylistPlayerState,
  type PlaylistRecord,
  type TrackRecord,
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
  fileAccess: FileAccess;
  libraryStore: LibraryStore;
  playlistPlayer: PlaylistPlayer;
  /**
   * Same shape as each app's own library refresh - populates the rest of
   * the app's state (every other granted root, the full-library lyrics
   * auto-match pass, ID3 metadata) once restore no longer needs to wait on
   * it. Called fire-and-forget, in the background, after the narrow restore
   * path below has already found (or ruled out) a playlist to resume - see
   * CLAUDE.md's note on why this path must stay narrow.
   */
  refresh: () => Promise<RootWithLibrary[]>;
  setPlayerState: (state: PlaylistPlayerState) => void;
  /** Points the caller's activeTracksById (a module-level map PlaylistPlayer's resolveTrack callback reads from) at the restored playlist's tracks. */
  setActiveTracksById: (tracksById: Map<string, TrackRecord>) => void;
  /** Switches the caller's screen state to the restored playlist once one was found - nowPlayingOpen reflects whether the Now Playing screen was showing when this state was last persisted. */
  onRestoreScreen: (root: GrantedRoot, playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>, nowPlayingOpen: boolean) => void;
  onError: (error: unknown) => void;
  /** Advances the caller's restoring checklist (see RestoringScreen/useRestoringProgress) to this step. */
  onStepChange?: (step: RestoringStepKey) => void;
  /** Called as soon as the configured lyrics scopes are known (before `refresh` has necessarily resolved), so the caller can drive RestoringScreen's "hasLyricsScopes" row without waiting on the background refresh. */
  onLyricsScopesKnown?: (scopes: LyricsScope[]) => void;
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
  fileAccess,
  libraryStore,
  playlistPlayer,
  refresh,
  setPlayerState,
  setActiveTracksById,
  onRestoreScreen,
  onError,
  onStepChange,
  onLyricsScopesKnown,
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
    rootId: null,
    positionSeconds: 0,
    loopMode: 'off',
    shuffleEnabled: false,
    volume: 1,
    nowPlayingOpen: false,
  });
  // Guards persistPlaybackPatch against writing playbackStateRef's still-
  // default placeholder over real persisted state - see its doc for the
  // race this closes. Not React state: flipping it must take effect
  // synchronously, mid-effect, not after a re-render.
  const hasReadInitialStateRef = useRef(false);
  const persistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistPlaybackPatch = useCallback(
    (patch: Partial<PlaybackState>, options?: { debounceMs?: number }) => {
      if (!hasReadInitialStateRef.current) return;
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
      onStepChange?.('listingFolders');
      const stored = await libraryStore.getPlaybackState();
      onStepChange?.('restoringPlayback');
      if (cancelled) return;
      if (stored) playbackStateRef.current = stored;
      // From here on, playbackStateRef holds the real persisted state (or a
      // legitimate "nothing was ever saved" default) - safe for
      // persistPlaybackPatch to merge onto and write back. Before this
      // point it was just this hook's own useRef initializer, and the
      // ~200ms poll (see both apps' setInterval calling
      // persistPositionIfDue) starts calling in on every mount, restore or
      // not - on a dev-mode Fast Refresh remount specifically, the
      // module-level PlaylistPlayer singleton survives with a real
      // currentFileId/status already set (see App.tsx's module.hot.dispose
      // doc) while this hook's own refs reset fresh, so that poll could
      // otherwise race ahead of the read above and write the placeholder
      // default (nulling playlistId/nowPlayingOpen/etc.) over what was
      // actually saved - confirmed on-device: nowPlayingOpen silently
      // reverted to false after nothing but a Fast Refresh in between.
      hasReadInitialStateRef.current = true;

      // Restore only the one root/playlist/track we actually need to reach
      // a playable screen - everything else (every other granted root, the
      // full-library lyrics auto-match pass, ID3 metadata) is deferred to
      // the `refresh()` call below, fired off in the background once this
      // is done rather than awaited first. See CLAUDE.md's note on why this
      // path must stay narrow.
      if (stored?.playlistId && stored?.currentTrackFileId) {
        const roots = await fileAccess.listGrantedRoots();
        if (cancelled) return;

        let targetRoot = stored.rootId ? roots.find((r) => r.id === stored.rootId) : undefined;
        if (!targetRoot) {
          // Older persisted state (no rootId yet) or a stale/removed root -
          // fall back to a linear search over each granted root's already-
          // cached playlists. Still cheap: a plain store read, never a scan.
          for (const root of roots) {
            const playlists = await libraryStore.listPlaylists(root.id);
            if (cancelled) return;
            if (playlists.some((p) => p.id === stored.playlistId)) {
              targetRoot = root;
              break;
            }
          }
        }

        if (targetRoot) {
          onStepChange?.('scanningLibrary');
          const { playlists, tracksById } = await loadRootLibrary(fileAccess, libraryStore, targetRoot);
          if (cancelled) return;
          const playlist = playlists.find((p) => p.id === stored.playlistId);
          const track = playlist ? tracksById.get(stored.currentTrackFileId) : undefined;

          if (playlist && track) {
            const scopes = await libraryStore.getLyricsScopes();
            if (cancelled) return;
            onLyricsScopesKnown?.(scopes);
            if (scopes.length > 0) {
              onStepChange?.('scanningLyrics');
              const trackName = track.relativePath.split('/').pop() ?? track.relativePath;
              await ensureLyricsAssignment(fileAccess, libraryStore, scopes, track.fileId, trackName);
              if (cancelled) return;
            }

            setActiveTracksById(tracksById);
            playlistPlayer.setShuffle(stored.shuffleEnabled);
            playlistPlayer.setLoopMode(stored.loopMode);
            onStepChange?.('loadingPlaylist');
            // loadPlaylist() (unlike setPlaylist()) decodes without starting
            // playback - restoring on launch shouldn't start audio before
            // the UI has even rendered controls to stop it with. Not
            // awaited: decoding the track's audio (real file I/O + codec
            // work, unlike everything above) isn't needed to show the
            // restored screen, only to actually play/seek it - the existing
            // ~200ms poll (see both apps' setInterval calling
            // playlistPlayer.getState()) already picks up the status
            // transition from 'loading' to 'paused' as it completes, same
            // as any other track load.
            const loadPromise = playlistPlayer.loadPlaylist(playlist.trackFileIds, stored.currentTrackFileId);
            // ?? false covers state persisted before nowPlayingOpen existed
            // (web/Windows store PlaybackState as a plain object, so an
            // older blob simply lacks the field rather than defaulting it).
            onRestoreScreen(targetRoot, playlist, tracksById, stored.nowPlayingOpen ?? false);
            loadPromise
              .then(() => {
                if (cancelled) return;
                if (stored.positionSeconds > 0) playlistPlayer.seek(stored.positionSeconds);
                setPlayerState(playlistPlayer.getState());
              })
              .catch(onError);
          }
        }
      }

      // Fire-and-forget: fills in every other root, the full-library lyrics
      // auto-match, and metadata now that they're no longer on the critical
      // path (refresh() itself already backgrounds/idle-chunks the parts
      // that can be).
      refresh().catch(onError);
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
