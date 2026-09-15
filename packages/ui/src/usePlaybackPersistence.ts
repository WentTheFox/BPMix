import {
  ensureLyricsAssignment,
  FileAccessPermissionPendingError,
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
  /**
   * Used specifically for the restoring track's ensureLyricsAssignment call
   * below - like every other call on this automatic-startup path, there's no
   * user gesture behind it, so a lapsed grant can't be re-prompted for (see
   * FileAccessCallOptions.allowPrompt's doc) without throwing and aborting
   * the whole restore. Defaults to `fileAccess` so a caller that passes a
   * plain adapter still behaves exactly as before - the two platforms
   * without this permission model, Android/Windows, ignore allowPrompt
   * entirely either way.
   */
  backgroundFileAccess?: FileAccess;
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
  /**
   * Switches the caller's screen state to whatever was last open -
   * `opened` is null when the user was explicitly on the Library screen
   * (see PlaybackState.openedPlaylistId's doc), non-null for a playlist
   * screen (which may not be the same playlist as the one actually
   * playing). `nowPlayingOpen` reflects whether the Now Playing screen was
   * showing when this state was last persisted.
   */
  onRestoreScreen: (
    opened: { root: GrantedRoot; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> } | null,
    nowPlayingOpen: boolean,
  ) => void;
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
  backgroundFileAccess = fileAccess,
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
  /**
   * Call this from every manual transport action (both apps already funnel
   * these through a single `transportActionAllowed()` gate - call it there)
   * as soon as the user does anything that starts/changes playback. The
   * on-mount restore below is a slow chain (list roots, scan the target
   * root's library, resolve lyrics assignment, decode the track) that can
   * still be in flight seconds after the screen is already interactive -
   * without this, a user who taps a track before restore finishes can watch
   * their own choice get silently overwritten: PlaylistPlayer is a single
   * shared instance, and loadPlaylistAt/playAt set position/order/
   * trackFileIds synchronously before their own async decode even starts,
   * so a stale restore call reaching that point after a newer manual one
   * already moved on clobbers the bookkeeping (position, currentFileId)
   * back to whatever was persisted from last session - even though the
   * actual audio (correctly guarded by playToken) keeps playing the track
   * the user actually chose. Confirmed on-device: tapping a track during
   * the ~3s restore window on an 858-track library left the mini bar
   * displaying a completely different (stale, previously-playing) track
   * than what was audibly playing, with no new decode/AAudioStream ever
   * firing for the display's track.
   */
  notifyUserTookOver: () => void;
} {
  const [isRestoring, setIsRestoring] = useState(true);
  // Not React state: must take effect synchronously, read from inside the
  // still-running restore effect's closure, same reasoning as
  // hasReadInitialStateRef below.
  const userTookOverRef = useRef(false);
  const notifyUserTookOver = useCallback(() => {
    userTookOverRef.current = true;
  }, []);

  // Last known playback state, kept in sync with what's actually persisted -
  // lets every call site merge its own change onto the rest without an
  // async getPlaybackState() round trip first (and without a stale closure
  // clobbering a concurrent change, since this is a ref, not state).
  const playbackStateRef = useRef<PlaybackState>({
    playlistId: null,
    currentTrackFileId: null,
    rootId: null,
    openedPlaylistId: null,
    openedRootId: null,
    positionSeconds: 0,
    loopMode: 'off',
    shuffleEnabled: false,
    shuffleOrder: null,
    volume: 0.25,
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
          // Uses backgroundFileAccess, not fileAccess - this whole restore
          // effect runs automatically on mount, with no user gesture behind
          // it, so a lapsed browser grant can't be re-requested here (see
          // FileAccessCallOptions.allowPrompt's doc). A permission-pending
          // root just fails to resume this session (same as a genuinely
          // not-found playlist/track below) rather than aborting the rest
          // of restore.
          let loaded: { playlists: PlaylistRecord[]; tracksById: Map<string, TrackRecord> };
          try {
            loaded = await loadRootLibrary(backgroundFileAccess, libraryStore, targetRoot);
          } catch (err) {
            if (!(err instanceof FileAccessPermissionPendingError)) throw err;
            loaded = { playlists: [], tracksById: new Map() };
          }
          const { playlists, tracksById } = loaded;
          if (cancelled) return;
          const playlist = playlists.find((p) => p.id === stored.playlistId);
          const track = playlist ? tracksById.get(stored.currentTrackFileId) : undefined;

          // The user already took a manual playback action (see
          // notifyUserTookOver's doc) while everything above was still in
          // flight - applying this restore now would silently stomp
          // whatever they actually chose. Bails out of resuming a playable
          // screen only; refresh() below (every other root, lyrics
          // auto-match, metadata) is unaffected and still runs.
          if (playlist && track && !userTookOverRef.current) {
            const scopes = await libraryStore.getLyricsScopes();
            if (cancelled) return;
            onLyricsScopesKnown?.(scopes);
            if (scopes.length > 0) {
              onStepChange?.('scanningLyrics');
              const trackName = track.relativePath.split('/').pop() ?? track.relativePath;
              try {
                await ensureLyricsAssignment(backgroundFileAccess, libraryStore, scopes, track.fileId, trackName);
              } catch (err) {
                // No user gesture backs this automatic-startup call either,
                // so a lapsed browser grant can't be re-prompted for here -
                // skip resolving this track's lyrics assignment this run
                // rather than let it abort the rest of restore (below).
                if (!(err instanceof FileAccessPermissionPendingError)) throw err;
              }
              if (cancelled) return;
            }

            // Re-checked here, not just at the top of this block - the
            // ensureLyricsAssignment await above is a real gap where the
            // user's own manual action could have landed in between.
            if (!userTookOverRef.current) {
              setActiveTracksById(tracksById);
              playlistPlayer.setShuffle(stored.shuffleEnabled);
              playlistPlayer.setLoopMode(stored.loopMode);
              onStepChange?.('loadingPlaylist');
              // loadPlaylist() (unlike setPlaylist()) decodes without
              // starting playback - restoring on launch shouldn't start
              // audio before the UI has even rendered controls to stop it
              // with. Not awaited: decoding the track's audio (real file
              // I/O + codec work, unlike everything above) isn't needed to
              // show the restored screen, only to actually play/seek it -
              // the existing ~200ms poll (see both apps' setInterval
              // calling playlistPlayer.getState()) already picks up the
              // status transition from 'loading' to 'paused' as it
              // completes, same as any other track load.
              const loadPromise = playlistPlayer.loadPlaylist(playlist.trackFileIds, stored.currentTrackFileId, {
                shuffleOrder: stored.shuffleOrder ?? undefined,
                playlistId: playlist.id,
              });

              // Resolve which playlist screen to show as "open" - see
              // PlaybackState.openedPlaylistId's doc. `undefined` (the key
              // is simply absent on state persisted before this field
              // existed) falls back to the playing playlist/root/tracksById
              // already resolved above, exactly matching this hook's
              // pre-openedPlaylistId restore behavior for that case.
              let opened: { root: GrantedRoot; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> } | null;
              if (stored.openedPlaylistId === undefined || stored.openedPlaylistId === stored.playlistId) {
                opened = { root: targetRoot, playlist, tracksById };
              } else if (stored.openedPlaylistId === null) {
                opened = null;
              } else {
                // A different root's playlist was open than the one
                // actually playing - same root-then-linear-search
                // resolution as the playing playlist above, just for this
                // one. Left null (falls back to showing Library) if it
                // can't be found - a removed/renamed playlist or a lapsed
                // browser grant on this no-user-gesture startup path (see
                // FileAccessPermissionPendingError below) is no worse than
                // today's "not found" handling for the playing playlist.
                let openedRoot = stored.openedRootId ? roots.find((r) => r.id === stored.openedRootId) : undefined;
                if (!openedRoot) {
                  for (const r of roots) {
                    const openedRootPlaylists = await libraryStore.listPlaylists(r.id);
                    if (cancelled) return;
                    if (openedRootPlaylists.some((p) => p.id === stored.openedPlaylistId)) {
                      openedRoot = r;
                      break;
                    }
                  }
                }
                opened = null;
                if (openedRoot) {
                  try {
                    const openedLoaded = await loadRootLibrary(backgroundFileAccess, libraryStore, openedRoot);
                    if (cancelled) return;
                    const openedPlaylist = openedLoaded.playlists.find((p) => p.id === stored.openedPlaylistId);
                    if (openedPlaylist) opened = { root: openedRoot, playlist: openedPlaylist, tracksById: openedLoaded.tracksById };
                  } catch (err) {
                    if (!(err instanceof FileAccessPermissionPendingError)) throw err;
                  }
                }
              }

              // ?? false covers state persisted before nowPlayingOpen existed
              // (web/Windows store PlaybackState as a plain object, so an
              // older blob simply lacks the field rather than defaulting it).
              onRestoreScreen(opened, stored.nowPlayingOpen ?? false);
              loadPromise
                .then(() => {
                  // One more recheck: the decode itself (loadPromise) can
                  // take real time (file I/O, codec work) - if the user
                  // acted during that window, PlaylistPlayer's own
                  // playToken guard already kept the actual audio correct
                  // (see notifyUserTookOver's doc), but this callback must
                  // not then overwrite the UI's state back to this stale
                  // restore's position/currentFileId regardless.
                  if (cancelled || userTookOverRef.current) return;
                  if (stored.positionSeconds > 0) playlistPlayer.seek(stored.positionSeconds);
                  setPlayerState(playlistPlayer.getState());
                })
                .catch(onError);
            }
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

  return { isRestoring, persistPlaybackPatch, persistPositionIfDue, notifyUserTookOver };
}
