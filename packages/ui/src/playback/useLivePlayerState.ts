import type { LivePlayback, PlaylistPlayerState } from '@bpmix/core';
import { useSyncExternalStore } from 'react';

/**
 * The player's full live state (position, crossfade progress and all), which
 * updates on the playback ticker (~5Hz) and after transport actions - see
 * LivePlayback. For fields that only change on meaningful events (current
 * track, play/pause, modes), prefer a narrow selector on the store's
 * `playback` slice so the component isn't re-rendered every tick.
 */
export function useLivePlayerState(livePlayback: LivePlayback): PlaylistPlayerState {
  return useSyncExternalStore(livePlayback.subscribe, livePlayback.getSnapshot, livePlayback.getSnapshot);
}
