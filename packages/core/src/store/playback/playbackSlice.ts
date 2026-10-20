import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { LoopMode } from '../../library-store/types';
import type { PlaylistPlayerState } from '../../playback/playlistPlayer';
import type { TrackPlayerState } from '../../playback/trackPlayer';

/**
 * The slow-moving part of the player's state: changes on track changes,
 * play/pause, mode toggles and crossfades starting/ending - never per tick.
 * Position and crossfade progress stay in LivePlayback.
 */
export interface CoarsePlayback {
  currentFileId: string | null;
  status: TrackPlayerState['status'];
  isAudible: boolean;
  /** Index into playback order (post-shuffle); -1 if nothing is loaded. */
  position: number;
  totalTracks: number;
  /** Length of the current track, so the seek bar's range is known without reading the live position. */
  durationSeconds: number;
  loopMode: LoopMode;
  shuffleEnabled: boolean;
  isLoadingForPlayback: boolean;
  pendingCrossfadeFileIds: { outgoing: string; incoming: string } | null;
}

export interface PlaybackSliceState {
  coarse: CoarsePlayback;
  /**
   * Distinguishes "merely restored on launch" from "actually played this
   * session": gating the OS/browser media session on currentFileId alone would
   * surface media controls (and a playbackState) on every page load, since the
   * restore path decodes the last track silently without autoplaying it.
   */
  hasStartedPlayback: boolean;
}

export const toCoarsePlayback = (state: PlaylistPlayerState): CoarsePlayback => ({
  currentFileId: state.currentFileId,
  status: state.track.status,
  isAudible: state.track.isAudible,
  position: state.position,
  totalTracks: state.totalTracks,
  durationSeconds: state.track.durationSeconds,
  loopMode: state.loopMode,
  shuffleEnabled: state.shuffleEnabled,
  isLoadingForPlayback: state.isLoadingForPlayback,
  pendingCrossfadeFileIds: state.pendingCrossfadeFileIds,
});

export function coarsePlaybackEqual(a: CoarsePlayback, b: CoarsePlayback): boolean {
  return (
    a.currentFileId === b.currentFileId &&
    a.status === b.status &&
    a.isAudible === b.isAudible &&
    a.position === b.position &&
    a.totalTracks === b.totalTracks &&
    a.durationSeconds === b.durationSeconds &&
    a.loopMode === b.loopMode &&
    a.shuffleEnabled === b.shuffleEnabled &&
    a.isLoadingForPlayback === b.isLoadingForPlayback &&
    a.pendingCrossfadeFileIds?.outgoing === b.pendingCrossfadeFileIds?.outgoing &&
    a.pendingCrossfadeFileIds?.incoming === b.pendingCrossfadeFileIds?.incoming
  );
}

const initialState: PlaybackSliceState = {
  coarse: {
    currentFileId: null,
    status: 'idle',
    isAudible: false,
    position: -1,
    totalTracks: 0,
    durationSeconds: 0,
    loopMode: 'off',
    shuffleEnabled: false,
    isLoadingForPlayback: false,
    pendingCrossfadeFileIds: null,
  },
  hasStartedPlayback: false,
};

export const playbackSlice = createSlice({
  name: 'playback',
  initialState,
  reducers: {
    /** The player's coarse state changed. Dispatched by the mirror in createStore only when it differs from what's here. */
    playbackSynced(state, action: PayloadAction<CoarsePlayback>) {
      state.coarse = action.payload;
      if (action.payload.status === 'playing') state.hasStartedPlayback = true;
    },
  },
});

export const { playbackSynced } = playbackSlice.actions;
