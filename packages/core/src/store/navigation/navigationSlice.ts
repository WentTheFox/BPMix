import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

/** The folder a new playlist will be created from, once the folder browser has picked one. */
export interface CreatePlaylistTarget {
  rootId: string;
  folderRelativePath: string;
  folderDisplayName: string;
}

/**
 * Overlay/modal visibility and the multi-step create-playlist flow. Only
 * ids and strings - the open playlist screen itself (`screen`) still lives in
 * App.tsx until the library slice owns the tracks/playlists it points at.
 *
 * Persisting `nowPlayingOpen` for restore is a playback concern and stays at
 * the call sites (persistPlaybackPatch), not in these reducers.
 */
export interface NavigationState {
  settingsOpen: boolean;
  /** The "External connections" sub-screen reached from within Settings - always closes before Settings does (see handleBackNavigation). */
  externalConnectionsOpen: boolean;
  /** Whether the Now Playing overlay is open. Meaningful as an overlay only in the narrow tier; docked tiers ignore it. */
  nowPlayingOpen: boolean;
  /** Lifted out of LyricsSection so the header menu can open them from outside Now Playing. */
  lyricsEditorOpen: boolean;
  lyricsPickerOpen: boolean;
  /** Step 1 of create-playlist: the root whose folder browser is showing. */
  createPlaylistRootId: string | null;
  /** Step 2: the chosen folder, whose CreatePlaylistScreen is showing. */
  createPlaylistTarget: CreatePlaylistTarget | null;
}

export const initialNavigationState: NavigationState = {
  settingsOpen: false,
  externalConnectionsOpen: false,
  nowPlayingOpen: false,
  lyricsEditorOpen: false,
  lyricsPickerOpen: false,
  createPlaylistRootId: null,
  createPlaylistTarget: null,
};

export const navigationSlice = createSlice({
  name: 'navigation',
  initialState: initialNavigationState,
  reducers: {
    settingsOpened(state) {
      state.settingsOpen = true;
    },
    /** Closing Settings also closes its External connections sub-screen, so a child can never outlive its parent. */
    settingsClosed(state) {
      state.settingsOpen = false;
      state.externalConnectionsOpen = false;
    },
    externalConnectionsOpened(state) {
      state.externalConnectionsOpen = true;
    },
    externalConnectionsClosed(state) {
      state.externalConnectionsOpen = false;
    },
    nowPlayingOpenChanged(state, action: PayloadAction<boolean>) {
      state.nowPlayingOpen = action.payload;
    },
    lyricsEditorOpenChanged(state, action: PayloadAction<boolean>) {
      state.lyricsEditorOpen = action.payload;
    },
    lyricsPickerOpenChanged(state, action: PayloadAction<boolean>) {
      state.lyricsPickerOpen = action.payload;
    },
    /** From the header lyrics menu: the editor lives inside Now Playing, so open that too. */
    lyricsEditorOpenedFromMenu(state) {
      state.lyricsEditorOpen = true;
      state.nowPlayingOpen = true;
    },
    lyricsPickerOpenedFromMenu(state) {
      state.lyricsPickerOpen = true;
      state.nowPlayingOpen = true;
    },
    createPlaylistStarted(state, action: PayloadAction<string>) {
      state.createPlaylistRootId = action.payload;
    },
    /** The folder browser's pick: moves from step 1 to step 2. */
    createPlaylistFolderChosen(state, action: PayloadAction<CreatePlaylistTarget>) {
      state.createPlaylistRootId = null;
      state.createPlaylistTarget = action.payload;
    },
    /** Cancelling or finishing at either step ends the whole flow. */
    createPlaylistEnded(state) {
      state.createPlaylistRootId = null;
      state.createPlaylistTarget = null;
    },
  },
});

export const {
  settingsOpened,
  settingsClosed,
  externalConnectionsOpened,
  externalConnectionsClosed,
  nowPlayingOpenChanged,
  lyricsEditorOpenChanged,
  lyricsPickerOpenChanged,
  lyricsEditorOpenedFromMenu,
  lyricsPickerOpenedFromMenu,
  createPlaylistStarted,
  createPlaylistFolderChosen,
  createPlaylistEnded,
} = navigationSlice.actions;
