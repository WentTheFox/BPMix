import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import type { PlaybackState } from '../../library-store/types';
import type { PlaylistPlayerState } from '../../playback/playlistPlayer';
import type { RootState } from '../rootReducer';
import type { Services } from '../services';
import { playbackPatched, positionPersistStamped } from './persistenceSlice';

type AppThunk = ThunkAction<void, RootState, Services, UnknownAction>;

/** How often to persist positionSeconds while a track is playing - frequent enough that a crash loses little progress, infrequent enough not to hammer the store on every tick. */
export const POSITION_PERSIST_INTERVAL_MS = 5000;

/** Debounce for a rapidly-changing value (currently just volume, dragged via a slider) - long enough to coalesce a drag's burst into one write, short enough that a quick tap still saves within a beat. */
export const RAPID_PLAYBACK_PATCH_DEBOUNCE_MS = 400;

/** Persists the playing position, at most once per POSITION_PERSIST_INTERVAL_MS, and only while a track is playing or paused. Called on every ticker tick. */
export function persistPositionIfDue(playerState: PlaylistPlayerState): AppThunk {
  return (dispatch, getState, { now }) => {
    const at = now();
    const { track, currentFileId } = playerState;
    if (!currentFileId || (track.status !== 'playing' && track.status !== 'paused')) return;
    if (at - getState().persistence.lastPositionPersistAt < POSITION_PERSIST_INTERVAL_MS) return;
    dispatch(positionPersistStamped(at));
    dispatch(playbackPatched({ patch: { positionSeconds: track.positionSeconds } }));
  };
}

/**
 * The player moved on without a manual action (a crossfade completed, or a
 * track ended naturally) - refresh the live state right away rather than
 * waiting up to one tick for the "now playing" display to notice, and
 * persist where it landed. Also re-persists shuffleOrder, which
 * maybeReshuffleForLoopContinuation can silently regenerate mid-playback
 * (loop='all' wrapping past the last track).
 */
export function playerAdvanced(): AppThunk {
  return (dispatch, _getState, { livePlayback, playlistPlayer }) => {
    const state = livePlayback.publish();
    if (!state.currentFileId) return;
    const patch: Partial<PlaybackState> = {
      currentTrackFileId: state.currentFileId,
      positionSeconds: state.track.positionSeconds,
      shuffleOrder: playlistPlayer.getShuffleOrder(),
    };
    dispatch(playbackPatched({ patch }));
  };
}
