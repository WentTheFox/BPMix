import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { GrantedRoot } from '../../file-access/types';
import type { LyricsScope } from '../../library-store/types';
import type { LibraryRootData, RootWithLibrary } from './types';

export interface LibraryState {
  /** Every granted root, including lyrics-only ones. */
  grantedRoots: GrantedRoot[];
  /** Scanned data for the 'library'-kind roots only. */
  roots: LibraryRootData[];
  /**
   * True until the first refresh resolves `roots` at least once. refresh is
   * fire-and-forget from the startup restore (which must not wait on
   * scanning every root - see CLAUDE.md), so RestoringScreen dismisses well
   * before this finishes, and LibraryScreen needs it to show a loading state
   * rather than a misleading empty one.
   */
  isLoadingRoots: boolean;
  /** Tracks whose file failed to open this session (kept as an array - state can't hold a Set). */
  missingFileIds: string[];
  lyricsScopes: LyricsScope[];
  /** Null until known. Seeded from last launch's final count, then ticked live (see refreshLibrary). */
  matchedLyricsCount: number | null;
  /** The direct-action error banner (addFolder, rescan, etc.); one-off playback errors go to notifications instead. */
  error: string | null;
  /** Once-per-launch guard for pruneOrphanedRootData: cheap insurance, not worth a full scan on every manual refresh. */
  orphanPruneStarted: boolean;
}

const initialState: LibraryState = {
  grantedRoots: [],
  roots: [],
  isLoadingRoots: true,
  missingFileIds: [],
  lyricsScopes: [],
  matchedLyricsCount: null,
  error: null,
  orphanPruneStarted: false,
};

export const librarySlice = createSlice({
  name: 'library',
  initialState,
  reducers: {
    grantedRootsLoaded(state, action: PayloadAction<GrantedRoot[]>) {
      state.grantedRoots = action.payload;
    },
    libraryLoaded(state, action: PayloadAction<LibraryRootData[]>) {
      state.roots = action.payload;
      state.isLoadingRoots = false;
    },
    /** listGrantedRoots failed - otherwise isLoadingRoots would stay true forever. */
    rootsLoadFailed(state) {
      state.isLoadingRoots = false;
    },
    orphanPruneStarted(state) {
      state.orphanPruneStarted = true;
    },
    lyricsScopesLoaded(state, action: PayloadAction<LyricsScope[]>) {
      state.lyricsScopes = action.payload;
    },
    matchedLyricsCountSet(state, action: PayloadAction<number | null>) {
      state.matchedLyricsCount = action.payload;
    },
    /** The match pass found a track without a match: tick the optimistic count down (never below 0). */
    matchedLyricsCountDecremented(state) {
      if (state.matchedLyricsCount != null) state.matchedLyricsCount = Math.max(0, state.matchedLyricsCount - 1);
    },
    libraryErrorSet(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    fileMissingReported(state, action: PayloadAction<string>) {
      if (!state.missingFileIds.includes(action.payload)) state.missingFileIds.push(action.payload);
    },
    fileFoundReported(state, action: PayloadAction<string>) {
      state.missingFileIds = state.missingFileIds.filter((id) => id !== action.payload);
    },
  },
});

export const {
  grantedRootsLoaded,
  libraryLoaded,
  rootsLoadFailed,
  orphanPruneStarted,
  lyricsScopesLoaded,
  matchedLyricsCountSet,
  matchedLyricsCountDecremented,
  libraryErrorSet,
  fileMissingReported,
  fileFoundReported,
} = librarySlice.actions;

/** Rebuilds the per-root `tracksById` Maps the UI looks tracks up in. Memoized on the stored data, so identities only change when a refresh actually replaces it. */
export const selectRootsWithLibrary = createSelector(
  [(state: { library: LibraryState }) => state.library.roots],
  (roots): RootWithLibrary[] =>
    roots.map(({ root, playlists, tracks }) => ({ root, playlists, tracksById: new Map(tracks.map((t) => [t.fileId, t])) })),
);

export const selectMissingFileIds = createSelector(
  [(state: { library: LibraryState }) => state.library.missingFileIds],
  (ids): ReadonlySet<string> => new Set(ids),
);
