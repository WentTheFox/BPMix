import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { GrantedRoot } from '../../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../../library-store/types';

/** The folder a new playlist will be created from, once the folder browser has picked one. */
export interface CreatePlaylistTarget {
  rootId: string;
  folderRelativePath: string;
  folderDisplayName: string;
}

/**
 * A playlist as opened on screen (or playing): a serializable snapshot, not
 * ids to look up. The playlist can be virtual (Unplaylisted, Now Playing),
 * and Unplaylisted's tracks include freshly-discovered ones the library slice
 * doesn't have yet, so the snapshot carries its own tracks.
 */
export interface PlaylistContext {
  root: GrantedRoot;
  playlist: PlaylistRecord;
  tracks: TrackRecord[];
}

export type ScreenState = { kind: 'library' } | ({ kind: 'playlist' } & PlaylistContext);

/** What the UI reads: the same snapshot with `tracksById` rebuilt as the Map TrackList looks tracks up in (see selectScreen). */
export type OpenScreen = { kind: 'library' } | { kind: 'playlist'; root: GrantedRoot; playlist: PlaylistRecord; tracksById: Map<string, TrackRecord> };
export interface PlayingContext {
  root: GrantedRoot;
  playlist: PlaylistRecord;
  tracksById: Map<string, TrackRecord>;
}

/** Snapshot form of a playlist's tracks, from the Map the loaders return. */
export function toPlaylistContext(root: GrantedRoot, playlist: PlaylistRecord, tracksById: Map<string, TrackRecord>): PlaylistContext {
  return { root, playlist, tracks: [...tracksById.values()] };
}

/**
 * Navigation: which screen is open, overlay/modal visibility, the multi-step
 * create-playlist flow, and which playlist is actually playing.
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
  /** Whichever screen is currently OPEN. */
  screen: ScreenState;
  /**
   * Which real playlist is actually playing (not necessarily `screen`: the
   * user may have navigated back to Library while a track keeps playing).
   * Set when a track starts from an open playlist, and restored from
   * PlaybackState on launch - a freshly-resumed session with no tap yet still
   * needs it for the "Now Playing" automatic row and for shuffle to switch to
   * it. Null only before that restore has resolved.
   */
  playingContext: PlaylistContext | null;
  /** The "Edit raw" overlay's target - only ever a real, file-backed playlist. */
  editingPlaylistFile: { root: GrantedRoot; playlist: PlaylistRecord } | null;
  /** The track an "add to playlist" tap on an Unplaylisted row is offering to add. */
  addToPlaylistTrack: TrackRecord | null;
  /** True while the Unplaylisted directory walk for the open screen is in flight. */
  isFindingUnplaylisted: boolean;
  /** Bumped per Unplaylisted request so a stale walk's result can't land after the user navigated on. */
  unplaylistedRequestId: number;
}

export const initialNavigationState: NavigationState = {
  settingsOpen: false,
  externalConnectionsOpen: false,
  nowPlayingOpen: false,
  lyricsEditorOpen: false,
  lyricsPickerOpen: false,
  createPlaylistRootId: null,
  createPlaylistTarget: null,
  screen: { kind: 'library' },
  playingContext: null,
  editingPlaylistFile: null,
  addToPlaylistTrack: null,
  isFindingUnplaylisted: false,
  unplaylistedRequestId: 0,
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
    libraryScreenOpened(state) {
      state.screen = { kind: 'library' };
    },
    playlistScreenOpened(state, action: PayloadAction<PlaylistContext>) {
      state.screen = { kind: 'playlist', ...action.payload };
    },
    /** The Unplaylisted walk finished: fills in the open screen, if it's still that playlist. */
    unplaylistedLoaded(state, action: PayloadAction<{ playlist: PlaylistRecord; tracks: TrackRecord[] }>) {
      const { screen } = state;
      if (screen.kind !== 'playlist' || screen.playlist.id !== action.payload.playlist.id) return;
      screen.playlist = action.payload.playlist;
      screen.tracks = action.payload.tracks;
    },
    /** Reorders the open playlist immediately rather than waiting on the rescan, so the screen doesn't look unchanged until reopened (the .m3u8 itself is already correct). A no-op if the anchor is gone or another playlist is open. */
    openPlaylistTracksMoved(
      state,
      action: PayloadAction<{ playlistId: string; movingFileIds: string[]; anchorFileId: string; position: 'before' | 'after' }>,
    ) {
      const { screen } = state;
      const { playlistId, movingFileIds, anchorFileId, position } = action.payload;
      if (screen.kind !== 'playlist' || screen.playlist.id !== playlistId) return;
      const moving = new Set(movingFileIds);
      const remaining = screen.playlist.trackFileIds.filter((id) => !moving.has(id));
      const anchorIndex = remaining.indexOf(anchorFileId);
      if (anchorIndex === -1) return;
      const insertAt = position === 'before' ? anchorIndex : anchorIndex + 1;
      screen.playlist.trackFileIds = [...remaining.slice(0, insertAt), ...movingFileIds, ...remaining.slice(insertAt)];
    },
    /** Drops tracks from the open playlist immediately (a removal, or a just-added track leaving the Unplaylisted view) rather than waiting on the rescan. */
    openPlaylistTracksRemoved(state, action: PayloadAction<{ playlistId: string; fileIds: string[] }>) {
      const { screen } = state;
      if (screen.kind !== 'playlist' || screen.playlist.id !== action.payload.playlistId) return;
      const removing = new Set(action.payload.fileIds);
      screen.playlist.trackFileIds = screen.playlist.trackFileIds.filter((id) => !removing.has(id));
    },
    /** A track started playing from the open playlist: that playlist is now the playing one. */
    playingContextSetFromScreen(state) {
      const { screen } = state;
      if (screen.kind !== 'playlist') return;
      state.playingContext = { root: screen.root, playlist: screen.playlist, tracks: screen.tracks };
    },
    playingContextSet(state, action: PayloadAction<PlaylistContext | null>) {
      state.playingContext = action.payload;
    },
    /** A rescan re-read the playing playlist: keep the playing context (what the player resolves tracks through) in step with it. A no-op if something else is playing. */
    playingContextRefreshed(state, action: PayloadAction<{ playlist: PlaylistRecord; tracks: TrackRecord[] }>) {
      if (!state.playingContext || state.playingContext.playlist.id !== action.payload.playlist.id) return;
      state.playingContext.playlist = action.payload.playlist;
      state.playingContext.tracks = action.payload.tracks;
    },
    /** Startup restore resolved: reopen the last open playlist (and Now Playing, if it was open) and record what's playing. */
    playbackRestored(state, action: PayloadAction<{ opened: PlaylistContext | null; nowPlayingOpen: boolean; playing: PlaylistContext }>) {
      if (action.payload.opened) state.screen = { kind: 'playlist', ...action.payload.opened };
      if (action.payload.nowPlayingOpen) state.nowPlayingOpen = true;
      state.playingContext = action.payload.playing;
    },
    editingPlaylistFileSet(state, action: PayloadAction<{ root: GrantedRoot; playlist: PlaylistRecord } | null>) {
      state.editingPlaylistFile = action.payload;
    },
    addToPlaylistTrackSet(state, action: PayloadAction<TrackRecord | null>) {
      state.addToPlaylistTrack = action.payload;
    },
    /** Starts an Unplaylisted request: bumps the guard id and shows "Finding…". */
    unplaylistedRequested(state) {
      state.unplaylistedRequestId += 1;
      state.isFindingUnplaylisted = true;
    },
    /** Clears "Finding…" only if this is still the latest request. */
    unplaylistedSettled(state, action: PayloadAction<number>) {
      if (state.unplaylistedRequestId === action.payload) state.isFindingUnplaylisted = false;
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
  libraryScreenOpened,
  playlistScreenOpened,
  unplaylistedLoaded,
  openPlaylistTracksMoved,
  openPlaylistTracksRemoved,
  playingContextSetFromScreen,
  playingContextSet,
  playingContextRefreshed,
  playbackRestored,
  editingPlaylistFileSet,
  addToPlaylistTrackSet,
  unplaylistedRequested,
  unplaylistedSettled,
} = navigationSlice.actions;

const toTracksById = (tracks: TrackRecord[]) => new Map(tracks.map((t) => [t.fileId, t]));

/** The open screen with `tracksById` rebuilt as a Map. Memoized on the stored snapshot, so its identity only changes when the screen does (TrackList and useOpenPlaylistMetadataScan depend on that). */
export const selectScreen = createSelector(
  [(state: { navigation: NavigationState }) => state.navigation.screen],
  (screen): OpenScreen =>
    screen.kind === 'library' ? screen : { kind: 'playlist', root: screen.root, playlist: screen.playlist, tracksById: toTracksById(screen.tracks) },
);

export const selectPlayingContext = createSelector(
  [(state: { navigation: NavigationState }) => state.navigation.playingContext],
  (context): PlayingContext | null => (context ? { root: context.root, playlist: context.playlist, tracksById: toTracksById(context.tracks) } : null),
);
