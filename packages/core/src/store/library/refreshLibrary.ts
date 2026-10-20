import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import { FileAccessPermissionPendingError } from '../../file-access/types';
import { errorMessage } from '../../errorMessage';
import { pruneOrphanedRootData } from '../../library-scan/pruneOrphanedRootData';
import { scanRootCoordinated } from '../../library-scan/scanCoordinator';
import { LYRICS_MATCHED_COUNT_SETTING_KEY, matchLibraryLyricsQueued } from '../../lyrics/matchLibraryLyrics';
import { scanLibraryMetadataQueued } from '../../metadata/scanLibraryMetadata';
import { logLibraryAction } from '../../playback/playbackLog';
import { playingContextRefreshed } from '../navigation/navigationSlice';
import { playbackPatched } from '../persistence/persistenceSlice';
import { lyricsScopesKnown, restoreStepAdvanced } from '../restore/restoreSlice';
import type { RootState } from '../rootReducer';
import type { Services } from '../services';
import {
  grantedRootsLoaded,
  libraryErrorSet,
  libraryLoaded,
  lyricsScopesLoaded,
  matchedLyricsCountDecremented,
  matchedLyricsCountSet,
  orphanPruneStarted,
  rootsLoadFailed,
} from './librarySlice';
import type { LibraryRootData, RootWithLibrary } from './types';

type AppThunk<R> = ThunkAction<R, RootState, Services, UnknownAction>;

const realTracks = (roots: RootWithLibrary[]) => roots.flatMap(({ tracksById }) => [...tracksById.values()].filter((t) => !t.missing));

/**
 * (Re)loads everything derived from the granted roots: lists the roots,
 * scans/loads each library root, loads lyrics scopes, then kicks off the
 * background lyrics-match and metadata passes and reconciles the playing
 * playlist. Resolves with the loaded roots as soon as they're in the store;
 * the lyrics/metadata passes are fire-and-forget. Rejects only if the roots
 * can't be listed at all - one bad root just reports its own error and drops
 * out, leaving the rest of the library visible.
 *
 * Uses `backgroundFileAccess` throughout: this runs automatically (on mount,
 * after restore) with no user gesture behind it, so it must never trigger a
 * permission prompt.
 */
export function refreshLibrary(): AppThunk<Promise<RootWithLibrary[]>> {
  return async (dispatch, getState, { fileAccess, backgroundFileAccess, libraryStore, playlistPlayer, livePlayback, coverArtResizer, alwaysRescanRoot }) => {
    dispatch(restoreStepAdvanced('listingFolders'));
    let roots;
    try {
      roots = await fileAccess.listGrantedRoots();
    } catch (err) {
      dispatch(rootsLoadFailed());
      throw err;
    }
    dispatch(grantedRootsLoaded(roots));

    // Self-heals installs from before removeRoot cleaned up after itself (see
    // pruneOrphanedRootData's own doc) - fire-and-forget, never awaited, so a
    // large orphaned-data scan can't delay the rest of this refresh or
    // RestoringScreen. Once per launch.
    if (!getState().library.orphanPruneStarted) {
      dispatch(orphanPruneStarted());
      void pruneOrphanedRootData(
        libraryStore,
        roots.map((root) => root.id),
      )
        .then((prunedRootIds) => {
          if (prunedRootIds.length > 0) logLibraryAction('pruneOrphanedRootData', { prunedRootIds });
        })
        .catch((err) => {
          logLibraryAction('pruneOrphanedRootData:failed', { error: String(err) });
        });
    }

    dispatch(restoreStepAdvanced('scanningLibrary'));

    // Each root is isolated in its own try/catch - one bad root (a
    // moved/deleted folder, a native file-access error) used to reject the
    // whole Promise.all and blank the ENTIRE library on every refresh until
    // the bad root was removed.
    const loaded = await Promise.all(
      // A 'lyrics' root (see GrantedRoot.kind's doc) is never a music library
      // - scanning/listing it here would just show a permanently-empty entry.
      roots
        .filter((root) => (root.kind ?? 'library') === 'library')
        .map(async (root): Promise<LibraryRootData | null> => {
          try {
            let [playlists, tracks] = await Promise.all([libraryStore.listPlaylists(root.id), libraryStore.listTracks(root.id)]);
            // A root can reach listGrantedRoots() without ever going through
            // addFolder's explicit requestRoot+scanRoot flow - e.g. a
            // self-hosted server root just by having a volume mounted. Scan
            // it now instead of silently showing an empty library until the
            // user clicks Rescan. Some roots (the self-hosted server's) are
            // always rescanned, since their files can change on disk with
            // zero app interaction and there's no OS permission prompt to
            // worry about triggering outside a gesture.
            if ((playlists.length === 0 && tracks.length === 0) || alwaysRescanRoot(root.id)) {
              await scanRootCoordinated(backgroundFileAccess, libraryStore, root.id, root.displayName);
              [playlists, tracks] = await Promise.all([libraryStore.listPlaylists(root.id), libraryStore.listTracks(root.id)]);
            }
            return { root, playlists, tracks };
          } catch (err) {
            // A lapsed browser grant can't be re-requested from this
            // non-gesture scan - the root just stays empty until a real click
            // re-grants it, rather than surfacing the browser's raw
            // permission-error text as if it were a real bug.
            if (!(err instanceof FileAccessPermissionPendingError)) {
              dispatch(libraryErrorSet(errorMessage(err)));
              logLibraryAction('refresh:rootFailed', { rootId: root.id, error: String(err) });
            }
            return null;
          }
        }),
    );
    const rootData = loaded.filter((entry): entry is LibraryRootData => entry !== null);
    dispatch(libraryLoaded(rootData));
    const withLibrary: RootWithLibrary[] = rootData.map(({ root, playlists, tracks }) => ({
      root,
      playlists,
      tracksById: new Map(tracks.map((t) => [t.fileId, t])),
    }));

    // A 'lyrics'-kind root can reach listGrantedRoots() without addLyricsFolder's
    // own gesture (e.g. the self-hosted server exposing one just by having the
    // volume mounted). addLyricsScope is an upsert, so repeating it per
    // refresh is a no-op.
    await Promise.all(roots.filter((root) => root.kind === 'lyrics').map((root) => libraryStore.addLyricsScope({ rootId: root.id, relativePath: '' })));

    // Lyrics scopes are subfolders of an already-granted root (see
    // LyricsScope's doc), so just walk each configured scope for .lrc files.
    const scopes = await libraryStore.getLyricsScopes();
    dispatch(lyricsScopesLoaded(scopes));
    dispatch(lyricsScopesKnown(scopes.length > 0));

    const getPriorityFileIds = () => {
      const state = playlistPlayer.getState();
      const nextFileId = playlistPlayer.getNextFileId();
      return [state.currentFileId, nextFileId].filter((id): id is string => id != null);
    };

    // Auto-assign any track without a lyrics match (a manual override is never
    // overwritten). Recomputed on every refresh rather than cached, since a
    // scope's contents can change between scans.
    if (scopes.length > 0) {
      dispatch(restoreStepAdvanced('scanningLyrics'));
      // Optimistic starting display: last launch's exact final count, so a
      // library that hasn't changed since (the common case) never visibly
      // moves; the pass below only ticks it down on an anomaly, then snaps to
      // the true count and persists it as next launch's baseline.
      const lastKnownCount = await libraryStore.getSetting(LYRICS_MATCHED_COUNT_SETTING_KEY);
      dispatch(matchedLyricsCountSet(lastKnownCount != null ? Number(lastKnownCount) : null));
      // A missing-track placeholder (see TrackRecord.missing) has no real file
      // to match against - excluded rather than let the scan fail on it.
      // Idle-chunked and fire-and-forget: the restoring track's own
      // assignment is resolved separately (see usePlaybackPersistence).
      void matchLibraryLyricsQueued(backgroundFileAccess, libraryStore, scopes, realTracks(withLibrary), {
        // Only drives the display for a first-ever run (no baseline to start
        // optimistic from) - otherwise onAnomaly/onSettled own it so it doesn't
        // jump down to a small live count and re-climb every launch.
        onProgress: (matchedCount) => {
          if (lastKnownCount == null) dispatch(matchedLyricsCountSet(matchedCount));
        },
        onAnomaly: () => {
          if (lastKnownCount != null) dispatch(matchedLyricsCountDecremented());
        },
        onSettled: (matchedCount) => {
          dispatch(matchedLyricsCountSet(matchedCount));
          void libraryStore.putSetting(LYRICS_MATCHED_COUNT_SETTING_KEY, String(matchedCount));
        },
        getPriorityFileIds,
      }).catch((err) => {
        dispatch(libraryErrorSet(errorMessage(err)));
        logLibraryAction('matchLibraryLyrics:failed', { error: String(err) });
      });
    } else {
      dispatch(matchedLyricsCountSet(null));
    }

    // Fire-and-forget: fills in real titles/artists as it goes (each row's
    // useTrackMetadata retry-polls the store) instead of blocking the library
    // screen on reading every file's tag bytes. Cheap to repeat - fresh tracks
    // are skipped. Chunked against real idle time and queued as a background
    // task (see taskQueue.ts), so it pauses while a folder scan runs.
    void scanLibraryMetadataQueued({ id: 'metadata-scan', label: 'Scanning track metadata' }, backgroundFileAccess, libraryStore, realTracks(withLibrary), {
      resizer: coverArtResizer,
      // Bumps what's on screen (now playing + up next) ahead of the rest of the
      // library, evaluated fresh each step.
      getPriorityFileIds,
    });

    // The now-playing playlist's .m3u8 may have been rescanned (this refresh,
    // a manual Rescan, or a sync tool dropping in a file) since playback
    // started - reconcile PlaylistPlayer's running order against the fresh
    // scan (see reconcilePlaylist's doc for why a plain setPlaylist() reload
    // isn't used: it would restart shuffle/position bookkeeping).
    const nowPlayingPlaylistId = playlistPlayer.getCurrentPlaylistId();
    if (nowPlayingPlaylistId) {
      for (const { playlists, tracksById } of withLibrary) {
        const nowPlayingPlaylist = playlists.find((p) => p.id === nowPlayingPlaylistId);
        if (nowPlayingPlaylist) {
          playlistPlayer.reconcilePlaylist(nowPlayingPlaylist.trackFileIds);
          dispatch(playingContextRefreshed({ playlist: nowPlayingPlaylist, tracks: [...tracksById.values()] }));
          livePlayback.publish();
          dispatch(playbackPatched({ patch: { shuffleOrder: playlistPlayer.getShuffleOrder() } }));
          break;
        }
      }
    }

    return withLibrary;
  };
}
