import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

/**
 * The fixed, ordered phases RestoringScreen shows - defined once so the
 * wording/order can't drift between apps. Deliberately coarse (one row per
 * phase, not per root/lyrics scope scanned within it).
 */
export type RestoringStepKey = 'listingFolders' | 'scanningLibrary' | 'scanningLyrics' | 'restoringPlayback' | 'loadingPlaylist';

export const RESTORING_STEPS: ReadonlyArray<{ key: RestoringStepKey; label: string }> = [
  { key: 'listingFolders', label: 'Listing folders' },
  { key: 'scanningLibrary', label: 'Scanning library' },
  { key: 'scanningLyrics', label: 'Scanning lyrics' },
  { key: 'restoringPlayback', label: 'Restoring playback' },
  { key: 'loadingPlaylist', label: 'Loading playlist' },
];

export interface RestoreState {
  /** True for the whole startup restore window, so the UI can hold off rendering its normal screens until the right one is known (otherwise Library flashes before a restored playlist). */
  isRestoring: boolean;
  currentStep: RestoringStepKey | null;
  completedSteps: RestoringStepKey[];
  /** Whether at least one lyrics scope is configured - RestoringScreen only shows "Scanning lyrics" when true, so a user with no lyrics folders doesn't see a row that can never complete. */
  hasLyricsScopes: boolean;
  /**
   * The user did something that starts/changes playback. The startup restore
   * is a slow chain that can still be in flight seconds after the screen is
   * interactive; once this is set it must not apply itself, or a user who
   * taps a track early watches their choice get overwritten with last
   * session's position/track (confirmed on-device on an 858-track library).
   * Read synchronously by the restore thunk via getState().
   */
  userTookOver: boolean;
}

const initialState: RestoreState = { isRestoring: true, currentStep: null, completedSteps: [], hasLyricsScopes: false, userTookOver: false };

export const restoreSlice = createSlice({
  name: 'restore',
  initialState,
  reducers: {
    /** Marks the previously-current step (if any) complete and makes `step` the current one. */
    restoreStepAdvanced(state, action: PayloadAction<RestoringStepKey>) {
      if (state.currentStep && !state.completedSteps.includes(state.currentStep)) state.completedSteps.push(state.currentStep);
      state.currentStep = action.payload;
    },
    lyricsScopesKnown(state, action: PayloadAction<boolean>) {
      state.hasLyricsScopes = action.payload;
    },
    restoreFinished(state) {
      state.isRestoring = false;
    },
    userTookOver(state) {
      state.userTookOver = true;
    },
  },
});

export const { restoreStepAdvanced, lyricsScopesKnown, restoreFinished, userTookOver } = restoreSlice.actions;

export const selectCompletedSteps = createSelector(
  [(state: { restore: RestoreState }) => state.restore.completedSteps],
  (steps): ReadonlySet<RestoringStepKey> => new Set(steps),
);
