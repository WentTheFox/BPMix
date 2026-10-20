import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import { errorMessage } from '../../errorMessage';
import { FileAccessPermissionPendingError } from '../../file-access/types';
import type { GrantedRoot } from '../../file-access/types';
import { loadRootLibrary } from '../../library-scan/loadRootLibrary';
import type { PlaylistRecord, TrackRecord } from '../../library-store/types';
import { ensureLyricsAssignment } from '../../lyrics/ensureLyricsAssignment';
import { logLibraryAction } from '../../playback/playbackLog';
import { libraryErrorSet, lyricsScopesLoaded } from '../library/librarySlice';
import { refreshLibrary } from '../library/refreshLibrary';
import { playbackRestored, playingContextSet, toPlaylistContext } from '../navigation/navigationSlice';
import { playbackStateRead } from '../persistence/persistenceSlice';
import type { RootState } from '../rootReducer';
import type { Services } from '../services';
import { lyricsScopesKnown, restoreFinished, restoreStepAdvanced } from './restoreSlice';

type AppThunk<R> = ThunkAction<R, RootState, Services, UnknownAction>;

interface Loaded {
  root: GrantedRoot;
  playlist: PlaylistRecord;
  tracksById: Map<string, TrackRecord>;
}

export interface RestorePlaybackOptions {
  /** True once the caller no longer wants this restore applied (the app unmounted). Checked after every await, like the user-took-over flag. */
  isCancelled: () => boolean;
}

/**
 * Restores the last playback state on launch: loads the matching playlist
 * into the player, seeks to the saved position, and leaves it paused (never
 * autoplays on a fresh launch). Resolves once the screen-critical part is
 * done; the rest of the library loads in the background (refreshLibrary).
 *
 * Startup-latency rule (CLAUDE.md): this may only block on the last-played
 * root/playlist and the current track's lyrics assignment. Every other root,
 * library-wide lyrics matching and metadata scanning stays background work
 * that live-merges in afterward - don't add to what this awaits.
 *
 * Races it guards: `userTookOver` (see RestoreState) and `isCancelled`,
 * re-checked after each await and again right before touching the player.
 * The decode itself (loadPromise) is deliberately NOT awaited here - only
 * the position seek and live-state publish wait on it.
 */
export function restorePlayback({ isCancelled }: RestorePlaybackOptions): AppThunk<Promise<void>> {
  return async (dispatch, getState, services) => {
    const { fileAccess, backgroundFileAccess, libraryStore, playlistPlayer, livePlayback, initialPlaybackState } = services;
    const tookOver = () => getState().restore.userTookOver;
    const onError = (err: unknown) => {
      dispatch(libraryErrorSet(errorMessage(err)));
      logLibraryAction('playbackPersistence:failed', { error: String(err) });
    };

    try {
      dispatch(restoreStepAdvanced('listingFolders'));
      // The SAME fetch playlistPlayer.awaitInitialVolume() (called at module
      // level, earlier than this can possibly run) is also awaiting - not a
      // second one.
      const stored = await initialPlaybackState;
      dispatch(restoreStepAdvanced('restoringPlayback'));
      if (isCancelled()) return;
      // From here on the persisted state is real (or a legitimate "nothing
      // was ever saved" default), so it's safe for patches to merge onto it
      // and write it back - see PersistenceState.ready.
      dispatch(playbackStateRead(stored));
      // Idempotent with the module-level awaitInitialVolume's own setVolume
      // on the same resolved value - this one makes the displayed volume
      // (gated on isRestoring) pick up the real value too, not just the
      // player's internal gain.
      if (stored) playlistPlayer.setVolume(stored.volume);

      // Restore only the one root/playlist/track needed to reach a playable
      // screen - everything else is deferred to refreshLibrary below.
      if (stored?.playlistId && stored?.currentTrackFileId) {
        const roots = await fileAccess.listGrantedRoots();
        if (isCancelled()) return;

        let targetRoot = stored.rootId ? roots.find((r) => r.id === stored.rootId) : undefined;
        if (!targetRoot) {
          // Older persisted state (no rootId yet) or a stale/removed root -
          // fall back to a linear search over each granted root's already-
          // cached playlists. Still cheap: a plain store read, never a scan.
          for (const root of roots) {
            const playlists = await libraryStore.listPlaylists(root.id);
            if (isCancelled()) return;
            if (playlists.some((p) => p.id === stored.playlistId)) {
              targetRoot = root;
              break;
            }
          }
        }

        if (targetRoot) {
          dispatch(restoreStepAdvanced('scanningLibrary'));
          // backgroundFileAccess, not fileAccess: no user gesture backs this
          // automatic startup path, so a lapsed browser grant can't be
          // re-requested. A permission-pending root just fails to resume this
          // session (same as a not-found playlist/track) rather than aborting
          // the rest of restore.
          let loaded: { playlists: PlaylistRecord[]; tracksById: Map<string, TrackRecord> };
          try {
            loaded = await loadRootLibrary(backgroundFileAccess, libraryStore, targetRoot);
          } catch (err) {
            if (!(err instanceof FileAccessPermissionPendingError)) throw err;
            loaded = { playlists: [], tracksById: new Map() };
          }
          const { playlists, tracksById } = loaded;
          if (isCancelled()) return;
          const playlist = playlists.find((p) => p.id === stored.playlistId);
          const track = playlist ? tracksById.get(stored.currentTrackFileId) : undefined;

          // The user already took a manual playback action while everything
          // above was in flight - applying this now would silently stomp
          // their choice. Bails out of resuming a playable screen only;
          // refreshLibrary below (every other root, lyrics auto-match,
          // metadata) is unaffected and still runs.
          if (playlist && track && !tookOver()) {
            const scopes = await libraryStore.getLyricsScopes();
            if (isCancelled()) return;
            dispatch(lyricsScopesLoaded(scopes));
            dispatch(lyricsScopesKnown(scopes.length > 0));
            if (scopes.length > 0) {
              dispatch(restoreStepAdvanced('scanningLyrics'));
              const trackName = track.relativePath.split('/').pop() ?? track.relativePath;
              try {
                await ensureLyricsAssignment(backgroundFileAccess, libraryStore, scopes, track.fileId, trackName);
              } catch (err) {
                // No user gesture backs this call either: skip resolving this
                // track's lyrics assignment this run rather than let a lapsed
                // grant abort the rest of restore.
                if (!(err instanceof FileAccessPermissionPendingError)) throw err;
              }
              if (isCancelled()) return;
            }

            // Re-checked here, not just above - the ensureLyricsAssignment
            // await is a real gap where the user's own action could land.
            if (!tookOver()) {
              // Before loadPlaylist: the player resolves tracks through the
              // playing context, possibly synchronously from its first decode.
              dispatch(playingContextSet(toPlaylistContext(targetRoot, playlist, tracksById)));
              playlistPlayer.setShuffle(stored.shuffleEnabled);
              playlistPlayer.setLoopMode(stored.loopMode);
              dispatch(restoreStepAdvanced('loadingPlaylist'));
              // loadPlaylist() (unlike setPlaylist()) decodes without
              // starting playback. Not awaited: decoding (real file I/O +
              // codec work) isn't needed to show the restored screen, only to
              // play/seek it - the ticker picks up the 'loading' -> 'paused'
              // transition as it completes, like any other track load.
              const loadPromise = playlistPlayer.loadPlaylist(playlist.trackFileIds, stored.currentTrackFileId, {
                shuffleOrder: stored.shuffleOrder ?? undefined,
                playlistId: playlist.id,
              });

              // Which playlist screen to show as "open" - see
              // PlaybackState.openedPlaylistId's doc. `undefined` (absent on
              // state persisted before the field existed) falls back to the
              // playing playlist, matching the pre-field behavior.
              let opened: Loaded | null;
              if (stored.openedPlaylistId === undefined || stored.openedPlaylistId === stored.playlistId) {
                opened = { root: targetRoot, playlist, tracksById };
              } else if (stored.openedPlaylistId === null) {
                opened = null;
              } else {
                // A different playlist was open than the one playing - same
                // root-then-linear-search resolution as above. Left null
                // (shows Library) if it can't be found - a removed/renamed
                // playlist or a lapsed grant is no worse than "not found" for
                // the playing playlist.
                let openedRoot = stored.openedRootId ? roots.find((r) => r.id === stored.openedRootId) : undefined;
                if (!openedRoot) {
                  for (const r of roots) {
                    const openedRootPlaylists = await libraryStore.listPlaylists(r.id);
                    if (isCancelled()) return;
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
                    if (isCancelled()) return;
                    const openedPlaylist = openedLoaded.playlists.find((p) => p.id === stored.openedPlaylistId);
                    if (openedPlaylist) opened = { root: openedRoot, playlist: openedPlaylist, tracksById: openedLoaded.tracksById };
                  } catch (err) {
                    if (!(err instanceof FileAccessPermissionPendingError)) throw err;
                  }
                }
              }

              // ?? false covers state persisted before nowPlayingOpen existed
              // (web/Windows store PlaybackState as a plain object, so an
              // older blob simply lacks the field).
              dispatch(
                playbackRestored({
                  opened: opened && toPlaylistContext(opened.root, opened.playlist, opened.tracksById),
                  nowPlayingOpen: stored.nowPlayingOpen ?? false,
                  playing: toPlaylistContext(targetRoot, playlist, tracksById),
                }),
              );
              loadPromise
                .then(() => {
                  // One more recheck: the decode can take real time - if the
                  // user acted during it, the player's own playToken guard
                  // already kept the audio correct, but this must not
                  // overwrite the UI back to this stale restore's state.
                  if (isCancelled() || tookOver()) return;
                  if (stored.positionSeconds > 0) playlistPlayer.seek(stored.positionSeconds);
                  livePlayback.publish();
                })
                .catch(onError);
            }
          }
        }
      }

      // Fire-and-forget: every other root, the full-library lyrics auto-match
      // and metadata, now that they're off the critical path.
      dispatch(refreshLibrary()).catch(onError);
    } catch (err) {
      onError(err);
    } finally {
      if (!isCancelled()) dispatch(restoreFinished());
    }
  };
}
