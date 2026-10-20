import {
  createPlaylistEnded,
  createPlaylistFolderChosen,
  createPlaylistStarted,
  externalConnectionsClosed,
  externalConnectionsOpened,
  lyricsEditorOpenChanged,
  lyricsEditorOpenedFromMenu,
  lyricsPickerOpenChanged,
  lyricsPickerOpenedFromMenu,
  nowPlayingOpenChanged,
  settingsClosed,
  settingsOpened,
} from '@bpmix/core';
import type { CreatePlaylistTarget, NavigationState } from '@bpmix/core';
import { useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';

export interface NavigationActions {
  openSettings: () => void;
  closeSettings: () => void;
  openExternalConnections: () => void;
  closeExternalConnections: () => void;
  setNowPlayingOpen: (open: boolean) => void;
  setLyricsEditorOpen: (open: boolean) => void;
  setLyricsPickerOpen: (open: boolean) => void;
  openLyricsEditorFromMenu: () => void;
  openLyricsPickerFromMenu: () => void;
  startCreatePlaylist: (rootId: string) => void;
  chooseCreatePlaylistFolder: (target: CreatePlaylistTarget) => void;
  endCreatePlaylist: () => void;
}

/**
 * The store's `navigation` slice (overlay visibility + the create-playlist
 * flow) as state plus stable action dispatchers, shared by both apps. The
 * actions never change identity, so they're safe in effect deps.
 */
export function useNavigation(): NavigationState & NavigationActions {
  const dispatch = useAppDispatch();
  const state = useAppSelector((s) => s.navigation);
  const actions = useMemo<NavigationActions>(
    () => ({
      openSettings: () => dispatch(settingsOpened()),
      closeSettings: () => dispatch(settingsClosed()),
      openExternalConnections: () => dispatch(externalConnectionsOpened()),
      closeExternalConnections: () => dispatch(externalConnectionsClosed()),
      setNowPlayingOpen: (open) => dispatch(nowPlayingOpenChanged(open)),
      setLyricsEditorOpen: (open) => dispatch(lyricsEditorOpenChanged(open)),
      setLyricsPickerOpen: (open) => dispatch(lyricsPickerOpenChanged(open)),
      openLyricsEditorFromMenu: () => dispatch(lyricsEditorOpenedFromMenu()),
      openLyricsPickerFromMenu: () => dispatch(lyricsPickerOpenedFromMenu()),
      startCreatePlaylist: (rootId) => dispatch(createPlaylistStarted(rootId)),
      chooseCreatePlaylistFolder: (target) => dispatch(createPlaylistFolderChosen(target)),
      endCreatePlaylist: () => dispatch(createPlaylistEnded()),
    }),
    [dispatch],
  );
  return useMemo(() => ({ ...state, ...actions }), [state, actions]);
}
