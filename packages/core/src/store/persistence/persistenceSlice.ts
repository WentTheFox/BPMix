import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { PlaybackState } from '../../library-store/types';

export interface PersistenceState {
  /** The last known persisted playback state - what every patch merges onto, so no call site needs an async read first. */
  state: PlaybackState;
  /**
   * False until the startup restore has read what's actually persisted. Until
   * then `state` is only a placeholder default, and a patch merged onto it
   * would be written back over the real saved state (seen on-device: a dev
   * Fast Refresh remount let the position tick race ahead of the initial
   * read and silently reverted nowPlayingOpen).
   */
  ready: boolean;
  /** When the playing position was last persisted (see persistPositionIfDue), 0 = never. */
  lastPositionPersistAt: number;
}

export const DEFAULT_PLAYBACK_STATE: PlaybackState = {
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
};

const initialState: PersistenceState = { state: DEFAULT_PLAYBACK_STATE, ready: false, lastPositionPersistAt: 0 };

export const persistenceSlice = createSlice({
  name: 'persistence',
  initialState,
  reducers: {
    /** The persisted state was read (null = nothing ever saved): from here on patches are applied and written back. */
    playbackStateRead(state, action: PayloadAction<PlaybackState | null>) {
      if (action.payload) state.state = action.payload;
      state.ready = true;
    },
    /**
     * Merges a change into the persisted state; the persistence listener
     * writes it. `debounceMs` delays only the write (coalescing a burst, e.g.
     * a volume slider drag) - the merged state itself updates immediately. A
     * no-op before the initial read.
     */
    playbackPatched(state, action: PayloadAction<{ patch: Partial<PlaybackState>; debounceMs?: number }>) {
      if (!state.ready) return;
      state.state = { ...state.state, ...action.payload.patch };
    },
    positionPersistStamped(state, action: PayloadAction<number>) {
      state.lastPositionPersistAt = action.payload;
    },
  },
});

export const { playbackStateRead, playbackPatched, positionPersistStamped } = persistenceSlice.actions;
