import {
  addPendingTrackToPlaylist,
  addToPlaylistTrackSet,
  editingPlaylistFileSet,
  libraryScreenOpened,
  moveOpenPlaylistTracks,
  openPlaylist,
  playingContextSetFromScreen,
  removeOpenPlaylistTracks,
  selectPlayingContext,
  selectScreen,
  showNowPlaying,
  showUnplaylisted,
  toPlaylistContext,
} from '@bpmix/core';
import type { GrantedRoot, OpenedCallbacks, OpenScreen, PlayingContext, PlaylistRecord, TrackRecord } from '@bpmix/core';
import { useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';

type LoadedPlaylist = { root: GrantedRoot; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> };

export interface PlaylistScreenView {
  /** Whichever screen is currently open. */
  screen: OpenScreen;
  /** The playlist that's actually playing - not necessarily `screen`. Null only before the startup restore resolves. */
  playingContext: PlayingContext | null;
  editingPlaylistFile: { root: GrantedRoot; playlist: PlaylistRecord } | null;
  addToPlaylistTrack: TrackRecord | null;
  /** True while the Unplaylisted directory walk is in flight. */
  isFindingUnplaylisted: boolean;
}

export interface PlaylistScreenActions {
  openLibrary: () => void;
  openPlaylist: (loaded: LoadedPlaylist, callbacks?: OpenedCallbacks) => void;
  /** A track started playing from the open playlist: make that the playing one. */
  markOpenPlaylistPlaying: () => void;
  setEditingPlaylistFile: (target: { root: GrantedRoot; playlist: PlaylistRecord } | null) => void;
  setAddToPlaylistTrack: (track: TrackRecord | null) => void;
  showNowPlaying: (callbacks?: OpenedCallbacks) => void;
  showUnplaylisted: (rootId: string, callbacks?: OpenedCallbacks) => Promise<void>;
  moveTracks: (movingFileIds: string[], anchorFileId: string, position: 'before' | 'after', rescan: (rootId: string) => unknown) => Promise<void>;
  removeTracks: (fileIds: string[], rescan: (rootId: string) => unknown) => Promise<void>;
  addPendingTrackToPlaylist: (playlist: PlaylistRecord, position: 'start' | 'end', rescan: (rootId: string) => unknown) => Promise<void>;
}

/**
 * The open playlist screen, the playing playlist, and the edit/add-to-playlist
 * targets from the store's `navigation` slice, as views plus stable actions,
 * shared by both apps. Opening/closing a screen doesn't persist "last opened"
 * by itself - callers pass `onOpened` (or persist on close) since playback
 * persistence still lives in usePlaybackPersistence.
 */
export function usePlaylistScreen(): PlaylistScreenView & PlaylistScreenActions {
  const dispatch = useAppDispatch();
  const screen = useAppSelector(selectScreen);
  const playingContext = useAppSelector(selectPlayingContext);
  const editingPlaylistFile = useAppSelector((s) => s.navigation.editingPlaylistFile);
  const addToPlaylistTrack = useAppSelector((s) => s.navigation.addToPlaylistTrack);
  const isFindingUnplaylisted = useAppSelector((s) => s.navigation.isFindingUnplaylisted);

  const actions = useMemo<PlaylistScreenActions>(
    () => ({
      openLibrary: () => dispatch(libraryScreenOpened()),
      openPlaylist: ({ root, playlist, tracksById }, callbacks) => dispatch(openPlaylist(toPlaylistContext(root, playlist, tracksById), callbacks)),
      markOpenPlaylistPlaying: () => dispatch(playingContextSetFromScreen()),
      setEditingPlaylistFile: (target) => dispatch(editingPlaylistFileSet(target)),
      setAddToPlaylistTrack: (track) => dispatch(addToPlaylistTrackSet(track)),
      showNowPlaying: (callbacks) => dispatch(showNowPlaying(callbacks)),
      showUnplaylisted: (rootId, callbacks) => dispatch(showUnplaylisted(rootId, callbacks)),
      moveTracks: (moving, anchor, position, rescan) => dispatch(moveOpenPlaylistTracks(moving, anchor, position, { rescan })),
      removeTracks: (fileIds, rescan) => dispatch(removeOpenPlaylistTracks(fileIds, { rescan })),
      addPendingTrackToPlaylist: (playlist, position, rescan) => dispatch(addPendingTrackToPlaylist(playlist, position, { rescan })),
    }),
    [dispatch],
  );

  return useMemo(
    () => ({ screen, playingContext, editingPlaylistFile, addToPlaylistTrack, isFindingUnplaylisted, ...actions }),
    [screen, playingContext, editingPlaylistFile, addToPlaylistTrack, isFindingUnplaylisted, actions],
  );
}
