import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import { errorMessage } from '../../errorMessage';
import { addTracksToPlaylist } from '../../library-scan/addTracksToPlaylist';
import { movePlaylistTracks, removePlaylistTracks } from '../../library-scan/editPlaylistTracks';
import { findUnplaylistedTracksQueued } from '../../library-scan/findUnplaylistedTracks';
import type { PlaylistRecord, TrackRecord } from '../../library-store/types';
import { trackDisplayName } from '../../library-store/trackDisplayName';
import { addError } from '../notifications/notificationsThunks';
import type { RootState } from '../rootReducer';
import type { Services } from '../services';
import {
  addToPlaylistTrackSet,
  openPlaylistTracksMoved,
  openPlaylistTracksRemoved,
  playlistScreenOpened,
  unplaylistedLoaded,
  unplaylistedRequested,
  unplaylistedSettled,
} from './navigationSlice';
import type { PlaylistContext } from './navigationSlice';

type AppThunk<R = void> = ThunkAction<R, RootState, Services, UnknownAction>;

/** Callbacks for the parts that still live outside the store (playback persistence, the root-actions hook's rescan). */
export interface PlaylistActionCallbacks {
  /** Rescans a root after its playlist files changed on disk. */
  rescan: (rootId: string) => unknown;
}

/** Called when a screen is opened, so the caller can persist "last opened playlist" for restore. */
export interface OpenedCallbacks {
  onOpened?: (playlist: PlaylistRecord, rootId: string) => void;
}

export const unplaylistedPlaylistId = (rootId: string) => `virtual:${rootId}:unplaylisted`;
export const nowPlayingPlaylistId = (rootId: string) => `virtual:${rootId}:now-playing`;

const tracksByIdOf = (tracks: TrackRecord[]) => new Map(tracks.map((t) => [t.fileId, t]));

/** Opens a real playlist from the library. */
export function openPlaylist(context: PlaylistContext, callbacks: OpenedCallbacks = {}): AppThunk {
  return (dispatch) => {
    dispatch(playlistScreenOpened(context));
    callbacks.onOpened?.(context.playlist, context.root.id);
  };
}

/**
 * Opens the virtual, never-persisted "Now Playing" playlist - mirrors what's
 * actually playing right now, in file order, or the live shuffled order when
 * shuffle is on (getShuffleOrder() - null when off, since sequential order
 * needs no separate tracking). Everything is already in memory, so no walk.
 * Reads the player directly rather than the mirrored shuffle flag, which
 * matters when called synchronously right after toggling shuffle.
 */
export function showNowPlaying(callbacks: OpenedCallbacks = {}): AppThunk {
  return (dispatch, getState, { playlistPlayer }) => {
    const playing = getState().navigation.playingContext;
    if (!playing) return;
    const { root, playlist: playingPlaylist, tracks } = playing;
    const id = nowPlayingPlaylistId(root.id);
    const playlist: PlaylistRecord = {
      id,
      rootId: root.id,
      fileId: id,
      name: 'Now Playing',
      trackFileIds: playlistPlayer.getShuffleOrder() ?? playingPlaylist.trackFileIds,
    };
    dispatch(playlistScreenOpened({ root, playlist, tracks }));
    callbacks.onOpened?.(playlist, root.id);
  };
}

/**
 * Opens a virtual, never-persisted "songs not in a playlist" playlist for a
 * root. The screen opens immediately, empty, with a "Finding…" notice while
 * the real directory walk runs - awaiting it first could leave the user on
 * the Library screen for a long while on a big root. The tracks themselves DO
 * get persisted by the walk (so metadata/art/playback work normally); only
 * the playlist is recomputed each time, since membership changes whenever
 * another playlist is edited. A result is applied only if it's still the
 * latest request and the screen is still this playlist.
 */
export function showUnplaylisted(rootId: string, callbacks: OpenedCallbacks = {}): AppThunk<Promise<void>> {
  return async (dispatch, getState, { fileAccess, backgroundFileAccess, libraryStore, coverArtResizer }) => {
    const state = getState();
    const playlistId = unplaylistedPlaylistId(rootId);
    // Already viewing this root's Unplaylisted - re-walking on every click just re-shows "Finding…" for no reason.
    if (state.navigation.screen.kind === 'playlist' && state.navigation.screen.playlist.id === playlistId) return;
    const root = state.library.grantedRoots.find((r) => r.id === rootId);
    if (!root) return;
    const empty: PlaylistRecord = { id: playlistId, rootId, fileId: playlistId, name: 'Songs not in a playlist', trackFileIds: [] };
    dispatch(playlistScreenOpened({ root, playlist: empty, tracks: [] }));
    callbacks.onOpened?.(empty, root.id);
    dispatch(unplaylistedRequested());
    const requestId = getState().navigation.unplaylistedRequestId;
    try {
      const tracks = await findUnplaylistedTracksQueued(fileAccess, libraryStore, rootId, root.displayName, {
        fileAccess: backgroundFileAccess,
        resizer: coverArtResizer,
      });
      if (getState().navigation.unplaylistedRequestId !== requestId) return;
      dispatch(unplaylistedLoaded({ playlist: { ...empty, trackFileIds: tracks.map((t) => t.fileId) }, tracks }));
    } finally {
      dispatch(unplaylistedSettled(requestId));
    }
  };
}

/** The open playlist screen as the pieces the file-editing helpers take, or null if a playlist isn't open. */
function openPlaylistOf(getState: () => RootState) {
  const { screen } = getState().navigation;
  return screen.kind === 'playlist' ? { root: screen.root, playlist: screen.playlist, tracksById: tracksByIdOf(screen.tracks) } : null;
}

/**
 * Moves tracks within the open real playlist (writing its .m3u8), patches the
 * open screen's order immediately - nothing reconciles the open screen
 * against a rescan's result, so without this the reorder would look like it
 * did nothing until the playlist was reopened - then rescans.
 */
export function moveOpenPlaylistTracks(
  movingFileIds: string[],
  anchorFileId: string,
  position: 'before' | 'after',
  callbacks: PlaylistActionCallbacks,
): AppThunk<Promise<void>> {
  return async (dispatch, getState, { fileAccess }) => {
    const open = openPlaylistOf(getState);
    if (!open) return;
    try {
      await movePlaylistTracks(fileAccess, open.root.id, open.playlist, open.tracksById, movingFileIds, anchorFileId, position);
      dispatch(openPlaylistTracksMoved({ playlistId: open.playlist.id, movingFileIds, anchorFileId, position }));
      void callbacks.rescan(open.root.id);
    } catch (err) {
      dispatch(addError(`Couldn't reorder "${open.playlist.name}"`, errorMessage(err)));
    }
  };
}

/** Removes tracks from the open real playlist (writing its .m3u8), patches the open screen immediately, then rescans. */
export function removeOpenPlaylistTracks(fileIds: string[], callbacks: PlaylistActionCallbacks): AppThunk<Promise<void>> {
  return async (dispatch, getState, { fileAccess }) => {
    const open = openPlaylistOf(getState);
    if (!open) return;
    try {
      await removePlaylistTracks(fileAccess, open.root.id, open.playlist, open.tracksById, fileIds);
      dispatch(openPlaylistTracksRemoved({ playlistId: open.playlist.id, fileIds }));
      void callbacks.rescan(open.root.id);
    } catch (err) {
      dispatch(addError(`Couldn't remove tracks from "${open.playlist.name}"`, errorMessage(err)));
    }
  };
}

/**
 * Adds the pending "add to playlist" track to `playlist`, then drops it from
 * the open Unplaylisted view immediately rather than waiting on the rescan -
 * findUnplaylistedTracks won't offer it again once the rescanned playlist
 * references it, but that can take a moment on a big root.
 */
export function addPendingTrackToPlaylist(
  playlist: PlaylistRecord,
  position: 'start' | 'end',
  callbacks: PlaylistActionCallbacks,
): AppThunk<Promise<void>> {
  return async (dispatch, getState, { fileAccess }) => {
    const state = getState();
    const track = state.navigation.addToPlaylistTrack;
    const open = openPlaylistOf(getState);
    if (!track || !open) return;
    try {
      await addTracksToPlaylist(fileAccess, open.root.id, playlist, [track], position);
      dispatch(openPlaylistTracksRemoved({ playlistId: open.playlist.id, fileIds: [track.fileId] }));
      dispatch(addToPlaylistTrackSet(null));
      void callbacks.rescan(open.root.id);
    } catch (err) {
      dispatch(addError(`Couldn't add "${trackDisplayName(track)}" to "${playlist.name}"`, errorMessage(err)));
    }
  };
}
