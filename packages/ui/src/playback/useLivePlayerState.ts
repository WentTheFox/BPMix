import type { PlaylistPlayerState } from '@bpmix/core';
import { useSyncExternalStore } from 'react';
import { useLivePlayback } from './LivePlaybackContext';

/**
 * The player's full live state (position, crossfade progress and all), which
 * updates on the playback ticker (~5Hz, only while something is active) and
 * after transport actions - see LivePlayback.
 *
 * Re-renders its caller on every update, so call it ONLY in small leaf
 * components that actually draw those values (see useFastDisplay and the
 * Live* wrappers). Anything else should read the store's coarse `playback`
 * slice with a narrow selector, which only changes on meaningful events
 * (current track, play/pause, modes).
 */
export function useLivePlayerState(): PlaylistPlayerState {
  const live = useLivePlayback();
  return useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
}
