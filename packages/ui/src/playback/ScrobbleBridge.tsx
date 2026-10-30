import type { LibraryStore, ScrobbleSink, ScrobbleTrackInfo } from '@bpmix/core';
import { useLastFmScrobbling } from '../scrobble/useLastFmScrobbling';
import { useFastDisplay } from './useFastDisplay';

export interface ScrobbleBridgeProps {
  libraryStore: LibraryStore;
  /** Where scrobbles go (see ScrobbleSink); null while nothing is connected. */
  sink: ScrobbleSink | null;
  /** See useLastFmScrobbling's queueKeyWhenDisconnected. */
  queueKeyWhenDisconnected?: string;
  /** Null when nothing has actually played this session. `durationSeconds` is filled in here from the live state. */
  info: Omit<ScrobbleTrackInfo, 'durationSeconds'> | null;
  isPlaying: boolean;
  crossfadeSeconds: number;
}

/**
 * Feeds the Last.fm scrobbler the live position. Headless: it exists so the
 * per-tick position subscription re-renders only this (renderless) component,
 * not the app root that owns the rest of the scrobbling inputs.
 */
export function ScrobbleBridge({ libraryStore, sink, queueKeyWhenDisconnected, info, isPlaying, crossfadeSeconds }: ScrobbleBridgeProps) {
  const { displayPositionSeconds, displayDurationSeconds } = useFastDisplay(crossfadeSeconds);
  useLastFmScrobbling(libraryStore, sink, info ? { ...info, durationSeconds: displayDurationSeconds } : null, isPlaying, displayPositionSeconds, queueKeyWhenDisconnected);
  return null;
}
